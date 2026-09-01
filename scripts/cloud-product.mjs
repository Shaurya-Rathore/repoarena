import { readFile } from "node:fs/promises";

if (!process.env.CLOUD_API_ORIGIN || !process.env.CLOUD_PRODUCT_ORIGIN) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	).catch(() => "");
	process.env.CLOUD_API_ORIGIN ??= local.match(/^CLOUD_API_ORIGIN=(.+)$/m)?.[1];
	process.env.CLOUD_PRODUCT_ORIGIN ??= local.match(
		/^CLOUD_PRODUCT_ORIGIN=(.+)$/m,
	)?.[1];
}
const { createCloudProduct } = await import(
	"../packages/cloud-product/dist/index.js"
);
const origin = process.env.CLOUD_PRODUCT_ORIGIN ?? "http://127.0.0.1:3000";
const parsed = new URL(origin);
if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))
	throw new Error("Cloud product development server must bind to loopback.");
const product = createCloudProduct({
	cloudOrigin: process.env.CLOUD_API_ORIGIN ?? "http://127.0.0.1:8787",
	publicOrigin: origin,
});
const started = await product.start(
	parsed.hostname,
	Number(parsed.port || 3000),
);
process.stdout.write(`RepoArena Cloud product listening on ${started.url}\n`);
for (const signal of ["SIGINT", "SIGTERM"])
	process.once(signal, async () => {
		await product.close();
		process.exit(0);
	});
