import { expect, it } from "vitest";
import { snapshotCost, type PricingCatalog } from "./index.js";

const catalog = (version: string, rate: number): PricingCatalog => ({
	version,
	prices: [
		{
			id: `model-${version}`,
			provider: "fake",
			model: "solver",
			effective_from: "2026-01-01",
			input_per_million: rate,
			output_per_million: rate,
			currency: "USD",
		},
	],
});
it("creates immutable cost provenance snapshots", () => {
	const usage = { input_tokens: 1_000_000, output_tokens: 0 };
	const old = snapshotCost(
		catalog("v1", 2),
		"fake",
		"solver",
		"2026-02-01",
		usage,
	);
	const current = snapshotCost(
		catalog("v2", 9),
		"fake",
		"solver",
		"2026-02-01",
		usage,
	);
	expect(old).toMatchObject({
		micros: 2_000_000,
		catalog_version: "v1",
		pricing_id: "model-v1",
	});
	expect(current).toMatchObject({
		micros: 9_000_000,
		catalog_version: "v2",
		pricing_id: "model-v2",
	});
	expect(JSON.parse(JSON.stringify(old)).micros).toBe(2_000_000);
});
it("keeps unknown pricing and usage explicit", () => {
	expect(
		snapshotCost(catalog("v1", 2), "fake", "unknown", "2026-02-01", {
			input_tokens: 1,
		}),
	).toMatchObject({ status: "UNAVAILABLE", micros: null });
	expect(
		snapshotCost(catalog("v1", 2), "fake", "solver", "2026-02-01", null),
	).toMatchObject({ status: "UNAVAILABLE", micros: null });
});
