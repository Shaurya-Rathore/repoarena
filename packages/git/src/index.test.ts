import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitRepository, normalizeGitHubRemote } from "./index.js";

const directories: string[] = [];
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
		},
	});
}
async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "repoarena-git-"));
	directories.push(directory);
	git(directory, "init", "-b", "main");
	git(directory, "config", "user.email", "fixture@example.test");
	git(directory, "config", "user.name", "Fixture");
	await writeFile(join(directory, "a\tb\n.txt"), "one\n");
	git(directory, "add", ".");
	git(directory, "commit", "-m", "initial");
	await writeFile(join(directory, "a\tb\n.txt"), "two\n");
	git(directory, "commit", "-am", "fix parser crash");
	return directory;
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) =>
				import("node:fs/promises").then(({ rm }) =>
					rm(directory, { recursive: true, force: true }),
				),
			),
	);
});
describe("GitRepository", () => {
	it("reads deterministic history and NUL-safe changed paths", async () => {
		const root = await fixture();
		const repository = new GitRepository(root);
		const commits = await repository.listCommits({ maxCount: 5 });
		expect(commits.map((commit) => commit.subject)).toEqual([
			"fix parser crash",
			"initial",
		]);
		const changed = await repository.getChangedFiles(
			commits[1]?.sha ?? "",
			commits[0]?.sha ?? "",
		);
		expect(changed[0]?.path).toBe("a\tb\n.txt");
		expect(await repository.isWorktreeClean()).toBe(true);
	});
	it("normalizes GitHub SSH and HTTPS remotes", () => {
		expect(normalizeGitHubRemote("git@github.com:OpenAI/Repo.git")).toBe(
			"github.com/openai/repo",
		);
		expect(normalizeGitHubRemote("https://github.com/OpenAI/Repo.git")).toBe(
			"github.com/openai/repo",
		);
		expect(normalizeGitHubRemote("https://example.test/a/b")).toBeNull();
	});
});
