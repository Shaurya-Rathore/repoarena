import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitRepository } from "@repoarena/git";
import { analyzeLeakage } from "@repoarena/leakage";
import type { EvaluatorPrivateTaskData, Task } from "@repoarena/task-spec";
const exec = promisify(execFile);
export type ValidationReason =
	| "BASE_COMMIT_UNAVAILABLE"
	| "BASE_SETUP_FAILED"
	| "FAILURE_NOT_REPRODUCED"
	| "REFERENCE_COMMIT_UNAVAILABLE"
	| "REFERENCE_SETUP_FAILED"
	| "REFERENCE_FIX_DOES_NOT_PASS"
	| "VERIFICATION_COMMAND_FAILED"
	| "NONDETERMINISTIC"
	| "LEAKAGE_DETECTED"
	| "UNSUPPORTED_REPOSITORY_STATE"
	| "VALIDATION_TIMEOUT";
export type ValidationResult = {
	status: "READY" | "INVALID" | "BLOCKED";
	reason?: ValidationReason;
	events: string[];
};
const shell = (command: string[], cwd: string, timeout: number) =>
	exec(command[0] ?? "", command.slice(1), {
		cwd,
		timeout: timeout * 1000,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
	})
		.then(() => true)
		.catch(() => false);
export async function validateHistoricalTask(
	repository: GitRepository,
	task: Task,
	privateData: EvaluatorPrivateTaskData,
): Promise<ValidationResult> {
	const leak = analyzeLeakage(task, privateData);
	if (!leak.safe)
		return {
			status: "INVALID",
			reason: "LEAKAGE_DETECTED",
			events: leak.findings.map((f) => f.code),
		};
	if (!privateData.reference_commit)
		return {
			status: "INVALID",
			reason: "REFERENCE_COMMIT_UNAVAILABLE",
			events: [],
		};
	if (
		!(await repository.isAncestor(
			task.source.base_commit,
			privateData.reference_commit,
		))
	)
		return {
			status: "INVALID",
			reason: "UNSUPPORTED_REPOSITORY_STATE",
			events: [],
		};
	const dir = await mkdtemp(join(tmpdir(), "repoarena-validate-"));
	const base = join(dir, "base");
	const ref = join(dir, "ref");
	try {
		await repository.createDetachedWorktree(task.source.base_commit, base);
		await repository.createDetachedWorktree(privateData.reference_commit, ref);
		for (const command of task.setup.commands) {
			if (
				!Array.isArray(command) ||
				!(await shell(command, base, task.setup.timeout_seconds))
			)
				return { status: "BLOCKED", reason: "BASE_SETUP_FAILED", events: [] };
			if (
				!Array.isArray(command) ||
				!(await shell(command, ref, task.setup.timeout_seconds))
			)
				return {
					status: "BLOCKED",
					reason: "REFERENCE_SETUP_FAILED",
					events: [],
				};
		}
		const check = task.verification.required[0];
		if (!check || !Array.isArray(check.command))
			return {
				status: "INVALID",
				reason: "VERIFICATION_COMMAND_FAILED",
				events: ["verification must be argv form"],
			};
		const before = await shell(check.command, base, check.timeout_seconds);
		const after = await shell(check.command, ref, check.timeout_seconds);
		if (!after)
			return {
				status: "INVALID",
				reason: "REFERENCE_FIX_DOES_NOT_PASS",
				events: [],
			};
		if (before)
			return {
				status: "INVALID",
				reason: "FAILURE_NOT_REPRODUCED",
				events: [],
			};
		return { status: "READY", events: ["base failed and reference passed"] };
	} catch {
		return { status: "BLOCKED", reason: "BASE_COMMIT_UNAVAILABLE", events: [] };
	} finally {
		await repository.removeWorktree(base).catch(() => undefined);
		await repository.removeWorktree(ref).catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}
}
