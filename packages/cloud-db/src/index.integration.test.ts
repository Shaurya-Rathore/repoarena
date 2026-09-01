import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { createDatabase, migrate, resetTestDatabase } from "./index.js";

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
	expect(rows.rowCount).toBe(1);
});
