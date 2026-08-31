import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { taskSchema } from "@repoarena/task-spec";
import { runArgv, runIsolatedAttempt, transitionAttempt } from "./index.js";
const dirs: string[] = [];
afterEach(() =>
	Promise.all(
		dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
	),
);
it("does not interpret argv as shell syntax", async () => {
	const d = await mkdtemp(join(tmpdir(), "ra-runner-"));
	dirs.push(d);
	const marker = join(d, "owned");
	const r = await runArgv(
		[
			process.execPath,
			"-e",
			"console.log(process.argv[1])",
			`x; echo owned > ${marker}`,
		],
		d,
		2,
	);
	expect(r.exit_code).toBe(0);
	await expect(readFile(marker, "utf8")).rejects.toThrow();
});
it("rejects illegal state transitions", () => {
	expect(transitionAttempt("QUEUED", "PREPARING")).toBe("PREPARING");
	expect(() => transitionAttempt("COMPLETED", "SETUP")).toThrow();
});
it("collects an agent patch before isolated private verification", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-pipeline-"));
	dirs.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "bug\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "pipeline",
		title: "pipeline",
		prompt: "change",
		source: {
			type: "imported",
			base_commit: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		},
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
	const privateSentinel = "hidden-pipeline-sentinel";
	const result = await runIsolatedAttempt({
		root,
		task,
		agentArgv: [
			process.execPath,
			"-e",
			"require('fs').writeFileSync('subject.txt','fixed\\n')",
		],
		privateData: {
			task_id: task.id,
			reference_commit: null,
			reference_patch: privateSentinel,
			hidden_hook_source: null,
			private_notes: [],
		},
		privateVerifier: async (workspace) => {
			await writeFile(join(workspace, ".hidden"), privateSentinel);
			return [
				[
					process.execPath,
					"-e",
					`if(require('fs').readFileSync('.hidden','utf8')!==${JSON.stringify(privateSentinel)}) process.exit(1)`,
				],
			];
		},
	});
	expect(result.evaluation.outcome).toBe("SOLVED");
	expect(result.patch).toContain("fixed");
	expect(JSON.stringify(result)).not.toContain(privateSentinel);
});
it("rejects test deletion even when public verification exits successfully", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-integrity-"));
	dirs.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await import("node:fs/promises").then(({ mkdir }) =>
		mkdir(join(root, "test"), { recursive: true }),
	);
	await writeFile(
		join(root, "test", "bug.test.js"),
		"throw new Error('bug')\n",
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "delete-tests",
		title: "repair",
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
	const result = await runIsolatedAttempt({
		root,
		task,
		agentArgv: [
			process.execPath,
			"-e",
			"require('fs').unlinkSync('test/bug.test.js')",
		],
		privateData: {
			task_id: task.id,
			reference_commit: null,
			reference_patch: null,
			hidden_hook_source: null,
			private_notes: [],
		},
	});
	expect(result.evaluation).toMatchObject({
		outcome: "UNSOLVED",
		reason: "INTEGRITY_VIOLATION",
	});
	expect(result.evaluation.integrity.map((f) => f.code)).toContain(
		"TEST_DELETED",
	);
});
it("classifies timeout separately from agent failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-timeout-"));
	dirs.push(root);
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
		id: "timeout-case",
		title: "timeout",
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
	const result = await runIsolatedAttempt({
		root,
		task,
		agentExecutor: async () => ({
			command: "fake",
			exit_code: null,
			duration_ms: 1000,
			stdout: "",
			stderr: "",
			timed_out: true,
		}),
		privateData: {
			task_id: task.id,
			reference_commit: null,
			reference_patch: null,
			hidden_hook_source: null,
			private_notes: [],
		},
	});
	expect(result.evaluation).toMatchObject({
		outcome: "UNSOLVED",
		reason: "AGENT_TIMEOUT",
	});
	expect(result.state_history.at(-1)?.state).toBe("TIMED_OUT");
});
it("captures untracked agent files in the canonical patch", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-untracked-"));
	dirs.push(root);
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
		id: "untracked-file",
		title: "add file",
		prompt: "add",
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
	const result = await runIsolatedAttempt({
		root,
		task,
		agentArgv: [
			process.execPath,
			"-e",
			"require('fs').writeFileSync('new file.txt','added\\n')",
		],
		privateData: {
			task_id: task.id,
			reference_commit: null,
			reference_patch: null,
			hidden_hook_source: null,
			private_notes: [],
		},
	});
	expect(result.patch).toContain("new file.txt");
	expect(result.changed_files).toContainEqual(
		expect.objectContaining({ status: "A", path: "new file.txt" }),
	);
});

it("collects allowlisted artifacts and redacts secrets before persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-safe-output-"));
	dirs.push(root);
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
		id: "safe-output",
		title: "safe output",
		prompt: "repair",
		source: { type: "imported", base_commit: head },
		verification: {
			required: [
				{
					id: "public",
					command: [
						process.execPath,
						"-e",
						"process.stdout.write(require('fs').readFileSync('log.txt','utf8'))",
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
	const secret = "provider-secret-123456";
	const result = await runIsolatedAttempt({
		root,
		task,
		secrets: [secret],
		artifactRequests: [
			{ path: "log.txt", visibility: "PUBLIC", source: "agent" },
		],
		agentArgv: [
			process.execPath,
			"-e",
			`require('fs').writeFileSync('log.txt', ${JSON.stringify(secret)});process.stdout.write(${JSON.stringify(secret)})`,
		],
		privateData: {
			task_id: task.id,
			reference_commit: null,
			reference_patch: null,
			hidden_hook_source: null,
			private_notes: [],
		},
	});
	expect(result.artifacts).toHaveLength(1);
	expect(result.public_verification[0]?.stdout).toBe("[REDACTED]");
	expect(result.agent_execution?.stdout).toBe("[REDACTED]");
	expect(JSON.stringify(result)).not.toContain(secret);
});
