import { open, readFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalJson, contentHash, RepoArenaError } from "@repoarena/core";
import type { PublicEvaluationResult } from "@repoarena/evaluator";
import type { AggregateStatistics } from "@repoarena/statistics";

export type AttemptTerminalState =
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT";
export type PublicUsage = Readonly<{
	status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
	reasoning_tokens?: number;
	total_tokens?: number;
	tool_calls?: number;
}>;
export type PublicCost = Readonly<{
	status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
	micros: number | null;
	currency: "USD";
	pricing_id: string | null;
	pricing_effective_from: string | null;
	usage_snapshot: PublicUsage;
}>;
export type PersistedAttempt = Readonly<{
	schema: "repoarena.attempt-result/v1";
	id: string;
	index: number;
	task_id: string;
	task_hash: string;
	agent: {
		id: string;
		version: string | null;
		model: string | null;
		config_hash: string;
	};
	sandbox: { provider: string; network_policy: string };
	state: AttemptTerminalState;
	state_history: readonly { state: string; at: string }[];
	started_at: string;
	ended_at: string;
	duration_ms: number;
	patch: {
		sha256: string;
		unified_diff?: string;
		bytes: number;
		files_changed: number;
		lines_added: number;
		lines_removed: number;
		files: readonly {
			status: string;
			path: string;
			previous_path?: string;
		}[];
	};
	public_verification: readonly {
		id: string;
		passed: boolean;
		duration_ms: number;
		evidence_hash: string;
		stdout: string;
		stderr: string;
		truncated: boolean;
	}[];
	agent_execution?: {
		command: string;
		exit_code: number | null;
		duration_ms: number;
		stdout: string;
		stderr: string;
		timed_out: boolean;
		cancelled?: boolean;
	};
	private_verification: { passed: number; failed: number };
	integrity: readonly { code: string; fatal: boolean; message: string }[];
	regressions: readonly { code: string; fatal: boolean; message: string }[];
	evaluation: PublicEvaluationResult;
	usage: PublicUsage;
	cost: PublicCost;
	failure: null | { code: string; message: string; retryable: boolean };
	retries: readonly {
		class: "PROVIDER_RETRY" | "INFRASTRUCTURE_RETRY";
		reason: string;
		code?: string;
		at?: string;
	}[];
	artifacts: readonly {
		path: string;
		size: number;
		sha256: string;
		visibility: "PUBLIC" | "PRIVATE" | "EVALUATOR_PRIVATE";
		media_type: string;
	}[];
}>;
export type PersistedRun = Readonly<{
	schema: "repoarena.benchmark-run/v1";
	id: string;
	run_fingerprint: string;
	status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	repository: { commit: string; remote: string | null };
	configuration: {
		runs_per_task: number;
		parallelism: number;
		runner_version: string;
		sandbox: string;
	};
	attempts: readonly PersistedAttempt[];
	statistics: AggregateStatistics;
	created_at: string;
	updated_at: string;
}>;

export function serializeRun(run: PersistedRun): string {
	return `${canonicalJson(run)}\n`;
}

export async function writeRunAtomic(
	path: string,
	run: PersistedRun,
): Promise<void> {
	if (!isAbsolute(path))
		throw new RepoArenaError(
			"CONFIG_INVALID",
			"Run state path must be absolute.",
		);
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(
		dirname(path),
		`.${contentHash({ path, run: run.id, nonce: crypto.randomUUID() })}.tmp`,
	);
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(serializeRun(run), "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function loadRun(path: string): Promise<PersistedRun> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as PersistedRun;
		if (
			value.schema !== "repoarena.benchmark-run/v1" ||
			!Array.isArray(value.attempts)
		)
			throw new Error("unsupported run schema");
		return value;
	} catch (cause) {
		throw new RepoArenaError(
			"EVALUATION_FAILED",
			"Run state is corrupt or unsupported.",
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		);
	}
}

export type RunRecoveryPlan = Readonly<{
	status: "COMPLETED" | "RUNNING" | "FAILED" | "CANCELLED" | "CORRUPT";
	completed_attempt_ids: readonly string[];
	needs_clean_restart: boolean;
	message?: string;
}>;

/** Inspect persisted state without trusting an interrupted workspace. */
export async function inspectRunRecovery(
	path: string,
): Promise<RunRecoveryPlan> {
	try {
		const run = await loadRun(path);
		return {
			status: run.status,
			completed_attempt_ids: run.attempts
				.filter((attempt) => attempt.state === "COMPLETED")
				.map((attempt) => attempt.id)
				.sort(),
			needs_clean_restart: run.status === "RUNNING",
		};
	} catch (error) {
		return {
			status: "CORRUPT",
			completed_attempt_ids: [],
			needs_clean_restart: true,
			message:
				error instanceof RepoArenaError ? error.message : "Corrupt run state.",
		};
	}
}
