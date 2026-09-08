import { execFile, execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { taskSchema } from "@repoarena/task-spec";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);
it("runs the connected engine and writes every public report", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-cli-e2e-"));
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
	const cli = new URL("../dist/index.js", import.meta.url).pathname;
	await execute(process.execPath, [cli, "init", "--yes"], { cwd: root });
	await mkdir(join(root, ".repoarena", "tasks"), { recursive: true });
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "e2e",
		title: "repair",
		source: { type: "imported", base_commit: head },
		prompt: "repair",
		execution: { timeout_seconds: 10 },
		verification: {
			required: [
				{
					id: "public",
					command: [
						process.execPath,
						"-e",
						"if(require('fs').readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)",
					],
					timeout_seconds: 10,
				},
			],
		},
		constraints: { max_patch_bytes: 1000000 },
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
	await writeFile(
		join(root, ".repoarena", "tasks", "e2e.json"),
		JSON.stringify(task),
	);
	const hiddenSentinel = "hidden-cli-e2e-sentinel";
	await mkdir(join(root, ".repoarena", "state", "private"), {
		recursive: true,
	});
	await writeFile(
		join(root, ".repoarena", "state", "private", "e2e.json"),
		JSON.stringify({
			task_id: "e2e",
			reference_commit: null,
			reference_patch: "reference-solution-sentinel",
			hidden_hook_source: `// ${hiddenSentinel}\nimport {readFileSync} from 'node:fs'; if (readFileSync('subject.txt','utf8') !== 'fixed\\n') process.exit(1);`,
			private_notes: [],
		}),
	);
	const reports = join(root, "reports");
	const { stdout } = await execute(
		process.execPath,
		[
			cli,
			"run",
			"--agent-command",
			process.execPath,
			"--agent-arg=-e",
			`--agent-arg=require('fs').writeFileSync('subject.txt','fixed\\n')`,
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
	const result = JSON.parse(stdout);
	expect(result.statistics).toMatchObject({
		attempt_count: 2,
		solved_count: 2,
	});
	const files = await readdir(reports);
	expect(files.some((file) => file.endsWith(".json"))).toBe(true);
	expect(files.some((file) => file.endsWith(".html"))).toBe(true);
	expect(files.some((file) => file.endsWith(".xml"))).toBe(true);
	expect(
		await readFile(
			join(root, ".repoarena", "state", "runs", "latest.json"),
			"utf8",
		),
	).toContain("repoarena.benchmark-run/v1");
	for (const file of files) {
		expect(await readFile(join(reports, file), "utf8")).not.toContain(
			hiddenSentinel,
		);
		expect(await readFile(join(reports, file), "utf8")).not.toContain(
			"reference-solution-sentinel",
		);
	}
	const doctor = await execute(process.execPath, [cli, "doctor", "--json"], {
		cwd: root,
	});
	expect(JSON.parse(doctor.stdout).schema).toBe("repoarena.readiness/v1");
	const humanDoctor = await execute(process.execPath, [cli, "doctor"], {
		cwd: root,
	});
	expect(humanDoctor.stdout).toContain("Repository readiness:");
	expect(humanDoctor.stdout).toContain("Recommendation:");
	expect(
		await readFile(
			join(root, ".repoarena", "state", "readiness", "latest.json"),
			"utf8",
		),
	).toContain("repoarena.readiness/v1");
	await writeFile(
		join(root, "search.yaml"),
		[
			"schema: repoarena.optimizer-search/v1",
			"dimensions:",
			"  - agent: fake-perfect",
			"    models: [deterministic]",
			"tasks: [e2e]",
			"budget:",
			"  max_trials: 1",
		].join("\n"),
	);
	const optimization = await execute(
		process.execPath,
		[
			cli,
			"optimize",
			"--search-space",
			"search.yaml",
			"--profile",
			"profile.yaml",
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
	const optimizationRun = JSON.parse(optimization.stdout);
	expect(optimizationRun.recommendation.candidate.agent).toBe("fake-perfect");
	expect(optimizationRun.recommendation.metrics.success_rate).toBe(1);
	expect(await readFile(join(root, "profile.yaml"), "utf8")).toContain(
		"repoarena.profile/v1",
	);
}, 15_000);
it("inspects the production adapter registry without credentials", async () => {
	const cli = new URL("../dist/index.js", import.meta.url).pathname;
	const { stdout } = await execute(
		process.execPath,
		[cli, "agents", "list", "--json"],
		{ cwd: process.cwd(), env: { PATH: "" } },
	);
	const values = JSON.parse(stdout);
	expect(values.map((item: { id: string }) => item.id)).toEqual([
		"claude-code",
		"codex",
		"gemini-cli",
		"opencode",
	]);
	expect(stdout).not.toMatch(/API_KEY|TOKEN=/);
});

it("guides a first-time user through initialization, detection, and missing tasks", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-cli-first-run-"));
	roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "README.md"), "fixture\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	const cli = new URL("../dist/index.js", import.meta.url).pathname;
	const initialized = await execute(process.execPath, [cli, "init", "--yes"], {
		cwd: root,
	});
	expect(initialized.stdout).toContain("RepoArena initialized.");
	expect(initialized.stdout).toContain("repoarena agents detect");
	const detected = await execute(process.execPath, [cli, "agents", "detect"], {
		cwd: root,
		env: { PATH: "" },
	});
	expect(detected.stdout).toContain("codex");
	expect(detected.stdout).toContain("existing authentication");
	await expect(
		execute(process.execPath, [cli, "run", "--agent", "codex"], {
			cwd: root,
			env: { PATH: "" },
		}),
	).rejects.toMatchObject({
		stderr: expect.stringContaining("repoarena tasks discover"),
	});
});
