import { expect, it } from "vitest";
import type { PersistedAttempt, PersistedRun } from "@repoarena/run-store";
import { toHtml, toJson, toJunit, toTerminal } from "./index.js";
const attempt: PersistedAttempt = {
	schema: "repoarena.attempt-result/v1",
	id: "a1",
	index: 0,
	task_id: "<script>alert(1)</script>",
	task_hash: "t".repeat(64),
	agent: {
		id: "fake&solver",
		version: "1",
		model: "model<x>",
		config_hash: "c".repeat(64),
	},
	sandbox: { provider: "local", network_policy: "DISABLED" },
	state: "COMPLETED",
	state_history: [],
	started_at: "2026-01-01T00:00:00.000Z",
	ended_at: "2026-01-01T00:00:01.000Z",
	duration_ms: 1000,
	patch: {
		sha256: "p".repeat(64),
		bytes: 2,
		files_changed: 1,
		lines_added: 1,
		lines_removed: 1,
	},
	public_verification: [
		{
			id: "public",
			passed: true,
			duration_ms: 10,
			evidence_hash: "e".repeat(64),
			stdout: "<img src=x onerror=alert(1)>",
			stderr: "",
			truncated: false,
		},
	],
	private_verification: { passed: 1, failed: 0 },
	integrity: [],
	regressions: [],
	evaluation: {
		schema: "repoarena.evaluation/v1",
		outcome: "SOLVED",
		reason: null,
		public: { passed: 1, failed: 0 },
		hidden: { passed: 1, failed: 0 },
		integrity: [],
		evidence_hash: "v".repeat(64),
	},
	usage: { status: "AVAILABLE", input_tokens: 1 },
	cost: {
		status: "AVAILABLE",
		micros: 250000,
		currency: "USD",
		pricing_id: "price-v1",
		pricing_effective_from: "2026-01-01",
		usage_snapshot: { status: "AVAILABLE", input_tokens: 1 },
	},
	failure: null,
	retries: [],
};
const run: PersistedRun = {
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
	attempts: [attempt],
	statistics: {
		attempt_count: 1,
		solved_count: 1,
		success_rate: 1,
		pass_at_1: 1,
		pass_at_k: 1,
		median_duration_ms: 1000,
		p90_duration_ms: 1000,
		median_cost_micros: 250000,
		total_cost_micros: 250000,
		cost_per_solved_micros: 250000,
		lines_added: 1,
		lines_removed: 1,
		failures: {},
	},
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:01.000Z",
};
it("renders consistent public summaries", () => {
	for (const output of [
		toTerminal(run),
		toJson(run),
		toHtml(run),
		toJunit(run),
	]) {
		expect(output).toContain("run-1");
		expect(output).not.toContain("private-sentinel");
	}
});
it("escapes controlled HTML values", () => {
	const html = toHtml(run);
	expect(html).not.toContain("<script>alert");
	expect(html).not.toContain("<img src=x");
	expect(html).toContain("&lt;script&gt;");
});
it("emits JUnit failure and error elements", () => {
	const failed = {
		...attempt,
		evaluation: {
			...attempt.evaluation,
			outcome: "UNSOLVED" as const,
			reason: "PUBLIC_VERIFICATION_FAILED" as const,
		},
	};
	const infra = {
		...attempt,
		id: "a2",
		evaluation: {
			...attempt.evaluation,
			outcome: "INFRASTRUCTURE_FAILURE" as const,
			reason: "INFRASTRUCTURE_FAILED" as const,
		},
	};
	const xml = toJunit({ ...run, attempts: [failed, infra] });
	expect(xml).toContain('failures="1"');
	expect(xml).toContain('errors="1"');
	expect(xml).toContain("<failure");
	expect(xml).toContain("<error");
});
