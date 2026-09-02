import { createServer } from "node:http";
import { createCloudProduct } from "../packages/cloud-product/dist/index.js";

const upstream = createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url?.startsWith("/api/v1/public/leaderboard"))
		return response.end('{"data":{"entries":[]}}');
	response.statusCode = 401;
	response.end('{"error":{"message":"Unauthenticated"}}');
});
await new Promise((resolve, reject) => {
	upstream.once("error", reject);
	upstream.listen(0, "127.0.0.1", resolve);
});
const address = upstream.address();
if (!address || typeof address === "string")
	throw new Error("Upstream did not start.");
const product = createCloudProduct({
	cloudOrigin: `http://127.0.0.1:${address.port}`,
	publicOrigin: "http://127.0.0.1",
});
const started = await product.start("127.0.0.1", 0);
try {
	const home = await fetch(started.url);
	if (!home.ok || !(await home.text()).includes("CI for AI coding agents"))
		throw new Error("Built landing page failed.");
	const leaderboard = await fetch(`${started.url}/leaderboard`);
	if (
		!leaderboard.ok ||
		!(await leaderboard.text()).includes("No eligible published benchmarks")
	)
		throw new Error("Built leaderboard failed.");
	const app = await fetch(`${started.url}/app`, { redirect: "manual" });
	if (app.status !== 302 || !app.headers.get("location")?.startsWith("/signin"))
		throw new Error("Built auth redirect failed.");
	process.stdout.write(`CLOUD_PRODUCT_BUILT_E2E_OK ${started.url}\n`);
} finally {
	await product.close();
	await new Promise((resolve, reject) =>
		upstream.close((error) => (error ? reject(error) : resolve())),
	);
}
