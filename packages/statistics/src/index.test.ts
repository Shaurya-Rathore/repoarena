import { expect, it } from "vitest";
import { aggregateAttempts, median, passAtK, percentile } from "./index.js";
it("computes pass@k estimator", () =>
	expect(passAtK(10, 2, 3)).toBeCloseTo(1 - (8 / 10) * (7 / 9) * (6 / 8)));
it("handles summary statistics", () => {
	expect(median([1, 4, 2, 3])).toBe(2.5);
	expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(4.6);
});
it("aggregates independently calculated run evidence", () => {
	expect(
		aggregateAttempts(
			[
				{
					solved: true,
					duration_ms: 10,
					cost_micros: 4,
					lines_added: 2,
					lines_removed: 1,
				},
				{
					solved: false,
					duration_ms: 30,
					cost_micros: 6,
					failure_code: "AGENT_FAILED",
				},
			],
			2,
		),
	).toEqual(
		expect.objectContaining({
			attempt_count: 2,
			solved_count: 1,
			success_rate: 0.5,
			pass_at_1: 0.5,
			pass_at_k: 1,
			median_duration_ms: 20,
			median_cost_micros: 5,
			total_cost_micros: 10,
			cost_per_solved_micros: 10,
			lines_added: 2,
			lines_removed: 1,
			failures: { AGENT_FAILED: 1 },
		}),
	);
});
