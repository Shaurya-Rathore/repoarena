import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
	await writeFile(
		join(d, "print.mjs"),
		"console.log(process.env.SECRET||'none');console.log('x'.repeat(200000))",
	);
	const r = await new LocalSandboxProvider(d).execute({
		argv: [process.execPath, "print.mjs"],
		cwd: d,
		env: {},
		timeout_seconds: 2,
	});
	expect(r.stdout).toContain("none");
	expect(r.stdout).toContain("[output truncated]");
});
