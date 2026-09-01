import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

process.env.REPOARENA_ACTION_TEST_IMPORT = "1";
const { runAction } = await import("./index.js");

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const fixture = async (statistics: Record<string, unknown> = {}) => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-action-"));
	directories.push(root);
	const output = join(root, "github-output");
	const summary = join(root, "github-summary");
	await writeFile(output, "", "utf8");
	await writeFile(summary, "", "utf8");
	const calls: { executable: string; args: string[] }[] = [];
	const spawn = async (
		executable: string,
		args: string[],
		_cwd?: string,
		_environment?: NodeJS.ProcessEnv,
		_timeoutMs?: number,
	) => {
		calls.push({ executable, args });
		await mkdir(join(root, ".repoarena", "state", "runs"), { recursive: true });
		await writeFile(
			join(root, ".repoarena", "state", "runs", "latest.json"),
			JSON.stringify({
				id: "run-local",
				statistics: {
					solved_count: 1,
					attempt_count: 2,
					success_rate: 0.5,
					total_cost_micros: 125,
					...statistics,
				},
			}),
			"utf8",
		);
		return { code: 0, stdout: "benchmark complete\n", stderr: "" };
	};
	return { root, output, summary, calls, spawn };
};

it("invokes the real CLI contract and emits bounded canonical outputs", async () => {
	const value = await fixture();
	await runAction(
		{
			GITHUB_WORKSPACE: value.root,
			GITHUB_OUTPUT: value.output,
			GITHUB_STEP_SUMMARY: value.summary,
			REPOARENA_CLI_PATH: "/repoarena/bin",
			INPUT_AGENTS: "perfect,wrong",
			"INPUT_RUNS-PER-TASK": "2",
			INPUT_PARALLELISM: "2",
			"INPUT_MAX-ATTEMPTS": "4",
			"INPUT_MAX-COST-MICROS": "200",
			"INPUT_FAIL-ON-UNSOLVED": "false",
		},
		value.spawn,
	);
	expect(value.calls).toHaveLength(1);
	expect(value.calls[0]).toMatchObject({ executable: "/repoarena/bin" });
	expect(value.calls[0]?.args).toEqual(
		expect.arrayContaining([
			"run",
			"--agent",
			"perfect",
			"--agent",
			"wrong",
			"--runs-per-task",
			"2",
			"--parallel",
			"2",
		]),
	);
	const outputs = await readFile(value.output, "utf8");
	expect(outputs).toContain("run-id=run-local");
	expect(outputs).toContain("attempt-count=2");
	expect(await readFile(value.summary, "utf8")).toContain("Solved **1/2**");
});

it("fails safely for traversal, unpriced cost ceilings, and unsolved CI outcomes", async () => {
	const traversal = await fixture();
	await expect(
		runAction(
			{
				GITHUB_WORKSPACE: traversal.root,
				INPUT_AGENTS: "perfect",
				INPUT_OUTPUT: "../escape",
			},
			traversal.spawn,
		),
	).rejects.toThrow("inside GITHUB_WORKSPACE");
	const unpriced = await fixture({ total_cost_micros: null });
	await expect(
		runAction(
			{
				GITHUB_WORKSPACE: unpriced.root,
				INPUT_AGENTS: "perfect",
				"INPUT_MAX-COST-MICROS": "1",
			},
			unpriced.spawn,
		),
	).rejects.toThrow("cost is unavailable");
	const failed = await fixture();
	await expect(
		runAction(
			{ GITHUB_WORKSPACE: failed.root, INPUT_AGENTS: "wrong" },
			async (...args) => ({ ...(await failed.spawn(...args)), code: 1 }),
		),
	).rejects.toThrow("unsolved attempts");
});

it("publishes through a scoped credential without exposing it in outputs", async () => {
	const value = await fixture();
	const requests: Request[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request);
			return new Response(JSON.stringify({ data: { replay: false } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	);
	const secret = "repoarena-action-secret-sentinel";
	await runAction(
		{
			GITHUB_WORKSPACE: value.root,
			GITHUB_OUTPUT: value.output,
			INPUT_AGENTS: "perfect",
			"INPUT_PUBLISH-CLOUD": "true",
			"INPUT_CLOUD-ENDPOINT": "https://cloud.example",
			"INPUT_CLOUD-RUN-ID": "cloud-run",
			REPOARENA_CLOUD_API_KEY: secret,
		},
		value.spawn,
	);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${secret}`);
	expect(await readFile(value.output, "utf8")).not.toContain(secret);
});
