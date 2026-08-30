import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RepoArenaError } from "@repoarena/core";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export type GitCommit = {
	sha: string;
	parents: string[];
	subject: string;
	body: string;
	committedAt: string;
};
export type ChangedFile = {
	status: string;
	path: string;
	previousPath?: string;
};
export type GitDiff = { patch: string; changedFiles: ChangedFile[] };
export type GitRunner = (
	cwd: string,
	args: readonly string[],
) => Promise<Buffer>;

export const runGit: GitRunner = async (cwd, args) => {
	try {
		const { stdout } = await execFileAsync("git", [...args], {
			cwd,
			encoding: "buffer",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_OUTPUT_BYTES,
			env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0" },
		});
		return stdout;
	} catch (cause) {
		const error = cause as {
			stderr?: Buffer | string;
			message?: string;
			killed?: boolean;
		};
		throw new RepoArenaError(
			"REPOSITORY_NOT_FOUND",
			error.killed ? "Git command timed out." : "Git command failed.",
			{
				args: [...args],
				stderr: Buffer.isBuffer(error.stderr)
					? error.stderr.toString("utf8", 0, 4096)
					: error.stderr,
				cause: error.message,
			},
		);
	}
};

export class GitRepository {
	public constructor(
		public readonly root: string,
		private readonly runner: GitRunner = runGit,
	) {}
	private async output(args: readonly string[]): Promise<string> {
		return (await this.runner(this.root, args)).toString("utf8");
	}
	public async getHeadSha(): Promise<string> {
		return (await this.output(["rev-parse", "HEAD"])).trim();
	}
	public async resolveRevision(revision: string): Promise<string> {
		return (
			await this.output(["rev-parse", "--verify", `${revision}^{commit}`])
		).trim();
	}
	public async isWorktreeClean(): Promise<boolean> {
		return (
			(await this.runner(this.root, ["status", "--porcelain=v2", "-z"]))
				.byteLength === 0
		);
	}
	public async getDefaultBranch(): Promise<string | null> {
		try {
			return (
				await this.output([
					"symbolic-ref",
					"--short",
					"refs/remotes/origin/HEAD",
				])
			)
				.trim()
				.replace(/^origin\//, "");
		} catch {
			return null;
		}
	}
	public async getCommit(sha: string): Promise<GitCommit> {
		const raw = await this.output([
			"show",
			"-s",
			"--format=%H%x00%P%x00%s%x00%b%x00%cI",
			sha,
		]);
		const [
			actualSha = "",
			rawParents = "",
			subject = "",
			body = "",
			committedAt = "",
		] = raw.split("\0");
		return {
			sha: actualSha.trim(),
			parents: rawParents ? rawParents.split(" ") : [],
			subject,
			body,
			committedAt,
		};
	}
	public async getCommitParents(sha: string): Promise<string[]> {
		return (await this.getCommit(sha)).parents;
	}
	public async listCommits(options: {
		maxCount: number;
		includeMerges?: boolean;
	}): Promise<GitCommit[]> {
		const args = [
			"log",
			"-z",
			`--max-count=${options.maxCount}`,
			"--format=%H%x00%P%x00%s%x00%b%x00%cI",
		];
		if (!options.includeMerges) args.push("--no-merges");
		const records = (await this.output(args)).split("\0");
		const commits: GitCommit[] = [];
		for (let index = 0; index + 4 < records.length; index += 5) {
			const sha = records[index]?.trim();
			if (!sha) continue;
			const parents = records[index + 1] ?? "";
			commits.push({
				sha,
				parents: parents ? parents.split(" ") : [],
				subject: records[index + 2] ?? "",
				body: records[index + 3] ?? "",
				committedAt: records[index + 4] ?? "",
			});
		}
		return commits;
	}
	public async getChangedFiles(
		base: string,
		head: string,
	): Promise<ChangedFile[]> {
		const tokens = (
			await this.runner(this.root, [
				"diff",
				"--name-status",
				"-z",
				"--find-renames",
				base,
				head,
			])
		)
			.toString("utf8")
			.split("\0");
		const result: ChangedFile[] = [];
		for (let index = 0; index < tokens.length - 1; ) {
			const status = tokens[index++] ?? "";
			if (!status) continue;
			if (status.startsWith("R") || status.startsWith("C")) {
				const previousPath = tokens[index++] ?? "";
				const path = tokens[index++] ?? "";
				result.push({ status, path, previousPath });
			} else {
				result.push({ status, path: tokens[index++] ?? "" });
			}
		}
		return result;
	}
	public async getDiff(base: string, head: string): Promise<GitDiff> {
		return {
			patch: await this.output([
				"diff",
				"--binary",
				"--no-ext-diff",
				base,
				head,
			]),
			changedFiles: await this.getChangedFiles(base, head),
		};
	}
	public async readFileAtCommit(sha: string, path: string): Promise<Buffer> {
		return this.runner(this.root, ["show", `${sha}:${path}`]);
	}
	public async pathExistsAtCommit(sha: string, path: string): Promise<boolean> {
		try {
			await this.runner(this.root, ["cat-file", "-e", `${sha}:${path}`]);
			return true;
		} catch {
			return false;
		}
	}
	public async isAncestor(
		ancestor: string,
		descendant: string,
	): Promise<boolean> {
		try {
			await this.runner(this.root, [
				"merge-base",
				"--is-ancestor",
				ancestor,
				descendant,
			]);
			return true;
		} catch {
			return false;
		}
	}
	public async getRemoteUrl(remote = "origin"): Promise<string | null> {
		try {
			return (await this.output(["remote", "get-url", remote])).trim();
		} catch {
			return null;
		}
	}
	public async createDetachedWorktree(
		sha: string,
		destination: string,
	): Promise<void> {
		await this.runner(this.root, [
			"worktree",
			"add",
			"--detach",
			"--force",
			destination,
			sha,
		]);
	}
	public async removeWorktree(destination: string): Promise<void> {
		await this.runner(this.root, [
			"worktree",
			"remove",
			"--force",
			destination,
		]);
		await rm(destination, { recursive: true, force: true });
	}
	public async identity(): Promise<{
		root: string;
		head: string;
		remote: string | null;
	}> {
		return {
			root: this.root,
			head: await this.getHeadSha(),
			remote: await this.getRemoteUrl(),
		};
	}
}

export async function findRepositoryRoot(cwd: string): Promise<string> {
	const start = resolve(cwd);
	try {
		return (await runGit(start, ["rev-parse", "--show-toplevel"]))
			.toString("utf8")
			.trim();
	} catch {
		throw new RepoArenaError(
			"REPOSITORY_NOT_FOUND",
			`No Git repository found from ${start}.`,
		);
	}
}
export function normalizeGitHubRemote(remote: string): string | null {
	const ssh = remote.match(
		/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	const https = remote.match(
		/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	const match = ssh ?? https;
	return match ? `github.com/${match[1]}/${match[2]}`.toLowerCase() : null;
}
export async function removeWorktreeDirectory(
	destination: string,
): Promise<void> {
	await access(dirname(destination));
	await rm(destination, { recursive: true, force: true });
}
