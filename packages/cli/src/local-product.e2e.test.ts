import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
it("launches the actual built localhost product with fresh-repository onboarding", async () => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-ui-e2e-"));
	roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "README.md"), "demo");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	const cli = new URL("../dist/index.js", import.meta.url).pathname;
	const child = spawn(process.execPath, [cli, "ui", "--port", "0"], {
		cwd: root,
		env: { PATH: process.env.PATH ?? "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	const url = await new Promise<string>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error("UI startup timed out")),
			5_000,
		);
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
			if (match?.[0]) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`UI exited early: ${code}`)));
	});
	const health = (await (await fetch(`${url}/health`)).json()) as {
		status: string;
	};
	expect(health.status).toBe("ok");
	const html = await (await fetch(url)).text();
	expect(html).toContain("RepoArena Local");
	expect(html).toContain('aria-label="Primary"');
	const repository = (await (
		await fetch(`${url}/api/v1/repository`)
	).json()) as { data: { initialized: boolean; name: string } };
	expect(repository.data.initialized).toBe(false);
	expect(repository.data.name).toContain("repoarena-ui-e2e");
	child.kill("SIGTERM");
});
