import { expect, it } from "vitest";
import { analyzeIntegrity } from "./index.js";

it("detects protected tests and verification tampering deterministically", () => {
	const findings = analyzeIntegrity(
		[
			{ status: "M", path: "package.json" },
			{ status: "D", path: "test/regression.spec.ts" },
			{ status: "M", path: "src/fix.ts" },
		],
		{ protected_paths: ["src/locked"], verification_paths: ["package.json"] },
	);
	expect(findings.map((f) => f.code)).toEqual([
		"TEST_DELETED",
		"VERIFICATION_TAMPERED",
	]);
});

it("does not reject ordinary source or test additions", () => {
	expect(
		analyzeIntegrity([
			{ status: "A", path: "src/new.ts" },
			{ status: "A", path: "test/new.spec.ts" },
		]),
	).toEqual([]);
});
