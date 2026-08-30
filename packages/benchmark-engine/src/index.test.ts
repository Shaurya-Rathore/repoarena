import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { taskSchema } from "@repoarena/task-spec";
import { runArgv } from "@repoarena/runner-core";
import { loadRun } from "@repoarena/run-store";
import { toHtml, toJson, toJunit, toTerminal } from "@repoarena/reporter";
import { BenchmarkRetryError, runBenchmark } from "./index.js";

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
	let active = 0;
	let maxActive = 0;
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
					private_notes: [] as string[],
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

it("retries transient provider failures without inflating statistical attempts", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-retry-"));
	const state = join(root, "run.json");
	try {
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
			id: "retry-task",
			title: "retry",
			prompt: "repair",
			source: { type: "imported", base_commit: head },
			verification: {
				required: [
					{
						id: "public",
						command: [process.execPath, "-e", "process.exit(0)"],
					},
				],
			},
			provenance: {
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				created_by: "test",
			},
		});
		let invocations = 0;
		const run = await runBenchmark({
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
					id: "retry-agent",
					version: "1",
					model: "m",
					provider: "p",
					config_hash: "c",
					execute: async (workspace) => {
						invocations++;
						if (invocations === 1)
							throw new BenchmarkRetryError("PROVIDER_RETRY", "RATE_LIMIT");
						if (invocations === 2)
							throw new BenchmarkRetryError(
								"INFRASTRUCTURE_RETRY",
								"SANDBOX_START",
							);
						await writeFile(join(workspace, "subject.txt"), "fixed\n");
						return {
							command: "fake",
							exit_code: 0,
							duration_ms: 1,
							stdout: "",
							stderr: "",
							timed_out: false,
						};
					},
				},
			],
			runs_per_task: 1,
			parallelism: 1,
			provider_retry_limit: 2,
			infrastructure_retry_limit: 2,
			retry_backoff_ms: [0, 0],
			pricing: { version: "none", prices: [] },
			state_path: state,
			runner_version: "test",
		});
		expect(run.attempts).toHaveLength(1);
		expect(run.statistics.attempt_count).toBe(1);
		expect(run.attempts[0]?.retries).toHaveLength(2);
		expect(run.attempts[0]?.retries[0]?.class).toBe("PROVIDER_RETRY");
		expect(run.attempts[0]?.retries[1]?.class).toBe("INFRASTRUCTURE_RETRY");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("keeps persisted historical cost when the active catalog changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-cost-reload-"));
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
		id: "cost-reload",
		title: "cost",
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
	const state = join(root, "run.json");
	const agent = {
		id: "cost-agent",
		version: "1",
		model: "m",
		provider: "p",
		config_hash: "c",
		usage: { input_tokens: 100, output_tokens: 20 },
		execute: async (workspace: string) => {
			await writeFile(join(workspace, "subject.txt"), "fixed\n");
			return runArgv([process.execPath, "-e", "process.exit(0)"], workspace, 2);
		},
	};
	const base = {
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
		agents: [agent],
		runs_per_task: 1,
		parallelism: 1,
		state_path: state,
		runner_version: "test",
	};
	const v1 = await runBenchmark({
		...base,
		pricing: {
			version: "v1",
			prices: [
				{
					id: "v1-price",
					provider: "p",
					model: "m",
					effective_from: "2025-01-01",
					input_per_million: 1,
					output_per_million: 2,
					currency: "USD",
				},
			],
		},
	});
	const old = await loadRun(state);
	const oldReports = [toTerminal(old), toJson(old), toHtml(old), toJunit(old)];
	const v2 = await runBenchmark({
		...base,
		pricing: {
			version: "v2",
			prices: [
				{
					id: "v2-price",
					provider: "p",
					model: "m",
					effective_from: "2025-01-01",
					input_per_million: 10,
					output_per_million: 20,
					currency: "USD",
				},
			],
		},
	});
	expect(v1.attempts[0]?.cost.micros).toBe(140);
	expect(old.attempts[0]?.cost.micros).toBe(140);
	expect(v2.attempts[0]?.cost.micros).toBe(1400);
	expect(oldReports.every((report) => report.includes("140"))).toBe(true);
});

it("classifies adversarial agents through the connected evaluator pipeline", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-adversarial-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "bug\n");
	await import("node:fs/promises").then(({ mkdir }) =>
		mkdir(join(root, "test")),
	);
	await writeFile(
		join(root, "test", "behavior.test.js"),
		"// protected regression test\n",
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "adversarial",
		title: "repair",
		prompt: "repair",
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
		constraints: { forbidden_paths: [] },
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
	const names = ["perfect", "wrong", "noop", "partial", "delete"];
	const agents = names.map((id) => ({
		id,
		version: "1",
		model: "fake",
		provider: "fake",
		config_hash: id,
		execute: async (workspace: string) => {
			if (id === "perfect") {
				await writeFile(join(workspace, "subject.txt"), "fixed\n");
				await writeFile(join(workspace, "private-marker"), "ok");
			} else if (id === "partial")
				await writeFile(join(workspace, "subject.txt"), "fixed\n");
			else if (id === "wrong")
				await writeFile(join(workspace, "subject.txt"), "wrong\n");
			else if (id === "delete") {
				await writeFile(join(workspace, "subject.txt"), "fixed\n");
				await writeFile(join(workspace, "private-marker"), "ok");
				await rm(join(workspace, "test", "behavior.test.js"), { force: true });
			}
			return runArgv([process.execPath, "-e", "process.exit(0)"], workspace, 2);
		},
	}));
	const run = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [
			{
				task,
				private_data: {
					task_id: task.id,
					reference_commit: null,
					reference_patch: "private-reference",
					hidden_hook_source: null,
					private_notes: [],
				},
				private_verifier: async () => [
					[
						process.execPath,
						"-e",
						"if(require('fs').readFileSync('private-marker','utf8')!=='ok')process.exit(1)",
					],
				],
			},
		],
		agents,
		runs_per_task: 1,
		parallelism: 3,
		pricing: { version: "none", prices: [] },
		state_path: join(root, ".repoarena", "state", "runs", "run.json"),
		runner_version: "test",
	});
	const outcomes = Object.fromEntries(
		run.attempts.map((attempt) => [
			attempt.agent.id,
			[attempt.evaluation.outcome, attempt.evaluation.reason],
		]),
	);
	expect(outcomes.perfect).toEqual(["SOLVED", null]);
	expect(outcomes.partial).toEqual(["UNSOLVED", "HIDDEN_VERIFICATION_FAILED"]);
	expect(outcomes.wrong?.[0]).toBe("UNSOLVED");
	expect(outcomes.noop?.[0]).toBe("UNSOLVED");
	expect(outcomes.delete).toEqual(["UNSOLVED", "INTEGRITY_VIOLATION"]);
});
