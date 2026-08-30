export const passAtK = (n: number, c: number, k: number): number => {
	if (
		!Number.isInteger(n) ||
		!Number.isInteger(c) ||
		!Number.isInteger(k) ||
		n < 0 ||
		c < 0 ||
		c > n ||
		k < 1
	)
		throw new RangeError("invalid pass@k inputs");
	if (k > n) throw new RangeError("k exceeds attempts");
	if (c === 0) return 0;
	if (n - c < k) return 1;
	let product = 1;
	for (let i = 0; i < k; i++) product *= (n - c - i) / (n - i);
	return 1 - product;
};
export const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const m = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[m] ?? null)
		: ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2;
};
export const percentile = (values: number[], p: number) => {
	if (!values.length) return null;
	if (p < 0 || p > 1) throw new RangeError("p must be 0..1");
	const s = [...values].sort((a, b) => a - b);
	const i = (s.length - 1) * p;
	const l = Math.floor(i);
	const h = Math.ceil(i);
	return (s[l] ?? 0) + ((s[h] ?? 0) - (s[l] ?? 0)) * (i - l);
};

export type AttemptMetric = Readonly<{
	solved: boolean;
	duration_ms: number;
	cost_micros?: number;
	lines_added?: number;
	lines_removed?: number;
	failure_code?: string;
}>;
export type AggregateStatistics = Readonly<{
	attempt_count: number;
	solved_count: number;
	success_rate: number | null;
	pass_at_1: number | null;
	pass_at_k: number | null;
	median_duration_ms: number | null;
	p90_duration_ms: number | null;
	median_cost_micros: number | null;
	total_cost_micros: number | null;
	cost_per_solved_micros: number | null;
	lines_added: number;
	lines_removed: number;
	failures: Readonly<Record<string, number>>;
	mean_duration_ms?: number | null;
	p95_duration_ms?: number | null;
	p99_duration_ms?: number | null;
	variance_duration_ms?: number | null;
	stddev_duration_ms?: number | null;
	confidence_interval_95?: readonly [number, number] | null;
}>;

export function aggregateAttempts(
	attempts: readonly AttemptMetric[],
	k = 1,
): AggregateStatistics {
	if (!Number.isInteger(k) || k < 1) throw new RangeError("invalid k");
	const solved = attempts.filter((attempt) => attempt.solved).length;
	const costs = attempts.flatMap((attempt) =>
		attempt.cost_micros === undefined ? [] : [attempt.cost_micros],
	);
	const failures: Record<string, number> = {};
	for (const attempt of attempts)
		if (attempt.failure_code)
			failures[attempt.failure_code] =
				(failures[attempt.failure_code] ?? 0) + 1;
	const n = attempts.length;
	const durations = attempts.map((attempt) => attempt.duration_ms);
	const meanDuration = n
		? durations.reduce((sum, value) => sum + value, 0) / n
		: null;
	const variance =
		meanDuration === null
			? null
			: durations.reduce((sum, value) => sum + (value - meanDuration) ** 2, 0) /
				n;
	const standardError =
		variance === null || n === 0 ? null : Math.sqrt(variance / n);
	const totalCost = costs.length
		? costs.reduce((sum, cost) => sum + cost, 0)
		: null;
	return {
		attempt_count: n,
		solved_count: solved,
		success_rate: n ? solved / n : null,
		pass_at_1: n ? passAtK(n, solved, 1) : null,
		pass_at_k: n && k <= n ? passAtK(n, solved, k) : null,
		median_duration_ms: median(attempts.map((attempt) => attempt.duration_ms)),
		p90_duration_ms: percentile(
			attempts.map((attempt) => attempt.duration_ms),
			0.9,
		),
		median_cost_micros: median(costs),
		total_cost_micros: totalCost,
		cost_per_solved_micros:
			totalCost === null || solved === 0 ? null : totalCost / solved,
		lines_added: attempts.reduce(
			(sum, attempt) => sum + (attempt.lines_added ?? 0),
			0,
		),
		lines_removed: attempts.reduce(
			(sum, attempt) => sum + (attempt.lines_removed ?? 0),
			0,
		),
		failures: Object.fromEntries(
			Object.entries(failures).sort(([a], [b]) => a.localeCompare(b)),
		),
		mean_duration_ms: meanDuration,
		p95_duration_ms: percentile(durations, 0.95),
		p99_duration_ms: percentile(durations, 0.99),
		variance_duration_ms: variance,
		stddev_duration_ms: variance === null ? null : Math.sqrt(variance),
		confidence_interval_95:
			meanDuration === null || standardError === null
				? null
				: [
						meanDuration - 1.96 * standardError,
						meanDuration + 1.96 * standardError,
					],
	};
}
