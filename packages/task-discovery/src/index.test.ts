import { describe, expect, it } from "vitest";
import { scoreCandidate } from "./index.js";

const commit = (subject: string) => ({
	sha: "abc1234",
	parents: ["def1234"],
	subject,
	body: "",
	committedAt: "2020-01-01T00:00:00Z",
});
describe("historical candidate scoring", () => {
	it("rewards behavioral source and test changes without requiring a fix keyword", () => {
		const result = scoreCandidate(
			commit("Handle duplicate headers"),
			[
				{ status: "M", path: "src/parser.ts" },
				{ status: "M", path: "test/parser.test.ts" },
			],
			1000,
		);
		expect(result.score).toBeGreaterThanOrEqual(40);
		expect(result.excluded).toBeUndefined();
	});
	it("rejects docs and lockfile-only commits", () => {
		expect(
			scoreCandidate(
				commit("fix docs"),
				[{ status: "M", path: "README.md" }],
				100,
			).score,
		).toBeLessThan(0);
		expect(
			scoreCandidate(
				commit("update"),
				[{ status: "M", path: "pnpm-lock.yaml" }],
				100,
			).score,
		).toBeLessThan(0);
	});
});
