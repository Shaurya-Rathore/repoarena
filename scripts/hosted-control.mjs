import { readFile } from "node:fs/promises";
import { createDatabase } from "../packages/cloud-db/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
const action = process.argv[2] ?? "status";
if (
	!["status", "enable", "disable", "emergency-stop", "resume"].includes(action)
)
	throw new Error(
		"Usage: pnpm hosted:control [status|enable|disable|emergency-stop|resume]",
	);
const database = createDatabase();
try {
	if (action !== "status") {
		const values =
			action === "enable"
				? [true, false]
				: action === "resume"
					? [true, false]
					: action === "emergency-stop"
						? [false, true]
						: [false, false];
		await database.query(
			"UPDATE hosted_compute_settings SET enabled=$1,emergency_stop=$2,updated_at=now() WHERE singleton=true",
			values,
		);
	}
	const state = (
		await database.query(
			"SELECT enabled,emergency_stop,environment,deployment_id,global_max_active,global_max_queued,updated_at FROM hosted_compute_settings WHERE singleton=true",
		)
	).rows[0];
	process.stdout.write(`${JSON.stringify(state)}\n`);
} finally {
	await database.close();
}
