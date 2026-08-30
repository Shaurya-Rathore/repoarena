import { describe, expect, it } from "vitest";
import { taskSchema } from "./index.js";

describe("task schema", () => {
	it("applies safe task defaults", () => {
		const task = taskSchema.parse({
			schema: "repoarena.task/v1",
			id: "fix-one",
			title: "Fix one",
			prompt: "Repair it.",
			base_commit: "a1b2c3d",
			verification: { required: [{ command: "pnpm test" }] },
		});
		expect(task.constraints.network).toBe("none");
		expect(task.constraints.max_patch_bytes).toBe(1_000_000);
	});
});
