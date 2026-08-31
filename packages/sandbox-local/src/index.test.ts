import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalSandboxProvider } from "./index.js";
const dirs: string[] = [];
afterEach(() =>
	Promise.all(
		dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
	),
);
it("limits environment and output in workspace", async () => {
	const d = await mkdtemp(join(tmpdir(), "ra-sandbox-"));
	dirs.push(d);
	const hostSecret = "host-secret-must-not-be-inherited";
	const previous = process.env.REPOARENA_HOST_CREDENTIAL_FIXTURE;
	process.env.REPOARENA_HOST_CREDENTIAL_FIXTURE = hostSecret;
	await writeFile(
		join(d, "print.mjs"),
		"console.log(process.env.SECRET||'none');console.log(process.env.REPOARENA_HOST_CREDENTIAL_FIXTURE||'none');console.log('x'.repeat(200000))",
	);
	try {
		const r = await new LocalSandboxProvider(d).execute({
			argv: [process.execPath, "print.mjs"],
			cwd: d,
			env: {},
			timeout_seconds: 2,
		});
		expect(r.stdout).toContain("none");
		expect(r.stdout).not.toContain(hostSecret);
		expect(r.stdout).toContain("[output truncated]");
	} finally {
		if (previous === undefined)
			delete process.env.REPOARENA_HOST_CREDENTIAL_FIXTURE;
		else process.env.REPOARENA_HOST_CREDENTIAL_FIXTURE = previous;
	}
});

it("cancels an active process idempotently", async () => {
	const d = await mkdtemp(join(tmpdir(), "ra-sandbox-"));
	dirs.push(d);
	const controller = new AbortController();
	const pending = new LocalSandboxProvider(d).execute({
		argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
		cwd: d,
		env: {},
		timeout_seconds: 10,
		signal: controller.signal,
	});
	controller.abort();
	controller.abort();
	await expect(pending).resolves.toMatchObject({
		cancelled: true,
		timed_out: false,
	});
});
