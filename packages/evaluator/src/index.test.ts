import { expect, it } from "vitest";
import { evaluate, toPublicEvaluationResult, verification } from "./index.js";
it("uses private behavior rather than patch similarity", () => {
	expect(
		evaluate({
			public_checks: [verification("p", "public", true)],
			private_checks: [verification("h", "private", false)],
			integrity: [],
		}).reason,
	).toBe("HIDDEN_VERIFICATION_FAILED");
});
it("rejects fatal integrity after passing tests", () => {
	expect(
		evaluate({
			public_checks: [verification("p", "public", true)],
			private_checks: [],
			integrity: [
				{ code: "TEST_DELETED", fatal: true, message: "Relevant test removed" },
			],
		}).reason,
	).toBe("TEST_DELETED");
});

it("never serializes evaluator-private command evidence", () => {
	const privateSentinel = "hidden assertion: expected private sentinel";
	const result = evaluate({
		public_checks: [verification("public", "public", true)],
		private_checks: [
			verification(
				"private",
				"private",
				false,
				privateSentinel,
				privateSentinel,
			),
		],
		integrity: [],
	});
	expect(JSON.stringify(toPublicEvaluationResult(result))).not.toContain(
		privateSentinel,
	);
	expect(toPublicEvaluationResult(result).hidden).toEqual({
		passed: 0,
		failed: 1,
	});
});

it("keeps infrastructure failures distinct from agent failures", () => {
	expect(
		evaluate({
			public_checks: [],
			private_checks: [],
			integrity: [],
			infrastructure_failure: true,
			agent_failure: true,
		}),
	).toMatchObject({
		outcome: "INFRASTRUCTURE_FAILURE",
		reason: "INFRASTRUCTURE_FAILED",
	});
});
