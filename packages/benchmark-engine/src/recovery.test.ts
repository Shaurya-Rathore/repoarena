import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectRunRecovery, loadRun } from "@repoarena/run-store";
import { taskSchema } from "@repoarena/task-spec";
import { runArgv } from "@repoarena/runner-core";
import { runBenchmark } from "./index.js";

const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ra-recovery-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "base\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "recovery-task",
		title: "recovery",
		prompt: "repair",
		source: { type: "imported", base_commit: head },
		verification: {
			required: [
				{ id: "public", command: [process.execPath, "-e", "process.exit(0)"] },
			],
		},
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
	return { root, head, task, statePath: join(root, "state", "run.json") };
}

it("retains completed attempts and requires a clean restart after interruption", async () => {
	const { root, head, task, statePath } = await fixture();
	await expect(
		runBenchmark({
			root,
			repository: { commit: head, remote: null },
			tasks: [
				{
					task,
					private_data: {
						task_id: task.id,
						reference_commit: null,
						reference_patch: null,
						hidden_hook_source: null,
						private_notes: [],
					},
				},
			],
			agents: [
				{
					id: "completed",
					version: "1",
					model: "m",
					provider: "test",
					config_hash: "completed",
					execute: (workspace) =>
						runArgv([process.execPath, "-e", "process.exit(0)"], workspace, 2),
				},
				{
					id: "interrupted",
					version: "1",
					model: "m",
					provider: "test",
					config_hash: "interrupted",
					execute: async () => {
						throw new Error("simulated process interruption");
					},
				},
			],
			runs_per_task: 1,
			parallelism: 1,
			pricing: { version: "none", prices: [] },
			state_path: statePath,
			runner_version: "test",
		}),
	).rejects.toThrow("simulated process interruption");

	const persisted = await loadRun(statePath);
	expect(persisted.status).toBe("RUNNING");
	expect(persisted.attempts).toHaveLength(1);
	expect(persisted.attempts[0]).toMatchObject({
		agent: { id: "completed" },
		state: "COMPLETED",
	});
	expect(await inspectRunRecovery(statePath)).toMatchObject({
		status: "RUNNING",
		completed_attempt_ids: [persisted.attempts[0]?.id],
		needs_clean_restart: true,
	});
});

it("treats corrupt interrupted state as requiring a clean restart", async () => {
	const { statePath } = await fixture();
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, "{not-json");

	expect(await inspectRunRecovery(statePath)).toMatchObject({
		status: "CORRUPT",
		completed_attempt_ids: [],
		needs_clean_restart: true,
	});
});
