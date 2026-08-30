import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	loadRun,
	serializeRun,
	writeRunAtomic,
	type PersistedRun,
} from "./index.js";

const roots: string[] = [];
afterEach(async () =>
	Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	),
);
const run = (): PersistedRun => ({
	schema: "repoarena.benchmark-run/v1",
	id: "run-1",
	run_fingerprint: "f".repeat(64),
	status: "COMPLETED",
	repository: { commit: "a".repeat(40), remote: null },
	configuration: {
		runs_per_task: 1,
		parallelism: 1,
		runner_version: "test",
		sandbox: "local",
	},
	attempts: [],
	statistics: {
		attempt_count: 0,
		solved_count: 0,
		success_rate: null,
		pass_at_1: null,
		pass_at_k: null,
		median_duration_ms: null,
		p90_duration_ms: null,
		median_cost_micros: null,
		total_cost_micros: null,
		cost_per_solved_micros: null,
		lines_added: 0,
		lines_removed: 0,
		failures: {},
	},
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
});

it("round trips an atomically persisted canonical run", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-run-store-"));
	roots.push(root);
	const path = join(root, "run.json");
	await writeRunAtomic(path, run());
	expect(await loadRun(path)).toEqual(run());
	expect(await readFile(path, "utf8")).toBe(serializeRun(run()));
});
it("replaces a prior valid result without leaving temp state", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-run-store-"));
	roots.push(root);
	const path = join(root, "run.json");
	await writeRunAtomic(path, { ...run(), status: "RUNNING" });
	await writeRunAtomic(path, run());
	expect((await loadRun(path)).status).toBe("COMPLETED");
});
it("classifies corrupt state", async () => {
	const root = await mkdtemp(join(tmpdir(), "ra-run-store-"));
	roots.push(root);
	const path = join(root, "run.json");
	await writeFile(path, "{broken");
	await expect(loadRun(path)).rejects.toThrow("corrupt or unsupported");
});
