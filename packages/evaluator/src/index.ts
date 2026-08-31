import { contentHash } from "@repoarena/core";
/** Trusted command evidence. stdout/stderr never enter a public result. */
export type VerificationResult = {
	id: string;
	source: "public" | "private";
	passed: boolean;
	duration_ms: number;
	exit_code: number | null;
	stdout: string;
	stderr: string;
	evidence_hash: string;
};
export type IntegrityFinding = {
	code:
		| "FORBIDDEN_PATH"
		| "TEST_DELETED"
		| "VERIFICATION_TAMPERED"
		| "SYMLINK_ESCAPE";
	fatal: boolean;
	message: string;
};

export type FailureCode =
	| "AGENT_FAILED"
	| "AGENT_TIMEOUT"
	| "CANCELLED"
	| "HIDDEN_VERIFICATION_FAILED"
	| "INFRASTRUCTURE_FAILED"
	| "INTEGRITY_VIOLATION"
	| "PUBLIC_VERIFICATION_FAILED"
	| "REGRESSION";
export type RegressionFinding = Readonly<{
	code:
		| "BUILD_REGRESSION"
		| "TEST_REGRESSION"
		| "SETUP_REGRESSION"
		| "HIDDEN_REGRESSION";
	fatal: boolean;
	message: string;
}>;

/** Evaluator-only data; this type has no public serializer. */
export type PrivateEvaluationEvidence = Readonly<{
	private_checks: readonly VerificationResult[];
	private_paths?: readonly string[];
	reference_solution_fingerprint?: string;
}>;

export type EvaluationInput = {
	public_checks: VerificationResult[];
	private_checks: readonly VerificationResult[];
	integrity: readonly IntegrityFinding[];
	regressions?: readonly RegressionFinding[];
	infrastructure_failure?: boolean;
	agent_failure?: boolean;
	agent_timeout?: boolean;
	cancelled?: boolean;
};
export type EvaluationResult = {
	schema: "repoarena.evaluation/v1";
	outcome: "SOLVED" | "UNSOLVED" | "INFRASTRUCTURE_FAILURE";
	reason: FailureCode | null;
	public: { passed: number; failed: number };
	hidden: { passed: number; failed: number };
	integrity: IntegrityFinding[];
	regressions: RegressionFinding[];
	evidence_hash: string;
};

/** Public, serializable evaluator projection: it cannot contain command evidence. */
export type PublicEvaluationResult = Readonly<{
	schema: "repoarena.evaluation/v1";
	outcome: EvaluationResult["outcome"];
	reason: EvaluationResult["reason"];
	public: EvaluationResult["public"];
	hidden: EvaluationResult["hidden"];
	integrity: readonly IntegrityFinding[];
	regressions: readonly RegressionFinding[];
	evidence_hash: string;
}>;
export function evaluate(input: EvaluationInput): EvaluationResult {
	const pub = input.public_checks.filter((c) => !c.passed);
	const hidden = input.private_checks.filter((c) => !c.passed);
	const fatal = input.integrity.find((f) => f.fatal);
	const regression = input.regressions?.find((f) => f.fatal);
	const outcome = input.infrastructure_failure
		? "INFRASTRUCTURE_FAILURE"
		: pub.length ||
				hidden.length ||
				fatal ||
				regression ||
				input.agent_failure ||
				input.agent_timeout ||
				input.cancelled
			? "UNSOLVED"
			: "SOLVED";
	const reason = input.infrastructure_failure
		? "INFRASTRUCTURE_FAILED"
		: pub.length
			? "PUBLIC_VERIFICATION_FAILED"
			: hidden.length
				? "HIDDEN_VERIFICATION_FAILED"
				: regression
					? "REGRESSION"
					: fatal
						? "INTEGRITY_VIOLATION"
						: input.cancelled
							? "CANCELLED"
							: input.agent_timeout
								? "AGENT_TIMEOUT"
								: input.agent_failure
									? "AGENT_FAILED"
									: null;
	return {
		schema: "repoarena.evaluation/v1",
		outcome,
		reason,
		public: {
			passed: input.public_checks.length - pub.length,
			failed: pub.length,
		},
		hidden: {
			passed: input.private_checks.length - hidden.length,
			failed: hidden.length,
		},
		integrity: input.integrity.map((f) => ({
			code: f.code,
			fatal: f.fatal,
			message: f.message,
		})),
		regressions: (input.regressions ?? []).map((finding) => ({ ...finding })),
		evidence_hash: contentHash({
			public: input.public_checks.map((c) => [c.id, c.passed, c.evidence_hash]),
			private: input.private_checks.map((c) => [c.id, c.passed]),
			integrity: input.integrity.map((f) => [f.code, f.fatal]),
			regressions: (input.regressions ?? []).map((f) => [f.code, f.fatal]),
		}),
	};
}
export function toPublicEvaluationResult(
	result: EvaluationResult,
): PublicEvaluationResult {
	return {
		...result,
		integrity: result.integrity.map((f) => ({
			code: f.code,
			fatal: f.fatal,
			message: f.message,
		})),
		regressions: result.regressions.map((finding) => ({ ...finding })),
	};
}
export function verification(
	id: string,
	source: "public" | "private",
	passed: boolean,
	stdout = "",
	stderr = "",
): VerificationResult {
	return {
		id,
		source,
		passed,
		duration_ms: 0,
		exit_code: passed ? 0 : 1,
		stdout,
		stderr,
		evidence_hash: contentHash({ id, source, passed, stdout, stderr }),
	};
}
