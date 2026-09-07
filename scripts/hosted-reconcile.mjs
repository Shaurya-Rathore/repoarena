import { readFile } from "node:fs/promises";
import { CloudService } from "../packages/cloud-core/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";
import {
	HostedComputeService,
	HttpHostedComputeProvider,
} from "../packages/hosted-compute/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
if (
	!process.env.HOSTED_COMPUTE_PROVISIONER_URL ||
	!process.env.HOSTED_COMPUTE_PROVISIONER_TOKEN
)
	throw new Error("Hosted provisioner configuration is required");
const database = createDatabase();
try {
	const cloud = new CloudService(database);
	const hosted = new HostedComputeService(
		database,
		cloud,
		new HttpHostedComputeProvider(
			process.env.HOSTED_COMPUTE_PROVISIONER_URL,
			process.env.HOSTED_COMPUTE_PROVISIONER_TOKEN,
		),
	);
	process.stdout.write(`${JSON.stringify(await hosted.reconcile())}\n`);
} finally {
	await database.close();
}
