import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const workspace = await mkdtemp(join(tmpdir(), "repoarena-demo-"));
const cli = join(root, "packages", "cli", "dist", "index.cjs");
const env = {
	PATH: process.env.PATH ?? "",
	NODE_ENV: "test",
	REPOARENA_TEST_ADAPTERS: "1",
};
const run = (args, options = {}) =>
	execFileSync(cli, args, {
		cwd: workspace,
		env,
		encoding: "utf8",
		...options,
	});
try {
	execFileSync("git", ["init", "-q"], { cwd: workspace });
	execFileSync("git", ["config", "user.email", "demo@example.invalid"], {
		cwd: workspace,
	});
	execFileSync("git", ["config", "user.name", "RepoArena Demo"], {
		cwd: workspace,
	});
	await writeFile(join(workspace, "subject.txt"), "bug\n");
	await writeFile(
		join(workspace, "README.md"),
		"# Historical bug fixture\n\n`subject.txt` should contain `fixed`.\n",
	);
	execFileSync("git", ["add", "."], { cwd: workspace });
	execFileSync("git", ["commit", "-qm", "introduce historical bug"], {
		cwd: workspace,
	});
	const buggyCommit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: workspace,
		encoding: "utf8",
	}).trim();
	await writeFile(join(workspace, "subject.txt"), "fixed\n");
	execFileSync("git", ["add", "subject.txt"], { cwd: workspace });
	execFileSync("git", ["commit", "-qm", "fix subject regression"], {
		cwd: workspace,
	});
	process.stdout.write(run(["init", "--yes"]));
	process.stdout.write("\nHistorical candidates\n");
	process.stdout.write(run(["tasks", "discover", "--limit", "5"]));
	execFileSync("git", ["checkout", "--detach", "-q", buggyCommit], {
		cwd: workspace,
	});
	process.stdout.write(
		run([
			"tasks",
			"new",
			"historical-fix",
			"--title",
			"Repair the historical regression",
			"--prompt",
			"Change subject.txt from bug to fixed.",
			"--verify",
			`${process.execPath} -e \"if(require('fs').readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)\"`,
		]),
	);
	await mkdir(join(workspace, ".repoarena", "state", "private"), {
		recursive: true,
	});
	await writeFile(
		join(workspace, ".repoarena", "state", "private", "historical-fix.json"),
		JSON.stringify({
			task_id: "historical-fix",
			reference_commit: null,
			reference_patch: null,
			hidden_hook_source:
				"import{readFileSync}from'node:fs';if(readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1);",
			private_notes: [],
		}),
	);
	process.stdout.write(
		"\nExample benchmark (deterministic test agents; no paid calls)\n\n",
	);
	process.stdout.write(
		run([
			"run",
			"--agent",
			"fake-noop",
			"--agent",
			"fake-perfect",
			"--report",
			"terminal,json,html,junit",
		]),
	);
	if (process.argv.includes("--ui-smoke")) {
		const child = spawn(cli, ["ui", "--port", "0"], {
			cwd: workspace,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const address = await new Promise((resolveAddress, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Demo UI did not start")),
				10_000,
			);
			child.stdout.on("data", (chunk) => {
				const match = String(chunk).match(/http:\/\/[^\s]+/);
				if (match) {
					clearTimeout(timer);
					resolveAddress(match[0]);
				}
			});
			child.once("exit", (code) => reject(new Error(`Demo UI exited ${code}`)));
		});
		const page = await fetch(address).then((response) => response.text());
		if (!page.includes("RepoArena"))
			throw new Error("Demo UI page unavailable");
		child.kill("SIGTERM");
		await new Promise((resolveExit) => child.once("exit", resolveExit));
		process.stdout.write(`Demo UI verified at ${address}\n`);
	}
	process.stdout.write(`\nDemo workspace: ${workspace}\n`);
} catch (error) {
	await rm(workspace, { recursive: true, force: true });
	throw error;
}
