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
import { afterAll, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
afterAll(async () =>
	Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);

async function repositoryFixture() {
	const root = await mkdtemp(join(tmpdir(), "repoarena-action-e2e-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "action@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Action Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "broken\n", "utf8");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
	const base = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	const cli = join(
		process.cwd(),
		"..",
		"..",
		"packages",
		"cli",
		"dist",
		"index.js",
	);
	await execute(process.execPath, [cli, "init", "--yes"], { cwd: root });
	await mkdir(join(root, ".repoarena", "tasks"), { recursive: true });
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "action-e2e",
		title: "repair subject",
		source: { type: "imported", base_commit: base },
		prompt: "repair subject.txt",
		execution: { timeout_seconds: 10 },
		verification: {
			required: [
				{
					id: "fixed",
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
		join(root, ".repoarena", "tasks", "action-e2e.json"),
		JSON.stringify(task),
		"utf8",
	);
	return { root, cli };
}

it("executes the built Action and built RepoArena CLI end to end", async () => {
	const { root, cli } = await repositoryFixture();
	const output = join(root, "github-output");
	const summary = join(root, "github-summary");
	await writeFile(output, "", "utf8");
	await writeFile(summary, "", "utf8");
	const action = join(process.cwd(), "dist", "index.js");
	const result = await execute(process.execPath, [action], {
		cwd: root,
		env: {
			PATH: process.env.PATH ?? "",
			NODE_ENV: "test",
			REPOARENA_TEST_ADAPTERS: "1",
			REPOARENA_CLI_PATH: cli,
			GITHUB_WORKSPACE: root,
			GITHUB_OUTPUT: output,
			GITHUB_STEP_SUMMARY: summary,
			INPUT_AGENTS: "fake-perfect,fake-noop",
			"INPUT_RUNS-PER-TASK": "1",
			INPUT_PARALLELISM: "2",
			"INPUT_FAIL-ON-UNSOLVED": "false",
			INPUT_REPORTS: "terminal,json,html,junit",
		},
		maxBuffer: 2_000_000,
	});
	expect(result.stderr).toBe("");
	const run = JSON.parse(
		await readFile(
			join(root, ".repoarena", "state", "runs", "latest.json"),
			"utf8",
		),
	) as { statistics: { attempt_count: number; solved_count: number } };
	expect(run.statistics).toMatchObject({ attempt_count: 2, solved_count: 1 });
	expect(await readFile(output, "utf8")).toContain("attempt-count=2");
	expect(await readFile(summary, "utf8")).toContain("Solved **1/2**");
	const reports = await readdir(join(root, ".repoarena", "reports"));
	expect(reports.some((name) => name.endsWith(".json"))).toBe(true);
	expect(reports.some((name) => name.endsWith(".html"))).toBe(true);
	expect(reports.some((name) => name.endsWith(".xml"))).toBe(true);
});
