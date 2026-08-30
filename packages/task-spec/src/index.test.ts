import { describe, expect, it } from "vitest";
import {
	createEvaluatorPrivateData,
	migrateTask,
	taskContentHash,
	taskSchema,
	toAgentVisibleTask,
} from "./index.js";

const make = () =>
	taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "fix-parser",
		title: "Fix parser",
		source: {
			type: "historical",
			base_commit: "a1b2c3d",
			reference_commit: "b1b2c3d",
		},
		prompt: "Parser fails for a valid request.",
		verification: { required: [{ id: "unit", command: ["pnpm", "test"] }] },
		provenance: {
			created_at: "2020-01-01T00:00:00.000Z",
			updated_at: "2020-01-01T00:00:00.000Z",
			created_by: "fixture",
		},
	});
describe("task v1", () => {
	it("hashes task content independently of mutable provenance", () => {
		const first = make();
		const second = {
			...first,
			provenance: {
				...first.provenance,
				updated_at: "2021-01-01T00:00:00.000Z",
			},
		};
		expect(taskContentHash(first)).toBe(taskContentHash(second));
	});
	it("never serializes evaluator-private material into agent task", () => {
		const task = make();
		const privateData = createEvaluatorPrivateData(task, {
			hidden_hook_source: "assert(secret)",
			reference_patch: "+++ solution",
			private_notes: ["private"],
		});
		const agent = JSON.stringify(toAgentVisibleTask(task));
		expect(agent).not.toContain(privateData.reference_patch ?? "");
		expect(agent).not.toContain("reference_commit");
	});
	it("migrates legacy shell command tasks deterministically", () => {
		const migrated = migrateTask({
			schema: "repoarena.task/v0",
			id: "fix-parser",
			title: "Fix parser",
			base_commit: "a1b2c3d",
			prompt: "Repair it",
			verification: { required: ["pnpm test"] },
		});
		expect(migrated.task.schema).toBe("repoarena.task/v1");
		expect(migrated.task.verification.required[0]?.command).toEqual({
			shell: true,
			command: "pnpm test",
		});
	});
});
