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
	).toBe("INTEGRITY_VIOLATION");
});
it("keeps fatal regressions distinct from integrity", () => {
	expect(
		evaluate({
			public_checks: [verification("p", "public", true)],
			private_checks: [],
			integrity: [],
			regressions: [
				{
					code: "TEST_REGRESSION",
					fatal: true,
					message: "unrelated suite failed",
				},
			],
		}),
	).toMatchObject({ outcome: "UNSOLVED", reason: "REGRESSION" });
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

it.each([
	{
		name: "clean public and private behavior",
		input: {
			public_checks: [verification("p", "public", true)],
			private_checks: [verification("h", "private", true)],
			integrity: [],
		},
		outcome: "SOLVED",
		reason: null,
	},
	{
		name: "public failure",
		input: {
			public_checks: [verification("p", "public", false)],
			private_checks: [verification("h", "private", true)],
			integrity: [],
		},
		outcome: "UNSOLVED",
		reason: "PUBLIC_VERIFICATION_FAILED",
	},
	{
		name: "private failure",
		input: {
			public_checks: [verification("p", "public", true)],
			private_checks: [verification("h", "private", false)],
			integrity: [],
		},
		outcome: "UNSOLVED",
		reason: "HIDDEN_VERIFICATION_FAILED",
	},
	{
		name: "regression",
		input: {
			public_checks: [verification("p", "public", true)],
			private_checks: [verification("h", "private", true)],
			integrity: [],
			regressions: [
				{ code: "TEST_REGRESSION" as const, fatal: true, message: "failed" },
			],
		},
		outcome: "UNSOLVED",
		reason: "REGRESSION",
	},
	{
		name: "integrity violation",
		input: {
			public_checks: [verification("p", "public", true)],
			private_checks: [verification("h", "private", true)],
			integrity: [
				{ code: "TEST_DELETED" as const, fatal: true, message: "deleted" },
			],
		},
		outcome: "UNSOLVED",
		reason: "INTEGRITY_VIOLATION",
	},
	{
		name: "agent crash",
		input: {
			public_checks: [],
			private_checks: [],
			integrity: [],
			agent_failure: true,
		},
		outcome: "UNSOLVED",
		reason: "AGENT_FAILED",
	},
	{
		name: "agent timeout",
		input: {
			public_checks: [],
			private_checks: [],
			integrity: [],
			agent_timeout: true,
		},
		outcome: "UNSOLVED",
		reason: "AGENT_TIMEOUT",
	},
	{
		name: "infrastructure failure",
		input: {
			public_checks: [],
			private_checks: [],
			integrity: [],
			infrastructure_failure: true,
		},
		outcome: "INFRASTRUCTURE_FAILURE",
		reason: "INFRASTRUCTURE_FAILED",
	},
	{
		name: "cancellation",
		input: {
			public_checks: [],
			private_checks: [],
			integrity: [],
			cancelled: true,
		},
		outcome: "UNSOLVED",
		reason: "CANCELLED",
	},
])(
	"applies the centralized decision matrix: $name",
	({ input, outcome, reason }) => {
		expect(evaluate(input)).toMatchObject({ outcome, reason });
	},
);
