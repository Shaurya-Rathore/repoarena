import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CloudApiClient } from "@repoarena/cloud-api-client";

type SpawnResult = { code: number; stdout: string; stderr: string };
type ActionEnvironment = NodeJS.ProcessEnv;
const input = (environment: ActionEnvironment, name: string, fallback = "") =>
	environment[`INPUT_${name.toUpperCase()}`] ?? fallback;
const integer = (
	value: string,
	name: string,
	minimum: number,
	maximum: number,
) => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
		throw new Error(`${name} is invalid.`);
	return parsed;
};
const boolean = (value: string, name: string) => {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false.`);
};
const emit = async (
	path: string | undefined,
	name: string,
	value: string | number,
) => {
	if (!path) return;
	const safe = String(value)
		.replace(/[\r\n]/g, " ")
		.slice(0, 8_000);
	await appendFile(path, `${name}=${safe}\n`, { encoding: "utf8" });
};
const execute = (
	executable: string,
	args: string[],
	cwd: string,
	environment: ActionEnvironment,
	timeoutMs: number,
): Promise<SpawnResult> =>
	new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const append = (current: string, chunk: Buffer) =>
			`${current}${chunk}`.slice(-1_000_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
		}, timeoutMs);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 2, stdout, stderr });
		});
	});

const oidcCredential = async (
	environment: ActionEnvironment,
	endpoint: string,
	audience: string,
) => {
	if (environment.REPOARENA_CLOUD_API_KEY)
		return environment.REPOARENA_CLOUD_API_KEY;
	const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
	const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!requestUrl || !requestToken)
		throw new Error(
			"Cloud publication requires GitHub OIDC or REPOARENA_CLOUD_API_KEY.",
		);
	const url = new URL(requestUrl);
	url.searchParams.set("audience", audience);
	const oidcResponse = await fetch(url, {
		headers: { authorization: `Bearer ${requestToken}` },
	});
	if (!oidcResponse.ok) throw new Error("GitHub OIDC token request failed.");
	const oidc = (await oidcResponse.json()) as { value?: string };
	if (!oidc.value) throw new Error("GitHub OIDC token response is invalid.");
	const exchange = await fetch(
		new URL("/api/v1/github/actions/oidc/exchange", endpoint),
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: oidc.value, audience }),
		},
	);
	if (!exchange.ok) throw new Error("RepoArena Cloud OIDC exchange failed.");
	const body = (await exchange.json()) as { data?: { token?: string } };
	if (!body.data?.token)
		throw new Error("RepoArena Cloud credential response is invalid.");
	return body.data.token;
};

export async function runAction(
	environment: ActionEnvironment = process.env,
	spawnProcess = execute,
): Promise<void> {
	const cwd = resolve(environment.GITHUB_WORKSPACE ?? process.cwd());
	const agents = input(environment, "agents")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (!agents.length) throw new Error("agents is required.");
	const repetitions = integer(
		input(environment, "runs-per-task", "1"),
		"runs-per-task",
		1,
		100,
	);
	const parallel = integer(
		input(environment, "parallelism", "1"),
		"parallelism",
		1,
		100,
	);
	const maxAttempts = integer(
		input(environment, "max-attempts", "100"),
		"max-attempts",
		1,
		10_000,
	);
	if (agents.length * repetitions > maxAttempts)
		throw new Error("Configured agent repetitions exceed max-attempts.");
	const maxDuration = integer(
		input(environment, "max-duration-ms", "3600000"),
		"max-duration-ms",
		1_000,
		86_400_000,
	);
	const maxCost = input(environment, "max-cost-micros");
	const outputDirectory = resolve(
		cwd,
		input(environment, "output", ".repoarena/reports"),
	);
	const outputRelative = relative(cwd, outputDirectory);
	if (
		isAbsolute(outputRelative) ||
		outputRelative === ".." ||
		outputRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	)
		throw new Error("output must remain inside GITHUB_WORKSPACE.");
	const cli = environment.REPOARENA_CLI_PATH ?? "repoarena";
	const args = ["run"];
	for (const agent of agents) args.push("--agent", agent);
	args.push(
		"--runs-per-task",
		String(repetitions),
		"--parallel",
		String(parallel),
		"--sandbox",
		input(environment, "sandbox", "local"),
		"--report",
		input(environment, "reports", "terminal,json,html,junit"),
		"--output",
		outputDirectory,
		"--json",
	);
	const tasks = input(environment, "tasks");
	if (tasks) args.push("--tasks", tasks);
	if (
		boolean(input(environment, "fail-on-unsolved", "true"), "fail-on-unsolved")
	)
		args.push("--fail-on-unsolved");
	const result = await spawnProcess(cli, args, cwd, environment, maxDuration);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr)
		process.stderr.write(
			result.stderr.replaceAll(
				environment.REPOARENA_CLOUD_API_KEY ?? "\0",
				"[REDACTED]",
			),
		);
	const run = JSON.parse(
		await readFile(
			join(cwd, ".repoarena", "state", "runs", "latest.json"),
			"utf8",
		),
	) as {
		id: string;
		statistics: {
			solved_count: number;
			attempt_count: number;
			success_rate: number;
			total_cost_micros: number | null;
		};
	};
	if (maxCost) {
		const ceiling = integer(
			maxCost,
			"max-cost-micros",
			1,
			Number.MAX_SAFE_INTEGER,
		);
		if (run.statistics.total_cost_micros === null)
			throw new Error(
				"Cost ceiling cannot be enforced because benchmark cost is unavailable.",
			);
		if (run.statistics.total_cost_micros > ceiling)
			throw new Error("Benchmark exceeded max-cost-micros.");
	}
	await emit(environment.GITHUB_OUTPUT, "run-id", run.id);
	await emit(
		environment.GITHUB_OUTPUT,
		"solved-count",
		run.statistics.solved_count,
	);
	await emit(
		environment.GITHUB_OUTPUT,
		"attempt-count",
		run.statistics.attempt_count,
	);
	await emit(
		environment.GITHUB_OUTPUT,
		"success-rate",
		run.statistics.success_rate,
	);
	await emit(environment.GITHUB_OUTPUT, "report-path", outputDirectory);
	if (environment.GITHUB_STEP_SUMMARY)
		await appendFile(
			environment.GITHUB_STEP_SUMMARY,
			`## RepoArena\n\nSolved **${run.statistics.solved_count}/${run.statistics.attempt_count}** attempts.\n`,
			"utf8",
		);
	if (boolean(input(environment, "publish-cloud", "false"), "publish-cloud")) {
		const endpoint = input(environment, "cloud-endpoint");
		const cloudRunId = input(environment, "cloud-run-id");
		if (!endpoint || !cloudRunId)
			throw new Error(
				"Cloud publication requires cloud-endpoint and cloud-run-id.",
			);
		const credential = await oidcCredential(
			environment,
			endpoint,
			input(environment, "oidc-audience", "repoarena-cloud"),
		);
		await new CloudApiClient(endpoint, credential).request(
			`/api/v1/github/actions/runs/${encodeURIComponent(cloudRunId)}/result`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ result: run }),
			},
		);
		await emit(environment.GITHUB_OUTPUT, "cloud-run-id", cloudRunId);
	}
	if (result.code !== 0)
		throw new Error(
			result.code === 1
				? "RepoArena benchmark contains unsolved attempts."
				: "RepoArena benchmark execution failed.",
		);
}

if (process.env.REPOARENA_ACTION_TEST_IMPORT !== "1")
	runAction().catch((error) => {
		process.stderr.write(
			`RepoArena Action failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
