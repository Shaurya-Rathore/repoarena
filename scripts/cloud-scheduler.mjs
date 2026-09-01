import { readFile } from "node:fs/promises";
import { CloudService } from "../packages/cloud-core/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";
import { CloudScheduler } from "../packages/cloud-worker/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
const database = createDatabase();
try {
	process.stdout.write(
		`Enqueued ${await new CloudScheduler(new CloudService(database)).runOnce()} scheduled run(s).\n`,
	);
} finally {
	await database.close();
}
