import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { toHtml, toJson, toJunit, toTerminal } from "@repoarena/reporter";
import { runIsolatedAttempt } from "@repoarena/runner-core";
import { loadRun, type PersistedRun } from "@repoarena/run-store";
import { taskSchema, type Task } from "@repoarena/task-spec";
import { runBenchmark } from "./index.js";

const roots: string[] = [];
const node = (source: string, ...args: string[]) => [
	process.execPath,
	"-e",
	source,
	...args,
];
const privateData = (referencePatch: string | null = null) => ({
	task_id: "security-e2e",
	reference_commit: null,
	reference_patch: referencePatch,
	hidden_hook_source: null,
	private_notes: [],
});

afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);

async function fixture(): Promise<{ root: string; head: string }> {
	const root = await mkdtemp(join(tmpdir(), "repoarena-security-e2e-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Security Test"], { cwd: root });
	await writeFile(join(root, "subject.txt"), "base\n");
	await writeFile(join(root, "package.json"), "{}\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-m", "base"], { cwd: root });
	return {
		root,
		head: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
	};
}

function task(head: string, timeout = 2): Task {
	return taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "security-e2e",
		title: "security pipeline",
		prompt: "repair subject.txt",
		source: { type: "imported", base_commit: head },
		execution: { timeout_seconds: timeout },
		verification: {
			required: [
				{
					id: "public",
					command: node(
						"const fs=require('fs'); if(fs.readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)",
					),
				},
			],
		},
		provenance: {
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			created_by: "test",
		},
	});
}

function sandbox() {
	return {
		id: "local",
		capabilities: () => ({
			network_enforced: false,
			isolation: "process" as const,
		}),
		execute: async (command: {
			argv: string[];
			cwd: string;
			env: Record<string, string>;
			timeout_seconds: number;
		}) => {
			const { LocalSandboxProvider } = await import(
				new URL("../../sandbox-local/src/index.js", import.meta.url).href
			);
			return new LocalSandboxProvider(command.cwd).execute(command);
		},
	};
}

function publicSurfaces(run: PersistedRun, persisted: string): string[] {
	return [
		JSON.stringify(run),
		persisted,
		toTerminal(run),
		toJson(run),
		toHtml(run),
		toJunit(run),
	];
}

function expectNoForbiddenSentinels(
	surfaces: readonly string[],
	forbidden: readonly string[],
): void {
	for (const surface of surfaces)
		for (const sentinel of forbidden) expect(surface).not.toContain(sentinel);
}

it("keeps reference data and leaked secrets out of a persisted benchmark run", async () => {
	const { root, head } = await fixture();
	const referenceSentinel = "reference-68f4890862894f42850a24bbcddf26e8";
	const hiddenSentinel = "hidden-9349707061624dc3b5e88af90e5392ae";
	const hiddenPathSentinel = "private-path-3ba6d13f40164988a97cb92f586c6375";
	const hostCredentialSentinel =
		"host-credential-bba5b36017044875a786076d24e9cfea";
	const secret = "provider-secret-a0e5a8918a1f4eb1bf8cab90cc5b8559";
	const searchAgent = node(
		`const fs=require('fs'),path=require('path'); setTimeout(()=>{const seen=[]; const inspect=(p,depth)=>{try{const s=fs.lstatSync(p); if(s.isFile()&&s.size<100000)seen.push(fs.readFileSync(p,'utf8')); else if(s.isDirectory()&&depth>0)for(const n of fs.readdirSync(p).slice(0,30))inspect(path.join(p,n),depth-1);}catch{}}; inspect('.',4); inspect('..',2); inspect(require('node:os').tmpdir(),2); seen.push(JSON.stringify(process.env),JSON.stringify(process.argv)); const found=seen.some(value=>/(?:reference|hidden|private-path)-[a-f0-9]{32}/.test(value)); fs.writeFileSync('search-result.txt',seen.join('\\n').slice(0,100000)); fs.writeFileSync('subject.txt',found?'leaked\\n':'fixed\\n'); fs.writeFileSync('leak.txt',${JSON.stringify(secret)}); process.stdout.write(${JSON.stringify(secret)}); process.stderr.write(${JSON.stringify(secret)})},200)`,
	);
	const state = join(root, ".repoarena", "state", "security-run.json");
	const baseTask = task(head);
	const secretTask = taskSchema.parse({
		...baseTask,
		verification: {
			required: [
				...baseTask.verification.required,
				{
					id: "redacted-log",
					command: node(
						"const fs=require('fs'); process.stdout.write(fs.readFileSync('leak.txt')); process.stderr.write(fs.readFileSync('leak.txt'))",
					),
				},
			],
		},
	});
	const result = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [
			{
				task: secretTask,
				private_data: privateData(referenceSentinel),
				private_verifier: async (workspace, data) => {
					await writeFile(
						join(workspace, hiddenPathSentinel),
						`${data.reference_patch ?? ""}\n${hiddenSentinel}`,
					);
					return [
						node(
							`if(!require('fs').readFileSync(${JSON.stringify(hiddenPathSentinel)},'utf8').includes(${JSON.stringify(hiddenSentinel)}))process.exit(1)`,
						),
					];
				},
				artifact_requests: [
					{ path: "leak.txt", visibility: "PUBLIC", source: "agent" },
					{
						path: "search-result.txt",
						visibility: "PUBLIC",
						source: "agent",
					},
				],
			},
		],
		agents: [
			{
				id: "<script>HiddenTestSearchingAgent</script>",
				version: "1",
				model: "test",
				provider: "test",
				config_hash: "a".repeat(64),
				argv: searchAgent,
				secrets: [secret],
			},
			{
				id: "PerfectSibling",
				version: "1",
				model: "test",
				provider: "test",
				config_hash: "b".repeat(64),
				argv: node(
					"const fs=require('fs');fs.writeFileSync('subject.txt','fixed\\n');fs.writeFileSync('leak.txt','benign');fs.writeFileSync('search-result.txt','absent')",
				),
			},
		],
		runs_per_task: 1,
		parallelism: 2,
		pricing: { version: "test", prices: [] },
		state_path: state,
		runner_version: "test",
		sandbox_id: "local",
		sandbox_factory: () => sandbox(),
	});
	const searchingAttempt = result.attempts.find((attempt) =>
		attempt.agent.id.includes("HiddenTestSearchingAgent"),
	);
	expect(result.statistics.solved_count).toBe(2);
	expect(searchingAttempt?.evaluation.outcome).toBe("SOLVED");
	expect(searchingAttempt?.private_verification).toEqual({
		passed: 1,
		failed: 0,
	});
	expect(searchingAttempt?.artifacts).toHaveLength(2);
	expect(JSON.stringify(result)).not.toContain(
		createHash("sha256").update(secret).digest("hex"),
	);
	const persisted = await readFile(state, "utf8");
	const reloaded = await loadRun(state);
	expect(result.attempts[0]?.public_verification[1]).toMatchObject({
		stdout: "[REDACTED]",
		stderr: "[REDACTED]",
	});
	expectNoForbiddenSentinels(publicSurfaces(reloaded, persisted), [
		referenceSentinel,
		hiddenSentinel,
		hiddenPathSentinel,
		hostCredentialSentinel,
		secret,
	]);
	const html = toHtml(reloaded);
	expect(html).not.toContain("<script>HiddenTestSearchingAgent</script>");
	expect(html).toContain(
		"&lt;script&gt;HiddenTestSearchingAgent&lt;/script&gt;",
	);
});

it("uses argv execution in the local sandbox, truncates public output, and preserves odd filenames", async () => {
	const { root, head } = await fixture();
	const injectedPath = join(root, "argv-injected-marker");
	const oddNames = [
		"odd ; $(touch argv-injected-marker) [x].txt",
		"space name.txt",
		"tab\tname.txt",
		"line\nname.txt",
		"unicode-雪.txt",
		"-leading.txt",
		"<img src=x onerror=alert(1)>.txt",
	];
	const result = await runIsolatedAttempt({
		root,
		task: task(head),
		privateData: privateData(),
		sandbox: sandbox(),
		agentArgv: node(
			`const fs=require('fs'); fs.writeFileSync('subject.txt','fixed\\n'); for(const name of ${JSON.stringify(oddNames)}) fs.writeFileSync(name,'odd')`,
		),
	});
	expect(result.evaluation.outcome).toBe("SOLVED");
	expect(result.changed_files.map((file) => file.path)).toEqual(
		expect.arrayContaining(oddNames),
	);
	expect(existsSync(injectedPath)).toBe(false);
	const oddRun = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [{ task: task(head), private_data: privateData() }],
		agents: [
			{
				id: "odd-files",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "odd-files",
				argv: node(
					`const fs=require('fs'); fs.writeFileSync('subject.txt','fixed\\n'); for(const name of ${JSON.stringify(oddNames)}) fs.writeFileSync(name,'odd')`,
				),
			},
		],
		runs_per_task: 1,
		parallelism: 1,
		pricing: { version: "none", prices: [] },
		state_path: join(root, ".repoarena", "state", "odd-run.json"),
		runner_version: "test",
		sandbox_id: "local",
		sandbox_factory: () => sandbox(),
	});
	expect(oddRun.attempts[0]?.patch.files.map((file) => file.path)).toEqual(
		expect.arrayContaining(oddNames),
	);
	expect(toHtml(oddRun)).not.toContain("<img src=x onerror=alert(1)>");

	const noisyTask = taskSchema.parse({
		...task(head),
		verification: {
			required: [
				{
					id: "public",
					command: node(
						"process.stdout.write('x'.repeat(150000));process.stderr.write('y'.repeat(150000))",
					),
				},
			],
		},
	});
	const noisy = await runIsolatedAttempt({
		root,
		task: noisyTask,
		privateData: privateData(),
		sandbox: sandbox(),
		agentArgv: node("require('fs').writeFileSync('subject.txt','fixed\\n')"),
	});
	expect(noisy.public_verification[0]?.stdout).toContain("[output truncated]");
	expect(noisy.public_verification[0]?.stderr).toContain("[output truncated]");
	expect(noisy.public_verification[0]?.stdout.length).toBeLessThan(101_000);
	expect(noisy.public_verification[0]?.stderr.length).toBeLessThan(101_000);
	const noisyRun = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [{ task: noisyTask, private_data: privateData() }],
		agents: [
			{
				id: "HugeOutputAgent",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "huge-output",
				argv: node("require('fs').writeFileSync('subject.txt','fixed\\n')"),
			},
		],
		runs_per_task: 1,
		parallelism: 1,
		pricing: { version: "none", prices: [] },
		state_path: join(root, ".repoarena", "state", "noisy-run.json"),
		runner_version: "test",
		sandbox_id: "local",
		sandbox_factory: () => sandbox(),
	});
	expect(noisyRun.attempts[0]?.public_verification[0]?.truncated).toBe(true);
	expect(toJson(noisyRun).length).toBeLessThan(250_000);
});

it("reports genuine agent crashes and timeouts without running verification", async () => {
	const { root, head } = await fixture();
	const crashed = await runIsolatedAttempt({
		root,
		task: task(head),
		privateData: privateData(),
		sandbox: sandbox(),
		agentArgv: node("process.exit(23)"),
	});
	expect(crashed.evaluation.reason).toBe("AGENT_FAILED");
	expect(crashed.public_verification).toEqual([]);
	const timedOut = await runIsolatedAttempt({
		root,
		task: task(head, 1),
		privateData: privateData(),
		sandbox: sandbox(),
		agentArgv: node("setInterval(()=>{}, 1000)"),
	});
	expect(timedOut.evaluation.reason).toBe("AGENT_TIMEOUT");
	expect(timedOut.public_verification).toEqual([]);
	const persistedFailures = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [{ task: task(head, 1), private_data: privateData() }],
		agents: [
			{
				id: "CrashAgent",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "crash",
				argv: node("process.exit(23)"),
			},
			{
				id: "TimeoutAgent",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "timeout",
				argv: node("setInterval(()=>{},1000)"),
			},
		],
		runs_per_task: 1,
		parallelism: 2,
		pricing: { version: "none", prices: [] },
		state_path: join(root, ".repoarena", "state", "failure-run.json"),
		runner_version: "test",
		sandbox_id: "local",
		sandbox_factory: () => sandbox(),
	});
	expect(
		Object.fromEntries(
			persistedFailures.attempts.map((attempt) => [
				attempt.agent.id,
				[attempt.state, attempt.failure?.code],
			]),
		),
	).toEqual({
		CrashAgent: ["FAILED", "AGENT_FAILED"],
		TimeoutAgent: ["TIMED_OUT", "AGENT_TIMEOUT"],
	});
	for (const report of [
		toTerminal(persistedFailures),
		toJson(persistedFailures),
		toHtml(persistedFailures),
		toJunit(persistedFailures),
	])
		expect(report).toContain(persistedFailures.id);
});

it("detects verification tampering and rejects traversal or symlink artifact requests", async () => {
	const { root, head } = await fixture();
	const tampered = await runIsolatedAttempt({
		root,
		task: task(head),
		privateData: privateData(),
		sandbox: sandbox(),
		agentArgv: node(
			"require('fs').writeFileSync('subject.txt','fixed\\n'); require('fs').writeFileSync('package.json','{\\\"scripts\\\":{}}\\n')",
		),
	});
	expect(
		tampered.evaluation.integrity.map((finding) => finding.code),
	).toContain("VERIFICATION_TAMPERED");
	expect(tampered.evaluation).toMatchObject({
		outcome: "UNSOLVED",
		reason: "INTEGRITY_VIOLATION",
	});
	const tamperedRun = await runBenchmark({
		root,
		repository: { commit: head, remote: null },
		tasks: [{ task: task(head), private_data: privateData() }],
		agents: [
			{
				id: "VerificationTamperingAgent",
				version: "1",
				model: "fake",
				provider: "fake",
				config_hash: "tamper",
				argv: node(
					"require('fs').writeFileSync('subject.txt','fixed\\n'); require('fs').writeFileSync('package.json','{\\\"scripts\\\":{}}\\n')",
				),
			},
		],
		runs_per_task: 1,
		parallelism: 1,
		pricing: { version: "none", prices: [] },
		state_path: join(root, ".repoarena", "state", "tamper-run.json"),
		runner_version: "test",
		sandbox_id: "local",
		sandbox_factory: () => sandbox(),
	});
	expect(tamperedRun.attempts[0]?.evaluation).toMatchObject({
		outcome: "UNSOLVED",
		reason: "INTEGRITY_VIOLATION",
	});

	await expect(
		runIsolatedAttempt({
			root,
			task: task(head),
			privateData: privateData(),
			sandbox: sandbox(),
			agentArgv: node("require('fs').writeFileSync('subject.txt','fixed\\n')"),
			artifactRequests: [
				{ path: "../outside.txt", visibility: "PUBLIC", source: "agent" },
			],
		}),
	).rejects.toMatchObject({
		code: "EVALUATION_FAILED",
		message: "Unsafe artifact path.",
	});
	await expect(
		runIsolatedAttempt({
			root,
			task: task(head),
			privateData: privateData(),
			sandbox: sandbox(),
			agentArgv: node(
				"const fs=require('fs'); fs.writeFileSync('subject.txt','fixed\\n'); fs.symlinkSync(process.execPath,'artifact-link')",
			),
			artifactRequests: [
				{ path: "artifact-link", visibility: "PUBLIC", source: "agent" },
			],
		}),
	).rejects.toMatchObject({
		code: "EVALUATION_FAILED",
		message: "Artifact must be a regular non-symlink file.",
	});
});
