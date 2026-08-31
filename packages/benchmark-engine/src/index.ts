import { contentHash } from "@repoarena/core";
import {
	snapshotCost,
	usageStatus,
	type PricingCatalog,
	type Usage,
} from "@repoarena/pricing";
import {
	writeRunAtomic,
	type PersistedAttempt,
	type PersistedRun,
} from "@repoarena/run-store";
import {
	LocalAttemptPhaseCoordinator,
	runIsolatedAttempt,
	type CommandEvidence,
	type SandboxProvider,
} from "@repoarena/runner-core";
import { aggregateAttempts } from "@repoarena/statistics";
import type { EvaluatorPrivateTaskData, Task } from "@repoarena/task-spec";

export type BenchmarkAgent = Readonly<{
	id: string;
	version: string | null;
	model: string | null;
	provider: string;
	config_hash: string;
	argv?: readonly string[];
	execute?: (
		workspace: string,
		task: Task,
		signal?: AbortSignal,
	) => Promise<CommandEvidence>;
	usage?: Usage | null;
	secrets?: readonly string[];
}>;
export type BenchmarkTask = Readonly<{
	task: Task;
	private_data: EvaluatorPrivateTaskData;
	private_verifier?: (
		workspace: string,
		data: EvaluatorPrivateTaskData,
	) => Promise<readonly string[][]>;
	artifact_requests?: readonly {
		path: string;
		visibility: "PUBLIC" | "PRIVATE" | "EVALUATOR_PRIVATE";
		source?: "agent" | "verification" | "evaluator" | "runner";
	}[];
}>;
export type BenchmarkOptions = Readonly<{
	root: string;
	repository: { commit: string; remote: string | null };
	tasks: readonly BenchmarkTask[];
	agents: readonly BenchmarkAgent[];
	runs_per_task: number;
	parallelism: number;
	pricing: PricingCatalog;
	state_path: string;
	runner_version: string;
	now?: () => Date;
	provider_retry_limit?: number;
	infrastructure_retry_limit?: number;
	retry_backoff_ms?: readonly number[];
	sleep?: (milliseconds: number) => Promise<void>;
	signal?: AbortSignal;
	sandbox_id?: string;
	sandbox_factory?: (workspace: string) => SandboxProvider;
}>;

export class BenchmarkRetryError extends Error {
	readonly retry_class: "PROVIDER_RETRY" | "INFRASTRUCTURE_RETRY";
	readonly code: string;
	constructor(
		retry_class: "PROVIDER_RETRY" | "INFRASTRUCTURE_RETRY",
		code: string,
		message = code,
	) {
		super(message);
		this.name = "BenchmarkRetryError";
		this.retry_class = retry_class;
		this.code = code;
	}
}

const patchStats = (patch: string) => {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
};

const localPhaseCoordinator = new LocalAttemptPhaseCoordinator();

export async function runBenchmark(
	options: BenchmarkOptions,
): Promise<PersistedRun> {
	if (!Number.isInteger(options.runs_per_task) || options.runs_per_task < 1)
		throw new RangeError("runs_per_task must be positive");
	if (!Number.isInteger(options.parallelism) || options.parallelism < 1)
		throw new RangeError("parallelism must be positive");
	const jobs = options.tasks
		.flatMap((t) =>
			options.agents.flatMap((a) =>
				Array.from({ length: options.runs_per_task }, (_, index) => ({
					t,
					a,
					index,
				})),
			),
		)
		.sort(
			(x, y) =>
				x.t.task.id.localeCompare(y.t.task.id) ||
				x.a.id.localeCompare(y.a.id) ||
				x.index - y.index,
		);
	const fingerprint = contentHash({
		repository: options.repository.commit,
		tasks: options.tasks.map((t) => contentHash(t.task)),
		agents: options.agents.map((a) => ({
			id: a.id,
			version: a.version,
			model: a.model,
			config_hash: a.config_hash,
		})),
		runs_per_task: options.runs_per_task,
		runner_version: options.runner_version,
	});
	const created = (options.now?.() ?? new Date()).toISOString();
	const slots: Array<PersistedAttempt | undefined> = Array(jobs.length);
	let cursor = 0;
	let persist = Promise.resolve();
	const snapshot = (status: PersistedRun["status"]): PersistedRun => {
		const attempts = slots.filter(
			(item): item is PersistedAttempt => item !== undefined,
		);
		const statistics = aggregateAttempts(
			attempts.map((a) => ({
				solved: a.evaluation.outcome === "SOLVED",
				duration_ms: a.duration_ms,
				...(a.cost.micros === null ? {} : { cost_micros: a.cost.micros }),
				lines_added: a.patch.lines_added,
				lines_removed: a.patch.lines_removed,
				...((a.failure?.code ?? a.evaluation.reason)
					? { failure_code: a.failure?.code ?? a.evaluation.reason ?? "" }
					: {}),
			})),
			Math.min(options.runs_per_task, attempts.length || 1),
		);
		return {
			schema: "repoarena.benchmark-run/v1",
			id: fingerprint.slice(0, 24),
			run_fingerprint: fingerprint,
			status,
			repository: options.repository,
			configuration: {
				runs_per_task: options.runs_per_task,
				parallelism: options.parallelism,
				runner_version: options.runner_version,
				sandbox: options.sandbox_id ?? "local",
			},
			attempts,
			statistics,
			created_at: created,
			updated_at: (options.now?.() ?? new Date()).toISOString(),
		};
	};
	await writeRunAtomic(options.state_path, snapshot("RUNNING"));
	const worker = async () => {
		for (;;) {
			if (options.signal?.aborted) return;
			const position = cursor++;
			const job = jobs[position];
			if (!job) return;
			const started = options.now?.() ?? new Date();
			const retries: PersistedAttempt["retries"][number][] = [];
			let raw: Awaited<ReturnType<typeof runIsolatedAttempt>> | undefined;
			for (;;) {
				try {
					raw = await runIsolatedAttempt({
						root: options.root,
						task: job.t.task,
						...(job.a.argv ? { agentArgv: job.a.argv } : {}),
						...(job.a.execute
							? {
									agentExecutor: (workspace: string) =>
										job.a.execute?.(
											workspace,
											job.t.task,
											options.signal,
										) as Promise<CommandEvidence>,
								}
							: {}),
						privateData: job.t.private_data,
						...(job.t.private_verifier
							? { privateVerifier: job.t.private_verifier }
							: {}),
						...(job.t.artifact_requests
							? {
									artifactRequests: job.t.artifact_requests.map((request) => ({
										...request,
										source: request.source ?? "agent",
									})),
								}
							: {}),
						...(job.a.secrets ? { secrets: job.a.secrets } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.sandbox_factory
							? { sandboxFactory: options.sandbox_factory }
							: {}),
						phaseCoordinator: localPhaseCoordinator,
					});
					break;
				} catch (error) {
					if (!(error instanceof BenchmarkRetryError)) throw error;
					const limit =
						error.retry_class === "PROVIDER_RETRY"
							? (options.provider_retry_limit ?? 0)
							: (options.infrastructure_retry_limit ?? 0);
					const used = retries.filter(
						(event) => event.class === error.retry_class,
					).length;
					if (used >= limit) throw error;
					retries.push({
						class: error.retry_class,
						reason: error.message,
						code: error.code,
						at: (options.now?.() ?? new Date()).toISOString(),
					});
					const delay = options.retry_backoff_ms?.[retries.length - 1] ?? 0;
					if (delay > 0) {
						const sleep =
							options.sleep ??
							((ms: number) =>
								new Promise<void>((resolve) => setTimeout(resolve, ms)));
						if (!options.signal) await sleep(delay);
						else
							await Promise.race([
								sleep(delay),
								new Promise<void>((resolve) =>
									options.signal?.addEventListener("abort", () => resolve(), {
										once: true,
									}),
								),
							]);
					}
				}
			}
			if (!raw) throw new Error("attempt did not produce a result");
			const ended = options.now?.() ?? new Date();
			const lines = patchStats(raw.patch);
			const observedUsage = raw.agent_usage ?? job.a.usage ?? null;
			const usage = {
				status: usageStatus(observedUsage),
				...(observedUsage ?? {}),
			} as PersistedAttempt["usage"];
			const costRaw = snapshotCost(
				options.pricing,
				job.a.provider,
				job.a.model ?? "",
				ended.toISOString(),
				observedUsage,
			);
			const cost: PersistedAttempt["cost"] = {
				status: costRaw.status,
				micros: costRaw.micros,
				currency: costRaw.currency,
				pricing_id: costRaw.pricing_id,
				pricing_effective_from: costRaw.pricing_effective_from,
				usage_snapshot: usage,
			};
			slots[position] = {
				schema: "repoarena.attempt-result/v1",
				id: contentHash({
					run: fingerprint,
					task: job.t.task.id,
					agent: job.a.id,
					index: job.index,
				}).slice(0, 24),
				index: job.index,
				task_id: job.t.task.id,
				task_hash: contentHash(job.t.task),
				agent: {
					id: job.a.id,
					version: job.a.version,
					model: job.a.model,
					config_hash: job.a.config_hash,
				},
				sandbox: {
					provider: options.sandbox_id ?? "local",
					network_policy: job.t.task.execution.network.mode,
				},
				state:
					raw.state_history.at(-1)?.state === "CANCELLED"
						? "CANCELLED"
						: raw.state_history.at(-1)?.state === "TIMED_OUT"
							? "TIMED_OUT"
							: raw.state_history.at(-1)?.state === "FAILED" ||
									raw.evaluation.outcome === "INFRASTRUCTURE_FAILURE"
								? "FAILED"
								: "COMPLETED",
				state_history: raw.state_history,
				started_at: started.toISOString(),
				ended_at: ended.toISOString(),
				duration_ms: Math.max(0, ended.getTime() - started.getTime()),
				patch: {
					sha256: contentHash(raw.patch),
					unified_diff: raw.patch,
					bytes: Buffer.byteLength(raw.patch),
					files_changed: raw.changed_files.length,
					lines_added: lines.added,
					lines_removed: lines.removed,
					files: raw.changed_files.map((file) => ({
						status: file.status,
						path: file.path,
						...(file.previousPath ? { previous_path: file.previousPath } : {}),
					})),
				},
				public_verification: raw.public_verification.map((e, index) => ({
					id: `public-${index}`,
					passed: e.exit_code === 0 && !e.timed_out,
					duration_ms: e.duration_ms,
					evidence_hash: contentHash(e),
					stdout: e.stdout,
					stderr: e.stderr,
					truncated:
						e.stdout.includes("[output truncated]") ||
						e.stderr.includes("[output truncated]"),
				})),
				private_verification: raw.private_verification,
				integrity: raw.evaluation.integrity,
				regressions: raw.evaluation.regressions,
				evaluation: raw.evaluation,
				usage,
				cost,
				failure: raw.evaluation.reason
					? {
							code: raw.evaluation.reason,
							message: raw.evaluation.reason,
							retryable: raw.evaluation.outcome === "INFRASTRUCTURE_FAILURE",
						}
					: null,
				retries,
				artifacts: raw.artifacts.map((artifact) => ({
					path: artifact.logical_path,
					size: artifact.size_bytes,
					sha256: artifact.sha256,
					visibility: artifact.visibility,
					media_type: artifact.media_type,
				})),
			};
			persist = persist.then(() =>
				writeRunAtomic(options.state_path, snapshot("RUNNING")),
			);
			await persist;
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(options.parallelism, jobs.length) }, worker),
	);
	await persist;
	const completed = snapshot(
		options.signal?.aborted ? "CANCELLED" : "COMPLETED",
	);
	await writeRunAtomic(options.state_path, completed);
	return completed;
}
