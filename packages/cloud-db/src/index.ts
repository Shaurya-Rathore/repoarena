import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, {
	type Pool,
	type PoolClient,
	type PoolConfig,
	type QueryResult,
	type QueryResultRow,
} from "pg";
import { z } from "zod";

const databaseUrlSchema = z
	.string()
	.url()
	.refine(
		(value) =>
			value.startsWith("postgresql://") || value.startsWith("postgres://"),
		"DATABASE_URL must use PostgreSQL",
	);
export type Database = Readonly<{
	pool: Pool;
	query<T extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[],
	): Promise<QueryResult<T>>;
	transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}>;

export const databaseConfig = (
	environment: NodeJS.ProcessEnv = process.env,
): PoolConfig => ({
	connectionString: databaseUrlSchema.parse(environment.DATABASE_URL),
	max: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(10)
		.parse(environment.DATABASE_POOL_SIZE),
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
	application_name: "repoarena-cloud",
	ssl:
		environment.DATABASE_SSL === "require"
			? { rejectUnauthorized: true }
			: undefined,
});

export const createDatabase = (
	config: PoolConfig = databaseConfig(),
): Database => {
	const pool = new pg.Pool(config);
	return {
		pool,
		query: (text, values) => pool.query(text, values ? [...values] : undefined),
		transaction: async (work) => {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				const result = await work(client);
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		},
		close: () => pool.end(),
	};
};

const migrationDirectory = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"migrations",
);
export async function migrate(
	database: Database,
	directory = migrationDirectory,
): Promise<readonly string[]> {
	return database.transaction(async (client) => {
		await client.query("SELECT pg_advisory_xact_lock($1)", [1_934_726_511]);
		await client.query(
			"CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		const applied: string[] = [];
		for (const file of (await readdir(directory))
			.filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
			.sort()) {
			const sql = await readFile(join(directory, file), "utf8");
			const checksum = createHash("sha256").update(sql).digest("hex");
			const existing = await client.query<{ checksum: string }>(
				"SELECT checksum FROM schema_migrations WHERE version = $1",
				[file],
			);
			if (existing.rowCount) {
				if (existing.rows[0]?.checksum !== checksum)
					throw new Error(`Released migration ${file} checksum changed`);
				continue;
			}
			await client.query(sql);
			await client.query(
				"INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2)",
				[file, checksum],
			);
			applied.push(file);
		}
		return applied;
	});
}

export function assertSafeTestDatabase(databaseUrl: string): URL {
	const parsed = new URL(databaseUrlSchema.parse(databaseUrl));
	if (
		!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
		parsed.pathname !== "/repoarena_test"
	) {
		throw new Error(
			"Destructive database test operations require the loopback repoarena_test database",
		);
	}
	return parsed;
}

export async function resetTestDatabase(
	database: Database,
	databaseUrl: string,
): Promise<void> {
	assertSafeTestDatabase(databaseUrl);
	await database.query(
		"DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO CURRENT_USER",
	);
}
