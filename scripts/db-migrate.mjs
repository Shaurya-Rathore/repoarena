import { readFile } from "node:fs/promises";
import { createDatabase, migrate } from "../packages/cloud-db/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
const database = createDatabase();
try {
	const applied = await migrate(database);
	process.stdout.write(
		`${applied.length ? `Applied ${applied.join(", ")}` : "Database is current."}\n`,
	);
} finally {
	await database.close();
}
