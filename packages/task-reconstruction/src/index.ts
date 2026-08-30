import type { GitRepository } from "@repoarena/git";
import { analyzeLeakage } from "@repoarena/leakage";
import {
	createEvaluatorPrivateData,
	taskSchema,
	type EvaluatorPrivateTaskData,
	type Task,
} from "@repoarena/task-spec";
export interface ReconstructionEnhancer {
	enhance(input: { problem: string; changedTests: string[] }): Promise<{
		problem_statement: string;
	} | null>;
}
export type Reconstruction = {
	task: Task;
	privateData: EvaluatorPrivateTaskData;
	leakageSafe: boolean;
	diagnostics: string[];
};
const slug = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 72) || "historical-task";
export async function reconstructHistoricalTask(
	repository: GitRepository,
	fixSha: string,
	options: {
		now?: string;
		enhancer?: ReconstructionEnhancer;
		verification?: [string, ...string[]];
	} = {},
): Promise<Reconstruction> {
	const fix = await repository.getCommit(fixSha);
	const base = fix.parents[0];
	if (!base || fix.parents.length !== 1)
		throw new Error(
			"Historical reconstruction requires a single-parent fix commit.",
		);
	const diff = await repository.getDiff(base, fixSha);
	const tests = diff.changedFiles
		.filter((file) => /(test|spec)\./i.test(file.path))
		.map((file) => file.path);
	const summary =
		fix.subject.replace(/^\s*(fix|bug|resolve|handle)\s*:?\s*/i, "").trim() ||
		"Correct the observed behavior without regressions.";
	const enhanced = options.enhancer
		? await options.enhancer.enhance({ problem: summary, changedTests: tests })
		: null;
	const now = options.now ?? new Date().toISOString();
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: slug(fix.subject),
		title: summary,
		source: {
			type: "historical",
			base_commit: base,
			discovery: {
				algorithm: "historical-reconstruction/v1",
				candidate_id: fixSha,
				score: null,
				evidence: tests.length
					? ["changed regression tests"]
					: ["commit metadata"],
			},
		},
		prompt: enhanced?.problem_statement ?? summary,
		verification: {
			required: [
				{
					id: "project-test",
					command: options.verification ?? ["pnpm", "test"],
				},
			],
		},
		metadata: { tags: ["historical"] },
		provenance: {
			created_at: now,
			updated_at: now,
			created_by: "historical-reconstruction",
		},
	});
	const privateData = createEvaluatorPrivateData(task, {
		reference_patch: diff.patch,
		hidden_hook_source: null,
		private_notes: [
			`reference revision retained privately: ${fixSha.slice(0, 7)}`,
		],
	});
	const leakage = analyzeLeakage(task, privateData);
	return {
		task,
		privateData,
		leakageSafe: leakage.safe,
		diagnostics: leakage.findings.map((item) => item.code),
	};
}
