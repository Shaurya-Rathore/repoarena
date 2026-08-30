#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "@repoarena/config";
import { RepoArenaError } from "@repoarena/core";
import { assessRepository } from "@repoarena/readiness";
import { toHtml } from "@repoarena/reporter";
import { loadTask, runTask } from "@repoarena/runner-core";
import { taskSchema } from "@repoarena/task-spec";
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
	.command("run")
	.option("--tasks <ids>", "comma-separated task IDs")
	.option(
		"--agent-command <command>",
		"command that performs the agent attempt",
	)
	.option("--retain-workspace")
	.option("--json")
	.action(async (options) => {
		await ensureGit();
		await loadConfig(root);
		const selected = options.tasks
			? new Set((options.tasks as string).split(","))
			: undefined;
		const files = await paths();
		const results = [];
		for (const path of files) {
			const task = await taskFromPath(path);
			if (selected && !selected.has(task.id)) continue;
			const result = await runTask({
				root,
				task,
				agentCommand: options.agentCommand,
				retainWorkspace: options.retainWorkspace,
			});
			results.push(result);
		}
		await mkdir(join(root, ".repoarena", "state", "runs"), { recursive: true });
		for (const result of results)
			await writeFile(
				join(root, ".repoarena", "state", "runs", `${result.id}.json`),
				JSON.stringify(result, null, 2),
			);
		output(results, options.json);
		if (results.some((result) => result.status !== "passed"))
			process.exitCode = 1;
	});
program
	.command("export <runId>")
	.requiredOption("--format <format>", "json or html")
	.option("--output <path>")
	.action(async (runId, options) => {
		const result = JSON.parse(
			await readFile(
				join(root, ".repoarena", "state", "runs", `${runId}.json`),
				"utf8",
			),
		);
		const data =
			options.format === "html"
				? toHtml(result)
				: JSON.stringify(result, null, 2);
		if (options.format !== "html" && options.format !== "json")
			throw new RepoArenaError("CONFIG_INVALID", "format must be json or html");
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
