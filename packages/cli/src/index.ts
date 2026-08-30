#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { ClaudeCodeAdapter } from "@repoarena/adapter-claude-code";
import { CodexAdapter } from "@repoarena/adapter-codex";
import { GeminiCliAdapter } from "@repoarena/adapter-gemini-cli";
import { OpenCodeAdapter } from "@repoarena/adapter-opencode";
import type { AgentAdapter } from "@repoarena/adapter-sdk";
import { runBenchmark, type BenchmarkAgent } from "@repoarena/benchmark-engine";
import { loadConfig } from "@repoarena/config";
import { RepoArenaError } from "@repoarena/core";
import { GitRepository } from "@repoarena/git";
import { assessRepository } from "@repoarena/readiness";
import { toHtml, toJson, toJunit, toTerminal } from "@repoarena/reporter";
import { loadRun, writeRunAtomic } from "@repoarena/run-store";
import type { EvaluatorPrivateTaskData } from "@repoarena/task-spec";
import { taskSchema } from "@repoarena/task-spec";
import { discover } from "@repoarena/task-discovery";
import { reconstructHistoricalTask } from "@repoarena/task-reconstruction";
import { validateHistoricalTask } from "@repoarena/task-validation";
import { parse, stringify } from "yaml";

const root = process.cwd();
const output = (value: unknown, json = false): void => {
	process.stdout.write(
		json
			? `${JSON.stringify(value)}\n`
			: `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`,
	);
};
const taskDir = () => join(root, ".repoarena", "tasks");
const adapters: Record<string, AgentAdapter> = {
	codex: new CodexAdapter(),
	"claude-code": new ClaudeCodeAdapter(),
	"gemini-cli": new GeminiCliAdapter(),
	opencode: new OpenCodeAdapter(),
};
const collect = (value: string, previous: string[]): string[] => [
	...previous,
	value,
];
async function paths(): Promise<string[]> {
	try {
		return (await readdir(taskDir()))
			.filter((file) => /\.(json|ya?ml)$/i.test(file))
			.map((file) => join(taskDir(), file));
	} catch {
		return [];
	}
}
async function taskFromPath(path: string) {
	const raw = await readFile(path, "utf8");
	return taskSchema.parse(
		path.endsWith(".json") ? JSON.parse(raw) : parse(raw),
	);
}
async function ensureGit(): Promise<void> {
	try {
		await stat(join(root, ".git"));
	} catch {
		throw new RepoArenaError(
			"REPOSITORY_NOT_FOUND",
			"Run this command inside a Git repository.",
		);
	}
}

const program = new Command()
	.name("repoarena")
	.description("Local-first coding-agent benchmarks")
	.version("0.1.0");
program
	.command("init")
	.option("--yes", "non-interactive confirmation")
	.option("--json", "emit JSON")
	.action(async (options) => {
		await ensureGit();
		const directory = join(root, ".repoarena");
		await mkdir(join(directory, "tasks"), { recursive: true });
		await mkdir(join(directory, "state", "artifacts"), { recursive: true });
		const configPath = join(directory, "config.yaml");
		let created = false;
		try {
			await stat(configPath);
		} catch {
			await writeFile(
				configPath,
				stringify({
					schema: "repoarena.config/v1",
					benchmark: { name: "default", tasks_dir: ".repoarena/tasks" },
					runner: { backend: "local", timeout_seconds: 900, network: "none" },
				}),
			);
			created = true;
		}
		output(
			{
				config: created ? "created" : "unchanged",
				paths: [configPath, join(directory, "tasks"), join(directory, "state")],
			},
			options.json,
		);
	});
program
	.command("doctor")
	.option("--deep")
	.option("--json")
	.action(async (options) =>
		output(await assessRepository(root), options.json),
	);
const tasks = program.command("tasks").description("Manage benchmark tasks");
tasks
	.command("list")
	.option("--json")
	.action(async (options) => {
		const values = await Promise.all(
			(await paths()).map(async (path) => {
				const task = await taskFromPath(path);
				return { id: task.id, title: task.title, path };
			}),
		);
		output(values, options.json);
	});
tasks
	.command("discover")
	.option("--limit <count>", "maximum candidates", "50")
	.option("--json")
	.action(async (options) => {
		await ensureGit();
		const candidates = await discover(new GitRepository(root), {
			limit: Number(options.limit),
		});
		output(candidates, options.json);
	});
tasks
	.command("generate <candidate>")
	.option("--json")
	.action(async (candidate, options) => {
		await ensureGit();
		const result = await reconstructHistoricalTask(
			new GitRepository(root),
			candidate,
		);
		await mkdir(taskDir(), { recursive: true });
		await mkdir(join(root, ".repoarena", "state", "private"), {
			recursive: true,
		});
		const path = join(taskDir(), `${result.task.id}.yaml`);
		await writeFile(path, stringify(result.task));
		await writeFile(
			join(root, ".repoarena", "state", "private", `${result.task.id}.json`),
			JSON.stringify(result.privateData),
		);
		output(
			{
				task: path,
				leakage_safe: result.leakageSafe,
				diagnostics: result.diagnostics,
			},
			options.json,
		);
		if (!result.leakageSafe) process.exitCode = 7;
	});
tasks
	.command("inspect <id>")
	.option("--json")
	.action(async (id, options) => {
		const found = (await paths()).find(
			(path) =>
				path.endsWith(`/${id}.yaml`) ||
				path.endsWith(`/${id}.yml`) ||
				path.endsWith(`/${id}.json`),
		);
		if (!found)
			throw new RepoArenaError("TASK_INVALID", `Task ${id} was not found.`);
		output(await taskFromPath(found), options.json);
	});
tasks
	.command("format <id>")
	.option("--json")
	.action(async (id, options) => {
		const found = (await paths()).find(
			(path) =>
				path.endsWith(`/${id}.yaml`) ||
				path.endsWith(`/${id}.yml`) ||
				path.endsWith(`/${id}.json`),
		);
		if (!found)
			throw new RepoArenaError("TASK_INVALID", `Task ${id} was not found.`);
		const task = await taskFromPath(found);
		await writeFile(found, stringify(task));
		output({ formatted: found }, options.json);
	});
tasks
	.command("migrate <input>")
	.option("--output <path>")
	.option("--json")
	.action(async (input, options) => {
		const { parseTaskDocument, serializeTask } = await import(
			"@repoarena/task-spec"
		);
		const text = await readFile(resolve(root, input), "utf8");
		const migrated = parseTaskDocument(
			text,
			input.endsWith(".json") ? "json" : "yaml",
		);
		const target = resolve(root, options.output ?? input);
		await writeFile(target, serializeTask(migrated.task));
		output(
			{ migrated: target, diagnostics: migrated.diagnostics },
			options.json,
		);
	});
tasks
	.command("import <input>")
	.option("--json")
	.action(async (input, options) => {
		const { parseTaskDocument, serializeTask } = await import(
			"@repoarena/task-spec"
		);
		const absolute = resolve(root, input);
		const migrated = parseTaskDocument(
			await readFile(absolute, "utf8"),
			absolute.endsWith(".json") ? "json" : "yaml",
		);
		await mkdir(taskDir(), { recursive: true });
		const target = join(taskDir(), `${migrated.task.id}.yaml`);
		try {
			await stat(target);
			throw new RepoArenaError(
				"TASK_INVALID",
				`Task ${migrated.task.id} already exists.`,
			);
		} catch (error) {
			if (error instanceof RepoArenaError) throw error;
		}
		await writeFile(target, serializeTask(migrated.task));
		output(
			{ imported: target, diagnostics: migrated.diagnostics },
			options.json,
		);
	});
tasks
	.command("export <id>")
	.requiredOption("--output <path>")
	.option("--json")
	.action(async (id, options) => {
		const found = (await paths()).find(
			(path) =>
				path.endsWith(`/${id}.yaml`) ||
				path.endsWith(`/${id}.yml`) ||
				path.endsWith(`/${id}.json`),
		);
		if (!found)
			throw new RepoArenaError("TASK_INVALID", `Task ${id} was not found.`);
		const target = resolve(root, options.output);
		if (!target.startsWith(`${root}/`))
			throw new RepoArenaError(
				"TASK_INVALID",
				"Export path must remain inside the repository.",
			);
		await writeFile(target, stringify(await taskFromPath(found)));
		output({ exported: target }, options.json);
	});
tasks
	.command("validate-history <id>")
	.option("--json")
	.action(async (id, options) => {
		await ensureGit();
		const found = (await paths()).find(
			(path) =>
				path.endsWith(`/${id}.yaml`) ||
				path.endsWith(`/${id}.yml`) ||
				path.endsWith(`/${id}.json`),
		);
		if (!found)
			throw new RepoArenaError("TASK_INVALID", `Task ${id} was not found.`);
		const task = await taskFromPath(found);
		const privatePath = join(
			root,
			".repoarena",
			"state",
			"private",
			`${id}.json`,
		);
		const result = await validateHistoricalTask(
			new GitRepository(root),
			task,
			JSON.parse(await readFile(privatePath, "utf8")),
		);
		output(result, options.json);
		if (result.status !== "READY")
			process.exitCode = result.status === "BLOCKED" ? 6 : 7;
	});
tasks
	.command("validate [ids...]")
	.option("--all")
	.option("--json")
	.action(async (ids: string[], options) => {
		await ensureGit();
		const values = await Promise.all(
			(await paths()).map(async (path) => {
				try {
					const task = await taskFromPath(path);
					const selected =
						options.all || ids.length === 0 || ids.includes(task.id);
					return { id: task.id, valid: selected, errors: [] as string[] };
				} catch (error) {
					return {
						id: path,
						valid: false,
						errors: [error instanceof Error ? error.message : String(error)],
					};
				}
			}),
		);
		const result = values.filter(
			(value) => options.all || ids.length === 0 || ids.includes(value.id),
		);
		output(result, options.json);
		if (result.some((item) => !item.valid)) process.exitCode = 2;
	});
tasks
	.command("new <id>")
	.requiredOption("--title <title>")
	.requiredOption("--prompt <prompt>")
	.requiredOption("--verify <command>")
	.option("--json")
	.action(async (id, options) => {
		await ensureGit();
		await mkdir(taskDir(), { recursive: true });
		const baseCommit = (
			(await (
				await import("node:child_process")
			).execFileSync?.("git", ["rev-parse", "HEAD"], {
				cwd: root,
				encoding: "utf8",
			})) ?? ""
		).trim();
		const task = taskSchema.parse({
			schema: "repoarena.task/v1",
			id,
			title: options.title,
			prompt: options.prompt,
			base_commit: baseCommit,
			verification: { required: [{ command: options.verify }] },
		});
		const path = join(taskDir(), `${id}.yaml`);
		await writeFile(path, stringify(task));
		output({ created: path }, options.json);
	});
program
	.command("agents")
	.description("Inspect coding-agent adapters")
	.argument("[action]", "list, detect, or inspect", "list")
	.argument("[name]", "adapter name")
	.option("--json")
	.action(async (action, name, options) => {
		if (!["list", "detect", "inspect"].includes(action))
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"agents action must be list, detect, or inspect",
			);
		const names = name ? [name] : Object.keys(adapters).sort();
		const values = [];
		for (const id of names) {
			const adapter = adapters[id];
			if (!adapter)
				throw new RepoArenaError("CONFIG_INVALID", `Unknown agent ${id}.`);
			const detection = await adapter.detect();
			values.push({
				id,
				...detection,
				capabilities: {
					noninteractive: true,
					usage: "provider-dependent",
					models: "provider-dependent",
				},
			});
		}
		output(action === "inspect" ? values[0] : values, options.json);
	});
program
	.command("run")
	.option("--tasks <ids>", "comma-separated task IDs")
	.option(
		"--agent <name>",
		"adapter to execute; repeat for multiple agents",
		collect,
		[],
	)
	.option("--agent-command <executable>", "argv-safe custom agent executable")
	.option(
		"--agent-arg <value>",
		"custom executable argument; repeat as needed",
		collect,
		[],
	)
	.option("--runs-per-task <count>", "clean repetitions per task", "1")
	.option("--parallel <count>", "maximum concurrent attempts", "1")
	.option("--model <model>", "model requested from each adapter")
	.option(
		"--report <formats>",
		"comma-separated terminal,json,html,junit",
		"terminal",
	)
	.option(
		"--output <directory>",
		"report output directory",
		".repoarena/reports",
	)
	.option("--json")
	.action(async (options) => {
		await ensureGit();
		await loadConfig(root);
		const selected = options.tasks
			? new Set((options.tasks as string).split(","))
			: undefined;
		const files = await paths();
		const taskPlans = [];
		for (const path of files) {
			const task = await taskFromPath(path);
			if (selected && !selected.has(task.id)) continue;
			let privateData: EvaluatorPrivateTaskData = {
				task_id: task.id,
				reference_commit: null,
				reference_patch: null,
				hidden_hook_source: null,
				private_notes: [],
			};
			try {
				privateData = JSON.parse(
					await readFile(
						join(root, ".repoarena", "state", "private", `${task.id}.json`),
						"utf8",
					),
				) as EvaluatorPrivateTaskData;
			} catch {
				/* imported tasks may have no private evaluator */
			}
			taskPlans.push({
				task,
				private_data: privateData,
				...(privateData.hidden_hook_source
					? {
							private_verifier: async (workspace: string) => {
								const hook = join(workspace, ".repoarena-private-hook.mjs");
								await writeFile(hook, privateData.hidden_hook_source ?? "", {
									mode: 0o600,
								});
								return [[process.execPath, hook]];
							},
						}
					: {}),
			});
		}
		const requested = options.agent as string[];
		const plans: BenchmarkAgent[] = [];
		if (options.agentCommand)
			plans.push({
				id: "command",
				version: null,
				model: null,
				provider: "unknown",
				config_hash: "command",
				argv: [options.agentCommand, ...(options.agentArg as string[])],
			});
		for (const name of requested) {
			const adapter = adapters[name];
			if (!adapter)
				throw new RepoArenaError("CONFIG_INVALID", `Unknown agent ${name}.`);
			const detection = await adapter.detect();
			if (!detection.available)
				throw new RepoArenaError("ATTEMPT_FAILED", `${name} is unavailable.`);
			plans.push({
				id: name,
				version: detection.version,
				model: options.model ?? null,
				provider: name,
				config_hash: JSON.stringify({ name, model: options.model ?? null }),
				execute: async (workspace, task) => {
					const started = performance.now();
					const result = await adapter.run({
						cwd: workspace,
						prompt: task.prompt,
						model: options.model,
						timeout_seconds: task.execution.timeout_seconds,
						env: {},
					});
					return {
						command: JSON.stringify([name]),
						exit_code: result.exit_code,
						duration_ms: Math.round(performance.now() - started),
						stdout: result.stdout,
						stderr: result.stderr,
						timed_out: result.timed_out,
					};
				},
			});
		}
		if (!plans.length)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Select --agent or --agent-command.",
			);
		const identity = await new GitRepository(root).identity();
		const statePath = join(root, ".repoarena", "state", "runs", "latest.json");
		const run = await runBenchmark({
			root,
			repository: { commit: identity.head, remote: identity.remote },
			tasks: taskPlans,
			agents: plans,
			runs_per_task: Number(options.runsPerTask),
			parallelism: Number(options.parallel),
			pricing: { version: "unpriced", prices: [] },
			state_path: statePath,
			runner_version: "0.1.0",
		});
		await writeRunAtomic(
			join(root, ".repoarena", "state", "runs", `${run.id}.json`),
			run,
		);
		const formats = new Set(String(options.report).split(","));
		const directory = resolve(root, options.output);
		await mkdir(directory, { recursive: true });
		if (formats.has("json"))
			await writeFile(join(directory, `${run.id}.json`), toJson(run));
		if (formats.has("html"))
			await writeFile(join(directory, `${run.id}.html`), toHtml(run));
		if (formats.has("junit"))
			await writeFile(join(directory, `${run.id}.xml`), toJunit(run));
		if (formats.has("terminal") && !options.json) output(toTerminal(run));
		else output(run, true);
		if (run.statistics.solved_count !== run.statistics.attempt_count)
			process.exitCode = 1;
	});
program
	.command("export <runId>")
	.requiredOption("--format <format>", "json, html, junit, or terminal")
	.option("--output <path>")
	.action(async (runId, options) => {
		const result = await loadRun(
			join(root, ".repoarena", "state", "runs", `${runId}.json`),
		);
		const renderers: Record<string, (run: typeof result) => string> = {
			json: toJson,
			html: toHtml,
			junit: toJunit,
			terminal: toTerminal,
		};
		const renderer = renderers[options.format];
		if (!renderer)
			throw new RepoArenaError("CONFIG_INVALID", "format must be json or html");
		const data = renderer(result);
		const path = resolve(root, options.output ?? `${runId}.${options.format}`);
		await writeFile(path, data);
		output({ exported: path });
	});
program
	.command("ui")
	.option("--port <port>", "port", "4177")
	.action(async (options) => {
		const port = Number(options.port);
		const server = createServer(async (_request, response) => {
			const runsPath = join(root, ".repoarena", "state", "runs");
			let runs: unknown[] = [];
			try {
				runs = await Promise.all(
					(await readdir(runsPath))
						.filter((file) => file.endsWith(".json"))
						.map(async (file) =>
							JSON.parse(await readFile(join(runsPath, file), "utf8")),
						),
				);
			} catch {
				/* empty state */
			}
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				`<!doctype html><title>RepoArena</title><main><h1>RepoArena local results</h1><pre>${String(JSON.stringify(runs, null, 2)).replaceAll("<", "&lt;")}</pre></main>`,
			);
		});
		server.listen(port, "127.0.0.1", () =>
			output(`RepoArena UI listening at http://127.0.0.1:${port}`),
		);
	});
program
	.command("config")
	.command("validate")
	.option("--json")
	.action(async (options) => output(await loadConfig(root), options.json));
program
	.command("version")
	.option("--json")
	.action((options) =>
		output({ cli: "0.1.0", protocol: "1", evaluator: "1" }, options.json),
	);
program.parseAsync().catch((error: unknown) => {
	if (error instanceof RepoArenaError) {
		process.stderr.write(`${error.code}: ${error.message}\n`);
		process.exitCode = 2;
		return;
	}
	process.stderr.write(
		`${error instanceof Error ? error.stack : String(error)}\n`,
	);
	process.exitCode = 1;
});
