import { performance } from "node:perf_hooks";
import { createCloudProduct } from "../packages/cloud-product/dist/index.js";

const product = createCloudProduct({
	cloudOrigin: "http://127.0.0.1:9",
	publicOrigin: "http://127.0.0.1",
});
const address = await product.start("127.0.0.1", 0);
try {
	const durations = [];
	const started = performance.now();
	for (let batch = 0; batch < 10; batch++) {
		await Promise.all(
			Array.from({ length: 20 }, async (_, index) => {
				const before = performance.now();
				const response = await fetch(
					`${address.url}${index % 2 ? "/" : "/health/live"}`,
				);
				if (!response.ok)
					throw new Error(`Performance request failed: ${response.status}`);
				await response.arrayBuffer();
				durations.push(performance.now() - before);
			}),
		);
	}
	const elapsed = performance.now() - started;
	durations.sort((a, b) => a - b);
	const percentile = (value) =>
		durations[
			Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)
		];
	const result = {
		requests: durations.length,
		concurrency: 20,
		errors: 0,
		throughput_rps: Math.round((durations.length * 1000) / elapsed),
		p50_ms: Number(percentile(0.5).toFixed(2)),
		p95_ms: Number(percentile(0.95).toFixed(2)),
		max_ms: Number(durations.at(-1).toFixed(2)),
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	await product.close();
}
