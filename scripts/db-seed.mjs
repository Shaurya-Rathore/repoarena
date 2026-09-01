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
	const plans = await database.query("SELECT id FROM plans ORDER BY id");
	process.stdout.write(
		`Canonical plans available: ${plans.rows.map((row) => row.id).join(", ")}\n`,
	);
} finally {
	await database.close();
}
