import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfig, writeConfigAtomic } from "./index.js";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
it("validates and atomically round-trips project configuration", async () => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-config-")); roots.push(root);
	const config = await writeConfigAtomic(root, { schema: "repoarena.config/v1", benchmark: { name: "local" }, runner: { backend: "local", timeout_seconds: 30, network: "none" } });
	expect(await loadConfig(root)).toEqual(config); expect(await readFile(join(root, ".repoarena", "config.yaml"), "utf8")).not.toContain("undefined");
	await expect(writeConfigAtomic(root, { schema: "bad" })).rejects.toThrow(); expect(await loadConfig(root)).toEqual(config);
});
