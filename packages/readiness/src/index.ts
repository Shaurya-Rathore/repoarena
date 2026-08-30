import { access, stat } from "node:fs/promises";
import { join } from "node:path";

export type ReadinessDimension = {
	id: string;
	score: number;
	max: number;
	evidence: string;
	remediation?: string | undefined;
};
export type ReadinessReport = {
	score: number;
	dimensions: ReadinessDimension[];
};
const exists = async (path: string) =>
	access(path)
		.then(() => true)
		.catch(() => false);
export async function assessRepository(root: string): Promise<ReadinessReport> {
	const git = await exists(join(root, ".git"));
	const config = await exists(join(root, ".repoarena", "config.yaml"));
	const tasks = await exists(join(root, ".repoarena", "tasks"));
	const packageJson = await exists(join(root, "package.json"));
	const dimensions: ReadinessDimension[] = [
		{
			id: "git",
			score: git ? 25 : 0,
			max: 25,
			evidence: git
				? "Git repository detected."
				: "No Git repository detected.",
			remediation: git ? undefined : "Run git init before benchmarking.",
		},
		{
			id: "configuration",
			score: config ? 25 : 0,
			max: 25,
			evidence: config
				? "RepoArena configuration found."
				: "No RepoArena configuration found.",
			remediation: config ? undefined : "Run repoarena init.",
		},
		{
			id: "tasks",
			score: tasks ? 25 : 0,
			max: 25,
			evidence: tasks ? "Task directory found." : "No task directory found.",
			remediation: tasks
				? undefined
				: "Create tasks with repoarena tasks new or discover.",
		},
		{
			id: "automation",
			score: packageJson ? 25 : 10,
			max: 25,
			evidence: packageJson
				? "package.json found; commands can be declared as task verification."
				: "No recognized automation manifest found.",
			remediation: packageJson
				? undefined
				: "Add reproducible verification commands.",
		},
	];
	return {
		score: dimensions.reduce((sum, item) => sum + item.score, 0),
		dimensions,
	};
}
