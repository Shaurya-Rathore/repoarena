import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { taskSchema } from "@repoarena/task-spec";
import { runArgv } from "@repoarena/runner-core";
import { runBenchmark } from "./index.js";

const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);
it("runs clean repetitions with bounded concurrency and persists cost", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-benchmark-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "bug\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "e2e",
		title: "repair",
		prompt: "repair behavior",
		source: { type: "imported", base_commit: head },
		verification: {
			required: [
				{
					id: "public",
					command: [
						process.execPath,
						"-e",
						"if(require('fs').readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)",
					],
				},
			],
		},
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
	let active = 0,
		maxActive = 0;
	const agent = (id: string) => ({
		id,
		version: "1",
		model: "solver",
		provider: "fake",
		config_hash: id.repeat(64).slice(0, 64),
		usage: { input_tokens: 100, output_tokens: 20 },
		execute: async (workspace: string) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			await writeFile(join(workspace, "subject.txt"), "fixed\n");
			active--;
			return runArgv([process.execPath, "-e", "process.exit(0)"], workspace, 2);
		},
	});
	const hidden = "private-e2e-sentinel";
	const state = join(root, ".repoarena", "state", "runs", "run.json");
	const result = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [
			{
				task,
				private_data: {
					task_id: task.id,
					reference_commit: null,
					reference_patch: hidden,
					hidden_hook_source: null,
					private_notes: [],
				},
				private_verifier: async (workspace) => {
					await writeFile(join(workspace, ".hidden"), "ok");
					return [
						[
							process.execPath,
							"-e",
							"if(require('fs').readFileSync('.hidden','utf8')!=='ok')process.exit(1)",
						],
					];
				},
			},
		],
		agents: [agent("a"), agent("b")],
		runs_per_task: 2,
		parallelism: 2,
		pricing: {
			version: "v1",
			prices: [
				{
					id: "fake-v1",
					provider: "fake",
					model: "solver",
					effective_from: "2025-01-01",
					input_per_million: 1,
					output_per_million: 2,
					currency: "USD",
				},
			],
		},
		state_path: state,
		runner_version: "test",
	});
	expect(maxActive).toBe(2);
	expect(result.attempts).toHaveLength(4);
	expect(result.statistics.solved_count).toBe(4);
	expect(result.attempts.map((a) => `${a.agent.id}:${a.index}`)).toEqual([
		"a:0",
		"a:1",
		"b:0",
		"b:1",
	]);
	expect(result.attempts.every((a) => a.cost.pricing_id === "fake-v1")).toBe(
		true,
	);
	expect(await readFile(state, "utf8")).not.toContain(hidden);
});
