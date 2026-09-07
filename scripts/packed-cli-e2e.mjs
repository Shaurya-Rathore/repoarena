import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = await mkdtemp(join(tmpdir(), "repoarena-packed-cli-"));
const run = (command, args, env = process.env) =>
	execFileSync(command, args, { cwd: fixture, env, encoding: "utf8" });
try {
	const tarball = (await import("node:fs/promises"))
		.readdir(join(root, "release-artifacts"))
		.then((items) =>
			items.find((item) => /^repoarena-1\.0\.0\.tgz$/.test(item)),
		);
	const packed = await tarball;
	if (!packed) throw new Error("CLI release tarball is missing");
	run("npm", ["init", "-y"]);
	run("npm", [
		"install",
		"--ignore-scripts",
		join(root, "release-artifacts", packed),
	]);
	run("git", ["init"]);
	run("git", ["config", "user.email", "release@example.invalid"]);
	run("git", ["config", "user.name", "Release Test"]);
	await writeFile(join(fixture, "subject.txt"), "fixed\n");
	run("git", ["add", "."]);
	run("git", ["commit", "-m", "fixture"]);
	const cli = join(fixture, "node_modules", ".bin", "repoarena");
	if (run(cli, ["--version"]).trim() !== "1.0.0")
		throw new Error("Packed CLI version mismatch");
	run(cli, ["init", "--yes"]);
	run(cli, ["doctor", "--json"]);
	run(cli, [
		"tasks",
		"new",
		"release-smoke",
		"--title",
		"Release smoke",
		"--prompt",
		"Keep subject fixed",
		"--verify",
		`${process.execPath} -e process.exit(0)`,
	]);
	const env = {
		...process.env,
		NODE_ENV: "test",
		REPOARENA_TEST_ADAPTERS: "1",
	};
	run(
		cli,
		[
			"run",
			"--agent",
			"fake-perfect",
			"--report",
			"json,html,junit",
			"--output",
			".repoarena/reports",
		],
		env,
	);
	const reports = await (await import("node:fs/promises")).readdir(
		join(fixture, ".repoarena", "reports"),
	);
	for (const suffix of [".json", ".html", ".xml"])
		if (!reports.some((name) => name.endsWith(suffix)))
			throw new Error(`Missing ${suffix} report`);
	const child = spawn(cli, ["ui", "--port", "0"], {
		cwd: fixture,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const address = await new Promise((resolveAddress, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Packed UI did not start")),
			10_000,
		);
		child.stdout.on("data", (chunk) => {
			const match = String(chunk).match(/http:\/\/[^\s]+/);
			if (match) {
				clearTimeout(timer);
				resolveAddress(match[0]);
			}
		});
		child.once("exit", (code) => reject(new Error(`Packed UI exited ${code}`)));
	});
	const health = await fetch(`${address}/health`).then((response) =>
		response.json(),
	);
	if (health.status !== "ok") throw new Error("Packed UI health failed");
	child.kill("SIGTERM");
	await new Promise((resolveExit) => child.once("exit", resolveExit));
	process.stdout.write("PACKED_CLI_E2E_OK\n");
} finally {
	await rm(fixture, { recursive: true, force: true });
}
