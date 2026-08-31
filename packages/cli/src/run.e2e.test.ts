import { execFile, execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { taskSchema } from "@repoarena/task-spec";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const cli = new URL("../dist/index.js", import.meta.url).pathname;

afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "ra-cli-run-e2e-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "broken\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	await execute(process.execPath, [cli, "init", "--yes"], { cwd: root });
	await mkdir(join(root, ".repoarena", "tasks"), { recursive: true });
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "cli-run",
		title: "repair subject",
		source: { type: "imported", base_commit: baseCommit },
		prompt: "repair subject.txt",
		execution: { timeout_seconds: 10 },
		verification: {
			required: [
				{
					id: "subject-fixed",
					command: [
						process.execPath,
						"-e",
						"if(require('fs').readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)",
					],
					timeout_seconds: 10,
				},
			],
		},
		constraints: { max_patch_bytes: 1_000_000 },
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
	await writeFile(
		join(root, ".repoarena", "tasks", "cli-run.json"),
		JSON.stringify(task),
	);
	return root;
}

async function commandFailure(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
) {
	try {
		await execute(process.execPath, [cli, ...args], {
			cwd,
			env,
			maxBuffer: 2_000_000,
		});
		throw new Error("expected command to fail");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error)) throw error;
		return error as Error & { code: number; stdout: string; stderr: string };
	}
}

it("runs repeated parallel external agents and renders each requested report", async () => {
	const root = await createFixture();
	const reports = join(root, "reports");
	const { stdout } = await execute(
		process.execPath,
		[
			cli,
			"run",
			"--agent-command",
			process.execPath,
			"--agent-arg=-e",
			"--agent-arg=require('fs').writeFileSync('subject.txt','fixed\\n')",
			"--runs-per-task",
			"2",
			"--parallel",
			"2",
			"--report",
			"json,html,junit",
			"--output",
			reports,
			"--json",
		],
		{ cwd: root, env: { PATH: process.env.PATH ?? "" }, maxBuffer: 2_000_000 },
	);
	const run = JSON.parse(stdout) as {
		attempts: Array<{ index: number; evaluation: { outcome: string } }>;
		statistics: { attempt_count: number; solved_count: number };
	};
	expect(run.statistics).toMatchObject({
		attempt_count: 2,
		solved_count: 2,
		success_rate: 1,
		median_duration_ms: expect.any(Number),
	});
	expect(run.attempts.map((attempt) => attempt.index)).toEqual([0, 1]);
	expect(
		run.attempts.every((attempt) => attempt.evaluation.outcome === "SOLVED"),
	).toBe(true);
	const files = await readdir(reports);
	expect(files).toEqual(
		expect.arrayContaining([
			expect.stringMatching(/\.json$/),
			expect.stringMatching(/\.html$/),
			expect.stringMatching(/\.xml$/),
		]),
	);
	const output = await Promise.all(
		files.map((file) => readFile(join(reports, file), "utf8")),
	);
	expect(
		output.some((report) => report.includes("repoarena.benchmark-run/v1")),
	).toBe(true);
	expect(output.some((report) => report.includes("<html"))).toBe(true);
	expect(output.some((report) => report.includes("<testsuite"))).toBe(true);
});

it("keeps normal unsolved runs informational and makes CI mode fail", async () => {
	const root = await createFixture();
	const reports = join(root, "reports");
	const normal = await execute(
		process.execPath,
		[
			cli,
			"run",
			"--agent-command",
			process.execPath,
			"--agent-arg=-e",
			"--agent-arg=process.exit(0)",
			"--json",
		],
		{ cwd: root, env: { PATH: process.env.PATH ?? "" } },
	);
	expect(JSON.parse(normal.stdout).statistics.solved_count).toBe(0);
	const result = await commandFailure(
		[
			"run",
			"--agent-command",
			process.execPath,
			"--agent-arg=-e",
			"--agent-arg=process.exit(0)",
			"--report",
			"json,junit",
			"--output",
			reports,
			"--json",
			"--ci",
		],
		root,
		{ PATH: process.env.PATH ?? "" },
	);
	expect(result.code).toBe(1);
	const run = JSON.parse(result.stdout) as {
		statistics: { attempt_count: number; solved_count: number };
		attempts: Array<{ evaluation: { outcome: string } }>;
	};
	expect(run.statistics.attempt_count).toBe(1);
	expect(run.statistics.solved_count).toBe(0);
	expect(run.attempts[0]?.evaluation.outcome).not.toBe("SOLVED");
	const files = await readdir(reports);
	expect(files.some((file) => file.endsWith(".json"))).toBe(true);
	expect(files.some((file) => file.endsWith(".xml"))).toBe(true);
});

it("runs multiple doubly gated deterministic adapters with stable ordering", async () => {
	const root = await createFixture();
	const { stdout } = await execute(
		process.execPath,
		[
			cli,
			"run",
			"--agent",
			"fake-perfect",
			"--agent",
			"fake-noop",
			"--runs-per-task",
			"2",
			"--parallel",
			"2",
			"--json",
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				NODE_ENV: "test",
				REPOARENA_TEST_ADAPTERS: "1",
			},
			maxBuffer: 2_000_000,
		},
	);
	const run = JSON.parse(stdout) as {
		attempts: Array<{ agent: { id: string }; index: number }>;
		statistics: { attempt_count: number; solved_count: number };
	};
	expect(run.statistics).toMatchObject({ attempt_count: 4, solved_count: 2 });
	expect(
		run.attempts.map((attempt) => `${attempt.agent.id}:${attempt.index}`),
	).toEqual(["fake-noop:0", "fake-noop:1", "fake-perfect:0", "fake-perfect:1"]);
});

it("rejects missing and unavailable agent selections before executing a run", async () => {
	const root = await createFixture();
	const missing = await commandFailure(["run", "--json"], root);
	expect(missing.code).toBe(2);
	expect(missing.stderr).toContain("Select --agent or --agent-command.");

	const unavailable = await commandFailure(
		["run", "--agent", "codex", "--json"],
		root,
		{ PATH: "" },
	);
	expect(unavailable.code).toBe(2);
	expect(unavailable.stderr).toContain("codex is unavailable.");

	const invalidSandbox = await commandFailure(
		[
			"run",
			"--agent-command",
			process.execPath,
			"--sandbox",
			"invalid",
			"--json",
		],
		root,
	);
	expect(invalidSandbox.code).toBe(2);
	expect(invalidSandbox.stderr).toContain("sandbox must be local or docker");

	const traversal = await commandFailure(
		[
			"run",
			"--agent-command",
			process.execPath,
			"--output",
			"../outside-reports",
			"--json",
		],
		root,
	);
	expect(traversal.code).toBe(2);
	expect(traversal.stderr).toContain(
		"Output path must remain inside the repository.",
	);
});
