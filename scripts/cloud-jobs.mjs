import { readFile } from "node:fs/promises";
import { createDatabase } from "../packages/cloud-db/dist/index.js";
if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
const database = createDatabase();
try {
	const result = await database.query(
		"SELECT state,count(*)::integer AS count,min(created_at) AS oldest FROM jobs GROUP BY state ORDER BY state",
	);
	process.stdout.write(`${JSON.stringify({ jobs: result.rows }, null, 2)}\n`);
} finally {
	await database.close();
}
