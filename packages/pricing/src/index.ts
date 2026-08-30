export type Usage = {
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
	reasoning_tokens?: number;
	tool_calls?: number;
};
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
