export type Usage = {
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
	reasoning_tokens?: number;
	tool_calls?: number;
};
export type UsageStatus = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
export type Price = {
	id: string;
	provider: string;
	model: string;
	effective_from: string;
	input_per_million: number;
	cached_input_per_million?: number;
	output_per_million: number;
	reasoning_per_million?: number;
	currency: "USD";
};
export type Cost = {
	micros: number;
	currency: "USD";
	pricing_id: string;
	usage: Usage;
};
export type PricingCatalog = Readonly<{
	version: string;
	prices: readonly Price[];
}>;
export type CostSnapshot = Readonly<{
	status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
	micros: number | null;
	currency: "USD";
	catalog_version: string;
	pricing_id: string | null;
	pricing_effective_from: string | null;
	usage: Usage;
}>;
export const estimateCost = (usage: Usage, price: Price): Cost => ({
	micros: Math.round(
		(((usage.input_tokens ?? 0) * price.input_per_million +
			(usage.cached_input_tokens ?? 0) *
				(price.cached_input_per_million ?? price.input_per_million) +
			(usage.output_tokens ?? 0) * price.output_per_million +
			(usage.reasoning_tokens ?? 0) * (price.reasoning_per_million ?? 0)) *
			1_000_000) /
			1_000_000,
	),
	currency: "USD",
	pricing_id: price.id,
	usage: { ...usage },
});

export function usageStatus(usage: Usage | null): UsageStatus {
	if (!usage || Object.keys(usage).length === 0) return "UNAVAILABLE";
	return usage.input_tokens !== undefined && usage.output_tokens !== undefined
		? "AVAILABLE"
		: "PARTIAL";
}

export function selectPrice(
	catalog: PricingCatalog,
	provider: string,
	model: string,
	at: string,
): Price | null {
	return (
		[...catalog.prices]
			.filter(
				(price) =>
					price.provider === provider &&
					price.model === model &&
					price.effective_from <= at,
			)
			.sort(
				(a, b) =>
					b.effective_from.localeCompare(a.effective_from) ||
					a.id.localeCompare(b.id),
			)[0] ?? null
	);
}

export function snapshotCost(
	catalog: PricingCatalog,
	provider: string,
	model: string,
	at: string,
	usage: Usage | null,
): CostSnapshot {
	const status = usageStatus(usage);
	const price = selectPrice(catalog, provider, model, at);
	if (!price || status === "UNAVAILABLE")
		return {
			status: "UNAVAILABLE",
			micros: null,
			currency: "USD",
			catalog_version: catalog.version,
			pricing_id: price?.id ?? null,
			pricing_effective_from: price?.effective_from ?? null,
			usage: { ...(usage ?? {}) },
		};
	const calculated = estimateCost(usage ?? {}, price);
	return {
		status,
		micros: calculated.micros,
		currency: "USD",
		catalog_version: catalog.version,
		pricing_id: price.id,
		pricing_effective_from: price.effective_from,
		usage: { ...(usage ?? {}) },
	};
}
