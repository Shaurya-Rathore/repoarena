import { toAgentVisibleTask, type Task } from "@repoarena/task-spec";
export type LeakageFinding = {
	code:
		| "REFERENCE_COMMIT"
		| "PATCH_FRAGMENT"
		| "SOLUTION_IDENTIFIER"
		| "HIDDEN_EVALUATOR"
		| "PRIVATE_PATH";
	severity: "high" | "medium";
	field: string;
	description: string;
};
export type LeakageResult = { safe: boolean; findings: LeakageFinding[] };
const words = (text: string) =>
	text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
export function analyzeLeakage(
	task: Task,
	privateData: {
		reference_patch: string | null;
		hidden_hook_source: string | null;
		private_notes: string[];
	},
): LeakageResult {
	const publicText = JSON.stringify(toAgentVisibleTask(task));
	const findings: LeakageFinding[] = [];
	if (
		task.source.reference_commit &&
		publicText.includes(task.source.reference_commit)
	)
		findings.push({
			code: "REFERENCE_COMMIT",
			severity: "high",
			field: "source",
			description: "Agent-visible task includes reference revision.",
		});
	if (/\.repoarena\/(private|hidden)|hidden[_ -]?test/i.test(publicText))
		findings.push({
			code: "PRIVATE_PATH",
			severity: "high",
			field: "task",
			description: "Agent-visible task names a protected evaluator location.",
		});
	if (
		privateData.hidden_hook_source &&
		publicText.includes(privateData.hidden_hook_source.slice(0, 40))
	)
		findings.push({
			code: "HIDDEN_EVALUATOR",
			severity: "high",
			field: "task",
			description: "Agent-visible task contains hidden evaluator text.",
		});
	if (privateData.reference_patch) {
		const patchLines = privateData.reference_patch
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
			.map((line) => line.slice(1).trim())
			.filter((line) => line.length > 12);
		const normalized = publicText.replace(/\s+/g, " ");
		if (
			patchLines.some((line) => normalized.includes(line.replace(/\s+/g, " ")))
		)
			findings.push({
				code: "PATCH_FRAGMENT",
				severity: "high",
				field: "prompt",
				description: "Agent-visible task contains reference patch text.",
			});
		const identifiers = new Set(words(privateData.reference_patch));
		const overlap = words(task.prompt).filter(
			(word) => identifiers.has(word) && word.length > 8,
		);
		if (overlap.length >= 2)
			findings.push({
				code: "SOLUTION_IDENTIFIER",
				severity: "medium",
				field: "prompt",
				description: "Prompt overlaps solution-only identifiers.",
			});
	}
	return { safe: findings.length === 0, findings };
}
