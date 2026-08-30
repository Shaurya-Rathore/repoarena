import { describe, expect, it } from "vitest";
import { taskSchema } from "@repoarena/task-spec";
import { analyzeLeakage } from "./index.js";
const task = (prompt = "Handle invalid headers safely") =>
	taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "fix-header",
		title: "Fix header",
		source: {
			type: "historical",
			base_commit: "a1b2c3d",
			reference_commit: "b1b2c3d",
		},
		prompt,
		verification: { required: [{ id: "test", command: ["true"] }] },
		provenance: {
			created_at: "2020-01-01T00:00:00.000Z",
			updated_at: "2020-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
describe("leakage analysis", () => {
	it("detects exact patch fragments", () =>
		expect(
			analyzeLeakage(task("Use return normalizeSecretHeader(value) now"), {
				reference_patch: "+return normalizeSecretHeader(value)",
				hidden_hook_source: null,
				private_notes: [],
			}).safe,
		).toBe(false));
	it("permits harmless behavior language", () =>
		expect(
			analyzeLeakage(task(), {
				reference_patch: "+const normalizeSecretHeader = value => value.trim()",
				hidden_hook_source: null,
				private_notes: [],
			}).safe,
		).toBe(true));
});
