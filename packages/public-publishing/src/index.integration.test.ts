import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { CloudService, type Principal } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { PublishingService } from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 12 });
const cloud = new CloudService(database);
const publishing = new PublishingService(
	database,
	cloud,
	() => new Date("2026-09-01T12:00:00Z"),
);

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

async function completedRun(
	owner: Principal,
	organizationId: string,
	visibility: "PUBLIC" | "PRIVATE" = "PUBLIC",
) {
	const repositoryId = await cloud.createRepository(owner, {
		organizationId,
		provider: "manual",
		externalId: randomUUID(),
		owner: "octo",
		name: `repo-${randomUUID().slice(0, 6)}`,
		defaultBranch: "main",
		visibility,
	});
	const task = await cloud.createTaskVersion(owner, {
		organizationId,
		repositoryId,
		taskKey: "task",
		title: "Task",
		publicTask: { schema: "repoarena.task/v1" },
		validationState: "READY",
		privatePayload: Buffer.from("hidden-evaluator-sentinel"),
	});
	const benchmark = await cloud.createBenchmark(owner, {
		organizationId,
		repositoryId,
		name: "Benchmark",
		configuration: {},
		taskVersionIds: [task.versionId],
	});
	const run = await cloud.createRun(owner, {
		organizationId,
		repositoryId,
		benchmarkVersionId: benchmark.versionId,
		idempotencyKey: randomUUID(),
	});
	await database.query(
		"UPDATE benchmark_runs SET state='COMPLETED',completed_at=now(),canonical_result=$2,result_hash=$3 WHERE id=$1",
		[
			run.runId,
			{
				schema: "repoarena.benchmark-run/v1",
				state: "COMPLETED",
				statistics: {
					task_count: 2,
					attempt_count: 4,
					solved_count: 3,
					success_rate: 0.75,
					pass_at_k: 0.9,
					median_duration_ms: 1200,
					total_cost_micros: 2500,
				},
				agents: [
					{ id: "codex", model: "gpt-test", private_config: "not-projected" },
				],
			},
			"a".repeat(64),
		],
	);
	return { repositoryId, runId: run.runId };
}

it("publishes an explicit safe projection, ranks it, serves a badge, and revokes it", async () => {
	const userId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Owner",
	});
	const owner: Principal = { type: "USER", userId };
	const organizationId = await cloud.createOrganization(
		userId,
		`publish-${randomUUID().slice(0, 8)}`,
		"Publish Org",
	);
	const { runId } = await completedRun(owner, organizationId);
	const published = await publishing.publish(owner, { organizationId, runId });
	expect(published.public_id).toMatch(/^rap_/);
	const serialized = JSON.stringify(
		await publishing.getPublic(published.public_id),
	);
	for (const forbidden of [
		"hidden-evaluator-sentinel",
		"private_config",
		"object_storage_key",
		"reference_solution",
	])
		expect(serialized).not.toContain(forbidden);
	const board = await publishing.leaderboard();
	expect(board.entries[0]).toMatchObject({
		public_id: published.public_id,
		eligibility: "ELIGIBLE",
	});
	expect(await publishing.badge(published.public_id)).toContain("75% solved");
	await publishing.unpublish(owner, organizationId, published.public_id);
	await expect(publishing.getPublic(published.public_id)).rejects.toThrow(
		"unavailable",
	);
});

it("enforces private confirmation and organization authorization", async () => {
	const ownerId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Private Owner",
	});
	const owner: Principal = { type: "USER", userId: ownerId };
	const organizationId = await cloud.createOrganization(
		ownerId,
		`private-${randomUUID().slice(0, 8)}`,
		"Private Org",
	);
	await cloud.setPlan(owner, organizationId, "PRO");
	const { runId } = await completedRun(owner, organizationId, "PRIVATE");
	await expect(
		publishing.publish(owner, { organizationId, runId }),
	).rejects.toThrow("explicit confirmation");
	expect(
		await publishing.publish(owner, {
			organizationId,
			runId,
			confirmPrivate: true,
		}),
	).toMatchObject({ repository: { visibility: "PRIVATE" } });
	const outsiderId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Outsider",
	});
	await expect(
		publishing.publish(
			{ type: "USER", userId: outsiderId },
			{ organizationId, runId, confirmPrivate: true },
		),
	).rejects.toThrow("Permission denied");
});
