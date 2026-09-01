import { expect, it } from "vitest";
import { assertPublicResult, roleAllows } from "./index.js";

it("centralizes the role permission lattice", () => {
	expect(roleAllows("OWNER", "BILLING_MANAGE")).toBe(true);
	expect(roleAllows("ADMIN", "BILLING_MANAGE")).toBe(false);
	expect(roleAllows("MEMBER", "BENCHMARK_RUN")).toBe(true);
	expect(roleAllows("VIEWER", "BENCHMARK_RUN")).toBe(false);
});

it("rejects evaluator-private fields before cloud persistence", () => {
	expect(() =>
		assertPublicResult({
			schema_version: 1,
			attempts: [{ evaluator_private: { hidden_assertion: "sentinel" } }],
		}),
	).toThrow("evaluator-private");
	expect(() =>
		assertPublicResult({ schema_version: 1, private_summary: { passed: 2 } }),
	).not.toThrow();
});
