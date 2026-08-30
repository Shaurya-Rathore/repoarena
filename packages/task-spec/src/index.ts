import { contentHash, RepoArenaError } from "@repoarena/core";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{7,64}$/i);
const argv = z.array(z.string().min(1)).min(1).max(64);
export const commandSchema = z.union([
	argv,
	z
		.object({ shell: z.literal(true), command: z.string().min(1).max(20_000) })
		.strict(),
]);
const check = z
	.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		command: commandSchema,
		timeout_seconds: z.number().int().positive().max(3600).default(300),
		exit_code: z.number().int().default(0),
	})
	.strict();
const source = z
	.object({
		type: z.enum(["historical", "curated", "imported"]),
		base_commit: sha,
		reference_commit: sha.nullable().default(null),
		issue_url: z.string().url().nullable().default(null),
		pr_url: z.string().url().nullable().default(null),
		discovery: z
			.object({
				algorithm: z.string(),
				candidate_id: z.string().nullable().default(null),
				score: z.number().finite().nullable().default(null),
				evidence: z.array(z.string()).default([]),
			})
			.strict()
			.nullable()
			.default(null),
	})
	.strict();
export const taskSchema = z
	.object({
		schema: z.literal("repoarena.task/v1"),
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
		title: z.string().min(1).max(240),
		source,
		prompt: z.string().min(1).max(50_000),
		setup: z
			.object({
				working_directory: z.string().min(1).default("."),
				commands: z.array(commandSchema).default([]),
				timeout_seconds: z.number().int().positive().max(3600).default(600),
				network: z.enum(["deny", "allowlist", "unrestricted"]).default("deny"),
			})
			.strict()
			.default({}),
		execution: z
			.object({
				timeout_seconds: z.number().int().positive().max(7200).default(900),
				network: z
					.object({
						mode: z.enum(["deny", "allowlist", "unrestricted"]).default("deny"),
						allow_domains: z.array(z.string()).default([]),
					})
					.strict()
					.default({}),
				cpu_limit: z.number().positive().nullable().default(null),
				memory_mb: z.number().int().positive().nullable().default(null),
				environment: z
					.record(
						z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
						z
							.object({
								required: z.boolean().default(false),
								secret: z.boolean().default(false),
								description: z.string().max(500).default(""),
							})
							.strict(),
					)
					.default({}),
			})
			.strict()
			.default({}),
		verification: z
			.object({
				required: z.array(check).min(1),
				optional: z.array(check).default([]),
				hidden_hook: z
					.object({ id: z.string(), version: z.string() })
					.strict()
					.nullable()
					.default(null),
			})
			.strict(),
		scoring: z
			.object({
				correctness_weight: z.number().min(0).max(1).default(1),
				quality_weight: z.number().min(0).max(1).default(0),
				performance_weight: z.number().min(0).max(1).default(0),
			})
			.strict()
			.default({}),
		constraints: z
			.object({
				forbidden_paths: z.array(z.string()).default([]),
				max_patch_bytes: z.number().int().positive().default(200_000),
				allow_test_modifications: z.boolean().default(true),
			})
			.strict()
			.default({}),
		metadata: z
			.object({
				languages: z.array(z.string()).default([]),
				frameworks: z.array(z.string()).default([]),
				tags: z
					.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
					.default([]),
				difficulty: z
					.enum(["easy", "medium", "hard", "expert"])
					.nullable()
					.default(null),
				quality_score: z.number().min(0).max(1).nullable().default(null),
			})
			.strict()
			.default({}),
		expected_evidence: z
			.object({
				base: z.array(z.string()).default([]),
				reference: z.array(z.string()).default([]),
			})
			.strict()
			.default({}),
		validation: z
			.object({
				status: z
					.enum([
						"DRAFT",
						"STATIC_VALID",
						"ENV_PREPARED",
						"BASELINE_VALID",
						"REFERENCE_VALID",
						"LEAKAGE_VALID",
						"READY",
						"INVALID",
						"BLOCKED",
					])
					.default("DRAFT"),
				validator_version: z.string().nullable().default(null),
				validated_at: z.string().datetime().nullable().default(null),
			})
			.strict()
			.default({}),
		provenance: z
			.object({
				created_at: z.string().datetime(),
				updated_at: z.string().datetime(),
				created_by: z.string().min(1),
				import_source: z.string().nullable().default(null),
			})
			.strict(),
	})
	.strict();
export type Task = z.infer<typeof taskSchema>;
export type EvaluatorPrivateTaskData = Readonly<{
	task_id: string;
	reference_commit: string | null;
	hidden_hook_source: string | null;
	reference_patch: string | null;
	private_notes: string[];
}>;
export type AgentVisibleTask = Readonly<
	Pick<
		Task,
		| "schema"
		| "id"
		| "title"
		| "prompt"
		| "setup"
		| "execution"
		| "verification"
		| "scoring"
		| "constraints"
		| "metadata"
	> & { source: Pick<Task["source"], "type" | "base_commit"> }
>;
export function toAgentVisibleTask(task: Task): AgentVisibleTask {
	const {
		schema,
		id,
		title,
		prompt,
		setup,
		execution,
		verification,
		scoring,
		constraints,
		metadata,
	} = task;
	return {
		schema,
		id,
		title,
		prompt,
		setup,
		execution,
		verification,
		scoring,
		constraints,
		metadata,
		source: { type: task.source.type, base_commit: task.source.base_commit },
	};
}
export function taskContentProjection(task: Task): unknown {
	return {
		...toAgentVisibleTask(task),
		expected_evidence: task.expected_evidence,
	};
}
export const taskContentHash = (task: Task): string =>
	contentHash(taskContentProjection(task));
export const serializeTask = (task: Task): string =>
	stringify(taskSchema.parse(task), { sortMapEntries: true, lineWidth: 0 });
export type MigrationDiagnostic = { code: string; message: string };
export function migrateTask(
	input: unknown,
	now = "1970-01-01T00:00:00.000Z",
): { task: Task; diagnostics: MigrationDiagnostic[] } {
	const current = taskSchema.safeParse(input);
	if (current.success) return { task: current.data, diagnostics: [] };
	const old = input as Record<string, unknown>;
	if (old?.schema !== "repoarena.task/v0" && !("base_commit" in (old ?? {})))
		throw new RepoArenaError(
			"TASK_INVALID",
			"Unsupported task schema version.",
		);
	const required = (
		(old.verification as { required?: unknown[] } | undefined)?.required ?? []
	).map((value, index) =>
		typeof value === "string"
			? {
					id: `verify-${index + 1}`,
					command: { shell: true as const, command: value },
				}
			: value,
	);
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: String(old.id ?? ""),
		title: String(old.title ?? old.id ?? ""),
		source: { type: "imported", base_commit: String(old.base_commit ?? "") },
		prompt: String(old.prompt ?? ""),
		verification: { required },
		provenance: {
			created_at: now,
			updated_at: now,
			created_by: "migration",
			import_source: "repoarena.task/v0",
		},
	});
	return {
		task,
		diagnostics: [{ code: "MIGRATED_V0", message: "Migrated legacy task." }],
	};
}
export function parseTaskDocument(
	text: string,
	format: "yaml" | "json" = "yaml",
) {
	try {
		return migrateTask(
			format === "json"
				? JSON.parse(text)
				: parseDocument(text, { maxAliasCount: 20 } as never).toJS(),
		);
	} catch (cause) {
		throw new RepoArenaError("TASK_INVALID", "Task document is malformed.", {
			cause: cause instanceof Error ? cause.message : String(cause),
		});
	}
}
export function createEvaluatorPrivateData(
	task: Task,
	data: Omit<EvaluatorPrivateTaskData, "task_id" | "reference_commit">,
): EvaluatorPrivateTaskData {
	return {
		task_id: task.id,
		reference_commit: task.source.reference_commit,
		...data,
	};
}
