import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
	schemaCompatibility,
} from "./index.js";

const source = process.env.DATABASE_URL ?? "";
const parsed = new URL(source);
parsed.pathname = "/repoarena_test";
const testUrl = parsed.toString();
const database = createDatabase({ connectionString: testUrl, max: 8 });

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

it("applies a fresh migration and enforces tenant constraints", async () => {
	const tables = await database.query<{ table_name: string }>(
		"SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
	);
	expect(tables.rows.map((row) => row.table_name)).toEqual(
		expect.arrayContaining([
			"organizations",
			"jobs",
			"runners",
			"task_private_versions",
			"github_installations",
			"github_webhook_deliveries",
			"public_run_publications",
			"readiness_snapshots",
			"optimization_runs",
		]),
	);
	const user = randomUUID();
	await database.query(
		"INSERT INTO users(id,provider,provider_subject,display_name) VALUES($1,'mock',$2,'Test')",
		[user, user],
	);
	const organization = randomUUID();
	await database.query(
		"INSERT INTO organizations(id,slug,display_name,plan_id) VALUES($1,$2,'Test','COMMUNITY')",
		[organization, `test-${organization.slice(0, 8)}`],
	);
	await database.query(
		"INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",
		[organization, user],
	);
	await expect(
		database.query(
			"INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')",
			[organization, user],
		),
	).rejects.toMatchObject({ code: "23505" });
});

it("rolls back failed transactions", async () => {
	const id = randomUUID();
	await expect(
		database.transaction(async (client) => {
			await client.query(
				"INSERT INTO users(id,provider,provider_subject,display_name) VALUES($1,'mock',$2,'Rollback')",
				[id, id],
			);
			throw new Error("fail halfway");
		}),
	).rejects.toThrow("fail halfway");
	const row = await database.query("SELECT 1 FROM users WHERE id=$1", [id]);
	expect(row.rowCount).toBe(0);
});

it("serializes concurrent migration startup with an advisory lock", async () => {
	await Promise.all([migrate(database), migrate(database)]);
	const rows = await database.query("SELECT version FROM schema_migrations");
	expect(rows.rowCount).toBe(8);
});

it("classifies current, behind, and incompatible schema versions", async () => {
	expect(await schemaCompatibility(database)).toMatchObject({
		status: "CURRENT",
		expected: 8,
	});
	const latest = await database.query<{ checksum: string }>(
		"DELETE FROM schema_migrations WHERE version='0008_hosted_compute.sql' RETURNING checksum",
	);
	expect(await schemaCompatibility(database)).toMatchObject({
		status: "BEHIND",
		applied: 7,
	});
	await database.query(
		"INSERT INTO schema_migrations(version,checksum) VALUES('0008_hosted_compute.sql',$1)",
		[latest.rows[0]?.checksum],
	);
	await database.query(
		"INSERT INTO schema_migrations(version,checksum) VALUES('9999_unknown.sql',$1)",
		["0".repeat(64)],
	);
	expect(await schemaCompatibility(database)).toMatchObject({
		status: "AHEAD_OR_INCOMPATIBLE",
	});
	await database.query(
		"DELETE FROM schema_migrations WHERE version='9999_unknown.sql'",
	);
});

it("migrates a supported v1 fixture forward without losing data", async () => {
	await resetTestDatabase(database, testUrl);
	const directory = await mkdtemp(join(tmpdir(), "repoarena-migrations-v1-"));
	try {
		const first = await readFile(
			new URL("../migrations/0001_cloud_core.sql", import.meta.url),
			"utf8",
		);
		await writeFile(join(directory, "0001_cloud_core.sql"), first);
		await migrate(database, directory);
		await database.query(
			"INSERT INTO users(id,provider,provider_subject,display_name) VALUES($1,'fixture','preserved','Preserved')",
			[randomUUID()],
		);
		await migrate(database);
		const preserved = await database.query(
			"SELECT display_name FROM users WHERE provider_subject='preserved'",
		);
		const column = await database.query(
			"SELECT 1 FROM information_schema.columns WHERE table_name='artifacts' AND column_name='published_at'",
		);
		const metricColumn = await database.query(
			"SELECT 1 FROM information_schema.columns WHERE table_name='metric_events' AND column_name='recorded_at'",
		);
		expect(preserved.rows[0]).toMatchObject({ display_name: "Preserved" });
		expect(column.rowCount).toBe(1);
		expect(metricColumn.rowCount).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
