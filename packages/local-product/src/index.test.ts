import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeConfigAtomic } from "@repoarena/config";
import { writeRunAtomic, type PersistedAttempt, type PersistedRun } from "@repoarena/run-store";
import { serializeTask, taskSchema } from "@repoarena/task-spec";
import { createLocalProductServer } from "./index.js";

const roots: string[] = [];
const servers: ReturnType<typeof createLocalProductServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const attempt: PersistedAttempt = {
	schema: "repoarena.attempt-result/v1", id: "attempt-1", index: 0, task_id: "fix-widget", task_hash: "t".repeat(64),
	agent: { id: "fake", version: "1", model: "fast", config_hash: "c".repeat(64) }, sandbox: { provider: "local", network_policy: "deny" }, state: "COMPLETED",
	state_history: [{ state: "QUEUED", at: "2026-01-01T00:00:00.000Z" }, { state: "COMPLETED", at: "2026-01-01T00:00:01.000Z" }], started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z", duration_ms: 1000,
	patch: { sha256: "p".repeat(64), unified_diff: "diff --git a/widget.ts b/widget.ts\n+fixed <script>alert(1)</script>\n", bytes: 60, files_changed: 1, lines_added: 1, lines_removed: 0, files: [{ status: "M", path: "widget.ts" }] },
	public_verification: [{ id: "public", passed: true, duration_ms: 10, evidence_hash: "e".repeat(64), stdout: "ok", stderr: "", truncated: false }], private_verification: { passed: 1, failed: 0 }, integrity: [], regressions: [],
	evaluation: { schema: "repoarena.evaluation/v1", outcome: "SOLVED", reason: null, public: { passed: 1, failed: 0 }, hidden: { passed: 1, failed: 0 }, integrity: [], regressions: [], evidence_hash: "v".repeat(64) },
	usage: { status: "AVAILABLE", input_tokens: 10, output_tokens: 2 }, cost: { status: "AVAILABLE", micros: 1200, currency: "USD", pricing_id: "v1", pricing_effective_from: "2026-01-01", usage_snapshot: { status: "AVAILABLE", input_tokens: 10, output_tokens: 2 } }, failure: null, retries: [],
	artifacts: [{ path: "public.log", size: 2, sha256: "a".repeat(64), visibility: "PUBLIC", media_type: "text/plain" }, { path: "hidden.txt", size: 99, sha256: "h".repeat(64), visibility: "EVALUATOR_PRIVATE", media_type: "text/plain" }],
};
const run: PersistedRun = { schema: "repoarena.benchmark-run/v1", id: "run-1", run_fingerprint: "f".repeat(64), status: "COMPLETED", repository: { commit: "a".repeat(40), remote: null }, configuration: { runs_per_task: 1, parallelism: 1, runner_version: "test", sandbox: "local" }, attempts: [attempt], statistics: { attempt_count: 1, solved_count: 1, success_rate: 1, pass_at_1: 1, pass_at_k: 1, median_duration_ms: 1000, p90_duration_ms: 1000, median_cost_micros: 1200, total_cost_micros: 1200, cost_per_solved_micros: 1200, lines_added: 1, lines_removed: 0, failures: {} }, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:01.000Z" };
const fixture = async () => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-local-product-")); roots.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "widget.ts"), "bug\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	await writeConfigAtomic(root, { schema: "repoarena.config/v1", benchmark: { name: "demo" }, runner: { backend: "local", timeout_seconds: 30, network: "none" } });
	await mkdir(join(root, ".repoarena", "tasks"), { recursive: true });
	const task = taskSchema.parse({ schema: "repoarena.task/v1", id: "fix-widget", title: "Fix <script> widget", source: { type: "historical", base_commit: head }, prompt: "Repair widget behavior", verification: { required: [{ id: "public", command: ["node", "test.mjs"] }] }, metadata: { languages: ["TypeScript"], tags: ["bug"], difficulty: "easy", quality_score: 0.9 }, provenance: { created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", created_by: "test" } });
	await writeFile(join(root, ".repoarena", "tasks", "fix-widget.yaml"), serializeTask(task));
	await mkdir(join(root, ".repoarena", "state", "runs"), { recursive: true }); await writeRunAtomic(join(root, ".repoarena", "state", "runs", "run-1.json"), run);
	await mkdir(join(root, ".repoarena", "state", "private"), { recursive: true }); await writeFile(join(root, ".repoarena", "state", "private", "fix-widget.json"), "PRIVATE-SENTINEL REFERENCE-SOLUTION");
	return root;
};

it("serves typed public repository, task, run, attempt, readiness and optimizer APIs", async () => {
	const root = await fixture(); const local = createLocalProductServer({ root, port: 0, optimizerExecutor: async () => ({ attempt_count: 1, solved_count: 1, success_rate: 1, total_cost_micros: 20, median_duration_ms: 4, reliability: 1 }) }); servers.push(local); const address = await local.start();
	const get = async (path: string) => (await (await fetch(`${address.url}/api/v1${path}`)).json()) as { data: any };
	const repository = await get("/repository"); expect(repository.data.initialized).toBe(true);
	const tasks = await get("/tasks?limit=10"); expect(tasks.data.total).toBe(1); expect(JSON.stringify(tasks)).not.toContain("REFERENCE-SOLUTION"); expect(tasks.data.items[0].source.reference_commit).toBeUndefined();
	const runs = await get("/runs?limit=10"); expect(runs.data.items[0].statistics.total_cost_micros).toBe(1200); expect(JSON.stringify(runs)).not.toContain("hidden.txt");
	const attemptResult = await get("/attempts/attempt-1"); expect(attemptResult.data.patch.unified_diff).toContain("fixed");
	const denied = await fetch(`${address.url}/api/v1/readiness`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); expect(denied.status).toBe(403);
	const mutationHeaders = { "content-type": "application/json", origin: address.url, "x-repoarena-csrf": local.csrfToken };
	const readiness = await fetch(`${address.url}/api/v1/readiness`, { method: "POST", headers: mutationHeaders, body: "{}" }); expect(readiness.status).toBe(201);
	const search = { schema: "repoarena.optimizer-search/v1", dimensions: [{ agent: "fake", models: ["fast"] }], tasks: ["fix-widget"], budget: { max_trials: 1 } };
	const optimized = await fetch(`${address.url}/api/v1/optimizations`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(search) }); expect(optimized.status).toBe(201); const optimization = (await optimized.json()) as { data: { id: string } };
	const profile = await fetch(`${address.url}/api/v1/optimizations/${optimization.data.id}/profile`); expect(await profile.text()).toContain("repoarena.profile/v1");
});

it("serves a responsive accessible product shell and rejects malformed API input", async () => {
	const root = await fixture(); const local = createLocalProductServer({ root, port: 0 }); servers.push(local); const address = await local.start();
	const page = await (await fetch(address.url)).text(); expect(page).toContain('aria-label="Primary"'); expect(page).toContain('name="viewport"'); expect(page).toContain("Overview"); expect(page).toContain("Readiness"); expect(page).toContain("Optimizer"); expect(page).not.toContain("PRIVATE-SENTINEL");
	const invalid = await fetch(`${address.url}/api/v1/runs?limit=10000`); expect(invalid.status).toBe(400);
});
