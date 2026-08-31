import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash } from "@repoarena/core";
import { stringify } from "yaml";
import { z } from "zod";

const dimensionSchema = z.object({
	agent: z.string().min(1),
	models: z.array(z.string().min(1)).min(1),
	reasoning: z.array(z.string().min(1)).min(1).default(["default"]),
	profiles: z.array(z.string().min(1)).min(1).default(["default"]),
	options: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).min(1).default([{}]),
}).strict();
export const searchSpaceSchema = z.object({
	schema: z.literal("repoarena.optimizer-search/v1"),
	dimensions: z.array(dimensionSchema).min(1),
	tasks: z.array(z.string().min(1)).min(1),
	holdout_tasks: z.array(z.string().min(1)).default([]),
	objectives: z.array(z.enum(["correctness", "cost", "duration", "reliability"])).min(1).default(["correctness", "cost"]),
	budget: z.object({
		max_trials: z.number().int().positive(),
		max_cost_micros: z.number().int().nonnegative().nullable().default(null),
		max_attempts: z.number().int().positive().nullable().default(null),
		max_wall_time_ms: z.number().int().positive().nullable().default(null),
	}).strict(),
}).strict();
export type SearchSpace = z.infer<typeof searchSpaceSchema>;
export type CandidateConfiguration = Readonly<{
	id: string;
	agent: string;
	model: string;
	reasoning: string;
	profile: string;
	options: Readonly<Record<string, string | number | boolean>>;
}>;
export type TrialMetrics = Readonly<{
	attempt_count: number;
	solved_count: number;
	success_rate: number;
	total_cost_micros: number | null;
	median_duration_ms: number | null;
	reliability: number | null;
}>;
export type OptimizationTrial = Readonly<{
	id: string;
	candidate: CandidateConfiguration;
	status: "COMPLETED" | "FAILED" | "CANCELLED" | "CACHED";
	metrics: TrialMetrics | null;
	cache_hit: boolean;
	early_stop_reason: string | null;
	failure: string | null;
	started_at: string;
	ended_at: string;
}>;
export type OptimizationRun = Readonly<{
	schema: "repoarena.optimization-run/v1";
	id: string;
	status: "COMPLETED" | "CANCELLED" | "BUDGET_EXHAUSTED" | "NO_VALID_CANDIDATES";
	repository_commit: string;
	task_ids: readonly string[];
	holdout_task_ids: readonly string[];
	search_space_hash: string;
	baseline_candidate_id: string;
	trials: readonly OptimizationTrial[];
	pareto_candidate_ids: readonly string[];
	recommendation: null | {
		candidate: CandidateConfiguration;
		metrics: TrialMetrics;
		baseline: TrialMetrics;
		delta: { success_rate: number; cost_micros: number | null; duration_ms: number | null };
		explanation: string;
		sample_count: number;
	};
	budget: SearchSpace["budget"];
	consumed: { trials: number; attempts: number; cost_micros: number; wall_time_ms: number };
	created_at: string;
	completed_at: string;
}>;
export type TrialExecutor = (candidate: CandidateConfiguration, taskIds: readonly string[], signal?: AbortSignal) => Promise<TrialMetrics>;
export type OptimizationCache = Map<string, TrialMetrics>;

export const enumerateCandidates = (input: unknown): CandidateConfiguration[] => {
	const space = searchSpaceSchema.parse(input);
	const candidates = space.dimensions.flatMap((dimension) => dimension.models.flatMap((model) => dimension.reasoning.flatMap((reasoning) => dimension.profiles.flatMap((profile) => dimension.options.map((options) => {
		const value = { agent: dimension.agent, model, reasoning, profile, options };
		return { id: contentHash(value).slice(0, 24), ...value };
	})))));
	return [...new Map(candidates.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
};
const cacheKey = (repositoryCommit: string, candidate: CandidateConfiguration, tasks: readonly string[], runnerVersion: string) => contentHash({ repositoryCommit, candidate, tasks: [...tasks].sort(), runnerVersion });
const dominates = (a: TrialMetrics, b: TrialMetrics) => {
	const aCost = a.total_cost_micros ?? Number.POSITIVE_INFINITY;
	const bCost = b.total_cost_micros ?? Number.POSITIVE_INFINITY;
	const aDuration = a.median_duration_ms ?? Number.POSITIVE_INFINITY;
	const bDuration = b.median_duration_ms ?? Number.POSITIVE_INFINITY;
	const noWorse = a.success_rate >= b.success_rate && aCost <= bCost && aDuration <= bDuration;
	return noWorse && (a.success_rate > b.success_rate || aCost < bCost || aDuration < bDuration);
};
const choose = (trials: readonly OptimizationTrial[]) => trials.filter((trial): trial is OptimizationTrial & { metrics: TrialMetrics } => trial.metrics !== null && ["COMPLETED", "CACHED"].includes(trial.status)).sort((a, b) => b.metrics.success_rate - a.metrics.success_rate || (a.metrics.total_cost_micros ?? Number.MAX_SAFE_INTEGER) - (b.metrics.total_cost_micros ?? Number.MAX_SAFE_INTEGER) || (a.metrics.median_duration_ms ?? Number.MAX_SAFE_INTEGER) - (b.metrics.median_duration_ms ?? Number.MAX_SAFE_INTEGER) || a.candidate.id.localeCompare(b.candidate.id));

export async function optimize(options: {
	searchSpace: unknown;
	repositoryCommit: string;
	runnerVersion: string;
	executor: TrialExecutor;
	baseline?: CandidateConfiguration;
	cache?: OptimizationCache;
	signal?: AbortSignal;
	now?: () => Date;
}): Promise<OptimizationRun> {
	const space = searchSpaceSchema.parse(options.searchSpace);
	const candidates = enumerateCandidates(space);
	const baseline = options.baseline ?? candidates[0];
	const created = options.now?.() ?? new Date();
	if (!baseline) throw new RangeError("optimizer has no baseline candidate");
	const ordered = [baseline, ...candidates.filter((item) => item.id !== baseline.id)];
	const trials: OptimizationTrial[] = [];
	let attempts = 0;
	let cost = 0;
	let exhausted = false;
	for (const candidate of ordered) {
		const elapsed = (options.now?.() ?? new Date()).getTime() - created.getTime();
		if (options.signal?.aborted) break;
		if (trials.length >= space.budget.max_trials || (space.budget.max_attempts !== null && attempts >= space.budget.max_attempts) || (space.budget.max_cost_micros !== null && cost >= space.budget.max_cost_micros) || (space.budget.max_wall_time_ms !== null && elapsed >= space.budget.max_wall_time_ms)) { exhausted = true; break; }
		const started = (options.now?.() ?? new Date()).toISOString();
		const key = cacheKey(options.repositoryCommit, candidate, space.tasks, options.runnerVersion);
		const cached = options.cache?.get(key);
		try {
			const metrics = cached ?? await options.executor(candidate, space.tasks, options.signal);
			if (!Number.isFinite(metrics.success_rate) || metrics.success_rate < 0 || metrics.success_rate > 1) throw new RangeError("trial returned invalid success_rate");
			if (!cached) { options.cache?.set(key, metrics); attempts += metrics.attempt_count; cost += metrics.total_cost_micros ?? 0; }
			trials.push({ id: contentHash({ key, index: trials.length }).slice(0, 24), candidate, status: cached ? "CACHED" : "COMPLETED", metrics, cache_hit: Boolean(cached), early_stop_reason: null, failure: null, started_at: started, ended_at: (options.now?.() ?? new Date()).toISOString() });
		} catch (error) {
			trials.push({ id: contentHash({ key, index: trials.length }).slice(0, 24), candidate, status: options.signal?.aborted ? "CANCELLED" : "FAILED", metrics: null, cache_hit: false, early_stop_reason: options.signal?.aborted ? "cancelled" : null, failure: error instanceof Error ? error.message : String(error), started_at: started, ended_at: (options.now?.() ?? new Date()).toISOString() });
			if (options.signal?.aborted) break;
		}
	}
	const ranked = choose(trials);
	const pareto = ranked.filter((candidate) => !ranked.some((other) => other.id !== candidate.id && dominates(other.metrics, candidate.metrics)));
	const baselineTrial = ranked.find((item) => item.candidate.id === baseline.id);
	const recommended = ranked[0];
	const completed = options.now?.() ?? new Date();
	return {
		schema: "repoarena.optimization-run/v1",
		id: contentHash({ repositoryCommit: options.repositoryCommit, search: space, created: created.toISOString() }).slice(0, 24),
		status: options.signal?.aborted ? "CANCELLED" : candidates.length === 0 ? "NO_VALID_CANDIDATES" : exhausted ? "BUDGET_EXHAUSTED" : "COMPLETED",
		repository_commit: options.repositoryCommit,
		task_ids: [...space.tasks].sort(),
		holdout_task_ids: [...space.holdout_tasks].sort(),
		search_space_hash: contentHash(space),
		baseline_candidate_id: baseline.id,
		trials,
		pareto_candidate_ids: pareto.map((item) => item.candidate.id).sort(),
		recommendation: recommended?.metrics && baselineTrial?.metrics ? { candidate: recommended.candidate, metrics: recommended.metrics, baseline: baselineTrial.metrics, delta: { success_rate: recommended.metrics.success_rate - baselineTrial.metrics.success_rate, cost_micros: recommended.metrics.total_cost_micros === null || baselineTrial.metrics.total_cost_micros === null ? null : recommended.metrics.total_cost_micros - baselineTrial.metrics.total_cost_micros, duration_ms: recommended.metrics.median_duration_ms === null || baselineTrial.metrics.median_duration_ms === null ? null : recommended.metrics.median_duration_ms - baselineTrial.metrics.median_duration_ms }, explanation: `${recommended.candidate.agent}/${recommended.candidate.model} leads the evaluated Pareto set on deterministic correctness, cost, and duration ordering.`, sample_count: recommended.metrics.attempt_count } : null,
		budget: space.budget,
		consumed: { trials: trials.filter((item) => !item.cache_hit).length, attempts, cost_micros: cost, wall_time_ms: Math.max(0, completed.getTime() - created.getTime()) },
		created_at: created.toISOString(),
		completed_at: completed.toISOString(),
	};
}

export const serializeOptimizationRun = (run: OptimizationRun) => `${JSON.stringify(run, null, 2)}\n`;
export const exportRecommendedProfile = (run: OptimizationRun) => {
	if (!run.recommendation) throw new RangeError("optimization run has no recommendation");
	return stringify({ schema: "repoarena.profile/v1", source_optimization_run: run.id, agent: run.recommendation.candidate.agent, model: run.recommendation.candidate.model, reasoning: run.recommendation.candidate.reasoning, profile: run.recommendation.candidate.profile, options: run.recommendation.candidate.options }, { sortMapEntries: true });
};
export async function writeOptimizationRunAtomic(path: string, run: OptimizationRun): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.optimization-${crypto.randomUUID()}.tmp`);
	const file = await open(temporary, "wx", 0o600);
	try { await file.writeFile(serializeOptimizationRun(run), "utf8"); await file.sync(); } finally { await file.close(); }
	try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
