import { expect, it } from "vitest";
import { eligibility, type PublicRunProjection } from "./index.js";

const projection = (
	changes: Partial<PublicRunProjection["run"]> = {},
): PublicRunProjection => ({
	public_id: "rap_public",
	repository: { name: "repo", url: null, visibility: "PUBLIC" },
	run: {
		id: "run",
		state: "COMPLETED",
		statistics: {
			task_count: 2,
			attempt_count: 4,
			solved_count: 3,
			success_rate: 0.75,
			pass_at_k: 0.9,
			median_duration_ms: 100,
			total_cost_micros: 200,
		},
		agents: [{ id: "codex", model: "model" }],
		completed_at: "2026-09-01T00:00:00.000Z",
		...changes,
	},
	methodology_version: "repoarena.methodology/v1",
	published_at: "2026-09-01T00:00:00.000Z",
});

it("explains deterministic leaderboard eligibility", () => {
	expect(eligibility(projection())).toBe("ELIGIBLE");
	expect(
		eligibility(
			projection({
				statistics: { ...projection().run.statistics, attempt_count: 1 },
			}),
		),
	).toBe("INSUFFICIENT_SAMPLE");
	expect(eligibility(projection({ state: "INFRASTRUCTURE_FAILURE" }))).toBe(
		"INFRASTRUCTURE_INVALID",
	);
	expect(eligibility({ ...projection(), methodology_version: "old" })).toBe(
		"OUTDATED_METHODOLOGY",
	);
	expect(eligibility(projection({ agents: [] }))).toBe("INVALID_PROVENANCE");
});
