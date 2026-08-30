import { expect, it } from "vitest";
import { median, passAtK, percentile } from "./index.js";
it("computes pass@k estimator", () =>
	expect(passAtK(10, 2, 3)).toBeCloseTo(1 - (8 / 10) * (7 / 9) * (6 / 8)));
it("handles summary statistics", () => {
	expect(median([1, 4, 2, 3])).toBe(2.5);
	expect(percentile([1, 2, 3, 4, 5], 0.9)).toBe(4.6);
});
