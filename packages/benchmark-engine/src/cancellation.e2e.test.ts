import { execFileSync } from "node:child_process";
import {
	access,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runArgv } from "@repoarena/runner-core";
import { loadRun } from "@repoarena/run-store";
import { taskSchema } from "@repoarena/task-spec";
import { runBenchmark } from "./index.js";

const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);

async function fixture(id: string) {
	const root = await mkdtemp(join(tmpdir(), `ra-${id}-`));
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
		id,
		title: id,
		prompt: "repair",
		source: { type: "imported", base_commit: head },
		execution: { timeout_seconds: 10 },
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
	return { root, head, task, state: join(root, "state", "run.json") };
}

async function waitForFile(path: string): Promise<void> {
	for (let index = 0; index < 200; index++) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

it("cancels an active benchmark attempt and terminates its process tree", async () => {
	const { root, head, task, state } = await fixture("cancel-active");
	const control = await mkdtemp(join(tmpdir(), "ra-cancel-control-"));
	roots.push(control);
	const ready = join(control, "ready");
	const heartbeat = join(control, "heartbeat");
	const controller = new AbortController();
	const source = `
		const {spawn}=require('node:child_process');
		const fs=require('node:fs');
		fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
		spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),10)`)}],{stdio:'ignore'});
		setInterval(()=>{},1000);
	`;
	const pending = runBenchmark({
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
				id: "cancellable",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "cancel",
				argv: [process.execPath, "-e", source],
			},
		],
		runs_per_task: 1,
		parallelism: 1,
		pricing: { version: "none", prices: [] },
		state_path: state,
		runner_version: "test",
		signal: controller.signal,
	});
	await waitForFile(ready);
	controller.abort();
	const result = await pending;
	expect(result.status).toBe("CANCELLED");
	expect(result.attempts).toHaveLength(1);
	expect(result.attempts[0]).toMatchObject({
		state: "CANCELLED",
		evaluation: { outcome: "UNSOLVED", reason: "CANCELLED" },
	});
	expect((await loadRun(state)).status).toBe("CANCELLED");
	await new Promise((resolve) => setTimeout(resolve, 100));
	const firstSize = (await stat(heartbeat).catch(() => ({ size: 0 }))).size;
	await new Promise((resolve) => setTimeout(resolve, 100));
	const secondSize = (await stat(heartbeat).catch(() => ({ size: 0 }))).size;
	expect(secondSize).toBe(firstSize);
});

it("allows parallel agents while excluding private verification globally", async () => {
	const { root, head, task, state } = await fixture("private-phase-gate");
	let activeAgents = 0;
	let maximumAgents = 0;
	let releaseAgents: (() => void) | undefined;
	const barrier = new Promise<void>((resolve) => {
		releaseAgents = resolve;
	});
	let privateOverlap = false;
	const agent = (id: string) => ({
		id,
		version: "1",
		model: "fake",
		provider: "fake",
		config_hash: id,
		execute: async (workspace: string) => {
			activeAgents++;
			maximumAgents = Math.max(maximumAgents, activeAgents);
			if (activeAgents === 2) releaseAgents?.();
			await barrier;
			await writeFile(join(workspace, `${id}.txt`), "done\n");
			activeAgents--;
			return runArgv([process.execPath, "-e", "process.exit(0)"], workspace, 2);
		},
	});
	const result = await runBenchmark({
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
				private_verifier: async () => {
					if (activeAgents > 0) privateOverlap = true;
					await new Promise((resolve) => setTimeout(resolve, 20));
					return [[process.execPath, "-e", "process.exit(0)"]];
				},
			},
		],
		agents: [agent("agent-a"), agent("agent-b")],
		runs_per_task: 1,
		parallelism: 2,
		pricing: { version: "none", prices: [] },
		state_path: state,
		runner_version: "test",
	});
	expect(maximumAgents).toBe(2);
	expect(privateOverlap).toBe(false);
	expect(result.attempts).toHaveLength(2);
	expect(
		result.attempts.every((attempt) => attempt.state === "COMPLETED"),
	).toBe(true);
});
