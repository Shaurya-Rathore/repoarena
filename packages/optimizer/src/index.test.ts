import { expect, it } from "vitest";
import { enumerateCandidates, exportRecommendedProfile, optimize, type TrialMetrics } from "./index.js";
const space = { schema: "repoarena.optimizer-search/v1", dimensions: [{ agent: "fake", models: ["slow", "fast"], reasoning: ["low", "high"], profiles: ["default"], options: [{}] }], tasks: ["a", "b"], holdout_tasks: ["holdout"], objectives: ["correctness", "cost"], budget: { max_trials: 4, max_cost_micros: null, max_attempts: null, max_wall_time_ms: null } } as const;
const metrics = (success: number, cost: number, duration: number): TrialMetrics => ({ attempt_count: 2, solved_count: success * 2, success_rate: success, total_cost_micros: cost, median_duration_ms: duration, reliability: success });
it("enumerates a deterministic capability-constrained grid", () => {
	const values = enumerateCandidates(space); expect(values).toHaveLength(4); expect(values.map((item) => item.id)).toEqual([...values.map((item) => item.id)].sort()); expect(() => enumerateCandidates({ ...space, dimensions: [{ agent: "fake", models: [] }] })).toThrow();
});
it("enforces budgets, reuses provenance cache, compares baseline and exports a profile", async () => {
	const cache = new Map<string, TrialMetrics>(); let calls = 0;
	const executor = async (candidate: { model: string; reasoning: string }) => { calls++; return candidate.model === "fast" ? metrics(1, 100, candidate.reasoning === "low" ? 10 : 20) : metrics(0.5, 300, 30); };
	const first = await optimize({ searchSpace: space, repositoryCommit: "abc", runnerVersion: "1", cache, executor });
	expect(first.trials).toHaveLength(4); expect(first.recommendation?.candidate.model).toBe("fast"); expect(first.recommendation?.delta.success_rate).toBeGreaterThanOrEqual(0); expect(first.holdout_task_ids).toEqual(["holdout"]); expect(exportRecommendedProfile(first)).toContain("repoarena.profile/v1");
	const second = await optimize({ searchSpace: space, repositoryCommit: "abc", runnerVersion: "1", cache, executor });
	expect(calls).toBe(4); expect(second.trials.every((trial) => trial.cache_hit)).toBe(true); expect(second.consumed.attempts).toBe(0);
	const limited = await optimize({ searchSpace: { ...space, budget: { ...space.budget, max_trials: 1 } }, repositoryCommit: "abc", runnerVersion: "1", executor });
	expect(limited.status).toBe("BUDGET_EXHAUSTED"); expect(limited.trials).toHaveLength(1);
});
it("records cancellation and partial trial failures without inventing metrics", async () => {
	const controller = new AbortController(); let calls = 0;
	const run = await optimize({ searchSpace: space, repositoryCommit: "abc", runnerVersion: "1", signal: controller.signal, executor: async () => { calls++; if (calls === 1) throw new Error("infrastructure unavailable"); controller.abort(); return metrics(1, 1, 1); } });
	expect(run.status).toBe("CANCELLED"); expect(run.trials[0]?.status).toBe("FAILED"); expect(run.trials[0]?.metrics).toBeNull(); expect(run.trials).toHaveLength(2);
});
it("honors declared objective order and deterministic ties", async () => {
	const correctnessOnly = { ...space, objectives: ["correctness"] as const };
	const run = await optimize({ searchSpace: correctnessOnly, repositoryCommit: "abc", runnerVersion: "1", executor: async (candidate) => metrics(candidate.model === "fast" ? 1 : 0.5, candidate.reasoning === "low" ? 500 : 1, 10) });
	expect(run.recommendation?.candidate.model).toBe("fast");
	const cheapest = await optimize({ searchSpace: { ...space, objectives: ["cost", "correctness"] as const }, repositoryCommit: "abc", runnerVersion: "1", executor: async (candidate) => metrics(candidate.model === "fast" ? 1 : 0.5, candidate.reasoning === "low" ? 500 : 1, 10) });
	expect(cheapest.recommendation?.candidate.reasoning).toBe("high");
});
