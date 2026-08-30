import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runArgv, transitionAttempt } from "./index.js";
const dirs: string[] = [];
afterEach(() =>
	Promise.all(
		dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
	),
);
it("does not interpret argv as shell syntax", async () => {
	const d = await mkdtemp(join(tmpdir(), "ra-runner-"));
	dirs.push(d);
	const marker = join(d, "owned");
	const r = await runArgv(
		[
			process.execPath,
			"-e",
			"console.log(process.argv[1])",
			`x; echo owned > ${marker}`,
		],
		d,
		2,
	);
	expect(r.exit_code).toBe(0);
	await expect(readFile(marker, "utf8")).rejects.toThrow();
});
it("rejects illegal state transitions", () => {
	expect(transitionAttempt("QUEUED", "PREPARING")).toBe("PREPARING");
	expect(() => transitionAttempt("COMPLETED", "SETUP")).toThrow();
});
