import type {
	ChangedFile,
	GitCommit,
	GitDiff,
	GitRepository,
} from "@repoarena/git";

export type Candidate = {
	id: string;
	commit: GitCommit;
	parent: string | null;
	score: number;
	evidence: string[];
	changed_files: ChangedFile[];
	excluded?: string | undefined;
};
const testPath = (path: string) =>
	/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[^.]+$/i.test(path);
const docsPath = (path: string) =>
	/(^|\/)(docs?|readme|changelog)\//i.test(path) ||
	/^readme|changelog/i.test(path);
const generated = (path: string) =>
	/(^|\/)(dist|build|coverage|vendor|node_modules)\//i.test(path);
const dependency = (path: string) =>
	/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock)$/i.test(
		path,
	);
export function scoreCandidate(
	commit: GitCommit,
	files: ChangedFile[],
	patchBytes: number,
): Pick<Candidate, "score" | "evidence" | "excluded"> {
	const evidence: string[] = [];
	let score = 0;
	const paths = files.map((file) => file.path);
	const tests = paths.filter(testPath).length;
	const sources = paths.filter(
		(path) => !testPath(path) && !docsPath(path) && !dependency(path),
	).length;
	const text = `${commit.subject} ${commit.body}`.toLowerCase();
	if (/\b(fix|bug|regression|crash|resolve|handle|correct)\b/.test(text)) {
		score += 15;
		evidence.push("fix-like commit semantics");
	}
	if (tests) {
		score += 20;
		evidence.push("test files changed");
	}
	if (tests && sources) {
		score += 15;
		evidence.push("source and test changed");
	}
	if (sources && !tests) {
		score += 5;
		evidence.push("source behavior changed");
	}
	if (patchBytes >= 200 && patchBytes <= 300_000) {
		score += 10;
		evidence.push("manageable patch size");
	}
	if (paths.length <= 3) {
		score += 5;
		evidence.push("clear package scope");
	}
	if (paths.every(docsPath)) {
		score -= 25;
		evidence.push("documentation-only");
	}
	if (paths.every(dependency)) {
		score -= 30;
		evidence.push("dependency-only");
	}
	if (paths.length && paths.every(generated)) {
		score -= 25;
		evidence.push("generated-only");
	}
	if (patchBytes > 300_000 || paths.length > 30) {
		score -= 25;
		evidence.push("oversized change");
	}
	if (/^revert\b/i.test(commit.subject)) {
		score -= 25;
		evidence.push("revert commit");
	}
	const excluded = score < 0 ? evidence.at(-1) : undefined;
	return { score, evidence, excluded };
}
export async function discover(
	repository: GitRepository,
	options: {
		limit: number;
		historyDepth?: number;
		includeMerges?: boolean;
		minimumScore?: number;
	},
): Promise<Candidate[]> {
	const commits = await repository.listCommits(
		options.includeMerges === undefined
			? { maxCount: options.historyDepth ?? 2000 }
			: {
					maxCount: options.historyDepth ?? 2000,
					includeMerges: options.includeMerges,
				},
	);
	const results: Candidate[] = [];
	for (const commit of commits) {
		const parent = commit.parents[0] ?? null;
		if (!parent || (!options.includeMerges && commit.parents.length !== 1))
			continue;
		let diff: GitDiff;
		try {
			diff = await repository.getDiff(parent, commit.sha);
		} catch {
			continue;
		}
		const ranked = scoreCandidate(
			commit,
			diff.changedFiles,
			Buffer.byteLength(diff.patch),
		);
		if (ranked.excluded || ranked.score < (options.minimumScore ?? 10))
			continue;
		results.push({
			id: commit.sha,
			commit,
			parent,
			changed_files: diff.changedFiles,
			...ranked,
		});
	}
	return results
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.commit.committedAt.localeCompare(a.commit.committedAt) ||
				a.commit.sha.localeCompare(b.commit.sha),
		)
		.slice(0, options.limit);
}
