import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.REPOARENA_REAL_AGENT_TESTS !== "1")
	throw new Error(
		"Set REPOARENA_REAL_AGENT_TESTS=1 for the opt-in paid-agent smoke",
	);
if (process.env.REPOARENA_TEST_AGENT !== "codex")
	throw new Error(
		"This bounded release smoke requires REPOARENA_TEST_AGENT=codex",
	);
if (process.env.REPOARENA_AGENT_SMOKE_ACKNOWLEDGE_COST !== "yes")
	throw new Error("Set REPOARENA_AGENT_SMOKE_ACKNOWLEDGE_COST=yes");

const root = resolve(new URL("..", import.meta.url).pathname);
const tarball = join(root, "release-artifacts", "repoarena-1.0.0.tgz");
const workspace = await mkdtemp(join(tmpdir(), "repoarena-codex-live-"));
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
	if (
		/^(DATABASE_URL|STRIPE_|GITHUB_|S3_|AWS_|HOSTED_|REPOARENA_CLOUD)/.test(
			name,
		) ||
		name === "OPENAI_API_KEY" ||
		name === "CODEX_API_KEY" ||
		name === "REPOARENA_TEST_ADAPTERS" ||
		name === "NODE_ENV"
	)
		delete environment[name];
}
const run = (command, args, options = {}) =>
	execFileSync(command, args, {
		cwd: workspace,
		env: environment,
		encoding: "utf8",
		maxBuffer: 4_000_000,
		...options,
	});

try {
	run("npm", ["init", "-y"]);
	await writeFile(
		join(workspace, ".gitignore"),
		"node_modules/\n.repoarena/state/\n",
	);
	run("npm", ["install", "--ignore-scripts", tarball]);
	run("git", ["init", "-q"]);
	run("git", ["config", "user.email", "smoke@example.invalid"]);
	run("git", ["config", "user.name", "RepoArena Smoke"]);
	await writeFile(
		join(workspace, "sum.js"),
		"export const add = (left, right) => left - right;\n",
	);
	await writeFile(
		join(workspace, "sum.test.mjs"),
		"import assert from 'node:assert/strict';\nimport { add } from './sum.js';\nassert.equal(add(2, 3), 5);\n",
	);
	await writeFile(
		join(workspace, "package.json"),
		`${JSON.stringify({ name: "repoarena-codex-smoke", private: true, type: "module" }, null, "\t")}\n`,
	);
	run("git", ["add", ".gitignore", "package.json", "sum.js", "sum.test.mjs"]);
	run("git", ["commit", "-qm", "add tiny arithmetic regression"]);
	const baseCommit = run("git", ["rev-parse", "HEAD"]).trim();
	const cli = join(workspace, "node_modules", ".bin", "repoarena");
	const packagedVersion = run(cli, ["--version"]).trim();
	const detection = JSON.parse(run(cli, ["agents", "detect", "--json"]));
	const inspection = JSON.parse(
		run(cli, ["agents", "inspect", "codex", "--json"]),
	);
	let authReady = false;
	try {
		authReady = run("codex", ["login", "status"]).includes("Logged in");
	} catch {
		authReady = false;
	}
	if (!authReady) {
		process.stdout.write(
			`${JSON.stringify({ packagedVersion, detection, inspection, authReady }, null, "\t")}\nLIVE_SMOKE_NOT_EXECUTED_AUTH_UNAVAILABLE\n`,
		);
		process.exit(3);
	}
	run(cli, ["init", "--yes"]);
	const privateSentinel = `repoarena-private-${randomUUID()}`;
	const referenceSentinel = `repoarena-reference-${randomUUID()}`;
	await mkdir(join(workspace, ".repoarena", "tasks"), { recursive: true });
	await mkdir(join(workspace, ".repoarena", "state", "private"), {
		recursive: true,
	});
	await writeFile(
		join(workspace, ".repoarena", "tasks", "codex-live-smoke.json"),
		`${JSON.stringify(
			{
				schema: "repoarena.task/v1",
				id: "codex-live-smoke",
				title: "Correct integer addition",
				prompt:
					"Fix the add function in sum.js so the existing test passes. Make only the necessary source change.",
				source: { type: "curated", base_commit: baseCommit },
				execution: { timeout_seconds: 120 },
				verification: {
					required: [
						{
							id: "public-node-test",
							command: [process.execPath, "sum.test.mjs"],
							timeout_seconds: 15,
						},
					],
				},
				constraints: { max_patch_bytes: 50_000 },
				provenance: {
					created_at: "2026-09-11T00:00:00.000Z",
					updated_at: "2026-09-11T00:00:00.000Z",
					created_by: "codex-live-smoke",
				},
			},
			null,
			"\t",
		)}\n`,
	);
	await writeFile(
		join(workspace, ".repoarena", "state", "private", "codex-live-smoke.json"),
		`${JSON.stringify(
			{
				task_id: "codex-live-smoke",
				reference_commit: null,
				reference_patch: referenceSentinel,
				hidden_hook_source: `// ${privateSentinel}\nimport assert from 'node:assert/strict';\nimport { add } from './sum.js';\nassert.equal(add(-4, 9), 5);\n`,
				private_notes: [],
			},
			null,
			"\t",
		)}\n`,
		{ mode: 0o600 },
	);

	const terminal = run(cli, [
		"run",
		"--agent",
		"codex",
		"--tasks",
		"codex-live-smoke",
		"--runs-per-task",
		"1",
		"--parallel",
		"1",
		"--sandbox",
		"local",
		"--report",
		"terminal,json,html,junit",
		"--output",
		".repoarena/reports",
	]);
	const runResult = JSON.parse(
		await readFile(
			join(workspace, ".repoarena", "state", "runs", "latest.json"),
			"utf8",
		),
	);
	const reportNames = (
		await readdir(join(workspace, ".repoarena", "reports"))
	).sort();
	const publicText = [terminal, JSON.stringify(runResult)];
	for (const name of reportNames)
		publicText.push(
			await readFile(join(workspace, ".repoarena", "reports", name), "utf8"),
		);
	for (const forbidden of [privateSentinel, referenceSentinel])
		if (publicText.some((value) => value.includes(forbidden)))
			throw new Error(
				"Private evaluator or reference material reached public output",
			);
	if (runResult.statistics.attempt_count !== 1)
		throw new Error("Live smoke created more than one statistical attempt");
	if (runResult.attempts[0]?.agent?.id !== "codex")
		throw new Error("Live smoke did not use the production Codex adapter");

	const child = spawn(cli, ["ui", "--port", "0"], {
		cwd: workspace,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const address = await new Promise((resolveAddress, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Packaged live-smoke UI did not start")),
			10_000,
		);
		child.stdout.on("data", (chunk) => {
			const match = String(chunk).match(/http:\/\/[^\s]+/);
			if (match) {
				clearTimeout(timer);
				resolveAddress(match[0]);
			}
		});
		child.once("exit", (code) =>
			reject(new Error(`Packaged live-smoke UI exited ${code}`)),
		);
	});
	const [page, runs] = await Promise.all([
		fetch(address).then((response) => response.text()),
		fetch(`${address}/api/v1/runs?limit=1`).then((response) => response.text()),
	]);
	child.kill("SIGTERM");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
	if (!page.includes("RepoArena") || !runs.includes("codex"))
		throw new Error("Packaged UI did not render the real Codex run");
	if ([page, runs].some((value) => value.includes(privateSentinel)))
		throw new Error("Private evaluator material reached the local UI");

	const attempt = runResult.attempts[0];
	process.stdout.write(
		`${JSON.stringify(
			{
				workspace,
				packagedVersion,
				detection,
				inspection,
				authReady,
				attemptId: attempt.id,
				outcome: attempt.evaluation.outcome,
				exitCode: attempt.agent_execution?.exit_code ?? null,
				timedOut: attempt.agent_execution?.timed_out ?? false,
				patch: {
					filesChanged: attempt.patch.files_changed,
					paths: attempt.patch.files.map((file) => file.path),
				},
				publicVerification: attempt.public_verification.map((item) => ({
					id: item.id,
					passed: item.passed,
				})),
				privateVerification: attempt.private_verification,
				integrityCount: attempt.integrity.length,
				regressionCount: attempt.regressions.length,
				usage: attempt.usage,
				cost: attempt.cost,
				reports: reportNames,
				ui: "verified",
				privateBoundary: "verified",
			},
			null,
			"\t",
		)}\nLIVE_ADAPTER_VERIFIED_${attempt.evaluation.outcome === "SOLVED" ? "SOLVED" : "UNSOLVED"}\n`,
	);
} catch (error) {
	process.stderr.write(
		`Live smoke workspace retained for sanitized diagnosis: ${workspace}\n`,
	);
	throw error;
}
