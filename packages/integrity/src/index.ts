import type { ChangedFile } from "@repoarena/git";

export type IntegrityCode =
	| "FORBIDDEN_PATH"
	| "TEST_DELETED"
	| "VERIFICATION_TAMPERED"
	| "SYMLINK_ESCAPE";
export type IntegrityFinding = Readonly<{
	code: IntegrityCode;
	fatal: boolean;
	path?: string;
	message: string;
}>;
export type IntegrityPolicy = Readonly<{
	protected_paths?: readonly string[];
	verification_paths?: readonly string[];
	forbid_test_deletion?: boolean;
	forbid_verification_changes?: boolean;
	symlink_paths?: readonly string[];
}>;

const testPath = (path: string) =>
	/(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(path);
const matches = (path: string, paths: readonly string[]) =>
	paths.some(
		(candidate) =>
			path === candidate || path.startsWith(`${candidate.replace(/\/$/, "")}/`),
	);

/** Deterministic policy check based on NUL-safe Git change metadata. */
export function analyzeIntegrity(
	changes: readonly ChangedFile[],
	policy: IntegrityPolicy = {},
): readonly IntegrityFinding[] {
	const findings: IntegrityFinding[] = [];
	for (const change of changes) {
		const deleted = change.status.startsWith("D");
		if (matches(change.path, policy.protected_paths ?? []))
			findings.push({
				code: "FORBIDDEN_PATH",
				fatal: true,
				path: change.path,
				message: "A protected path was modified.",
			});
		if (
			deleted &&
			policy.forbid_test_deletion !== false &&
			testPath(change.path)
		)
			findings.push({
				code: "TEST_DELETED",
				fatal: true,
				path: change.path,
				message: "A test file was deleted.",
			});
		if (
			policy.forbid_verification_changes !== false &&
			matches(change.path, policy.verification_paths ?? [])
		)
			findings.push({
				code: "VERIFICATION_TAMPERED",
				fatal: true,
				path: change.path,
				message: "A protected verification path was modified.",
			});
		if (matches(change.path, policy.symlink_paths ?? []))
			findings.push({
				code: "SYMLINK_ESCAPE",
				fatal: true,
				path: change.path,
				message: "A path with unsafe symlink metadata was changed.",
			});
	}
	return findings.sort((a, b) =>
		`${a.code}:${a.path ?? ""}`.localeCompare(`${b.code}:${b.path ?? ""}`),
	);
}
