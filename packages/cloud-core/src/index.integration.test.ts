import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { FileObjectStorage } from "@repoarena/object-storage";
import { ArtifactService, CloudService, type Principal } from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 20 });
let clock = new Date("2026-09-01T00:00:00.000Z");
const service = new CloudService(database, () => clock);

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

const foundation = async (suffix: string) => {
	const userId = await service.createUser({
		provider: "mock",
		subject: `user-${suffix}`,
		displayName: "Owner",
	});
	const principal: Principal = { type: "USER", userId };
	const organizationId = await service.createOrganization(
		userId,
		`org-${suffix}`,
		"Organization",
	);
	await service.setPlan(principal, organizationId, "TEAM");
	const repositoryId = await service.createRepository(principal, {
		organizationId,
		provider: "manual",
		externalId: `repo-${suffix}`,
		owner: "owner",
		name: "repo",
		defaultBranch: "main",
		visibility: "PRIVATE",
	});
	const task = await service.createTaskVersion(principal, {
		organizationId,
		repositoryId,
		taskKey: "task",
		title: "Task",
		publicTask: { schema: "repoarena.task/v1", id: `task-${suffix}` },
		validationState: "READY",
		privatePayload: Buffer.from("HIDDEN-EVALUATOR-SENTINEL"),
	});
	const benchmark = await service.createBenchmark(principal, {
		organizationId,
		repositoryId,
		name: "Benchmark",
		configuration: { runs_per_task: 1 },
		taskVersionIds: [task.versionId],
	});
	return { userId, principal, organizationId, repositoryId, task, benchmark };
};

it("enforces organization isolation, plans, public task projection, sessions and API-key revocation", async () => {
	const left = await foundation(randomUUID().slice(0, 8));
	const right = await foundation(randomUUID().slice(0, 8));
	await expect(
		service.getPublicTask(
			right.principal,
			left.organizationId,
			left.task.versionId,
		),
	).rejects.toThrow("Permission denied");
	expect(
		JSON.stringify(
			await service.getPublicTask(
				left.principal,
				left.organizationId,
				left.task.versionId,
			),
		),
	).not.toContain("HIDDEN-EVALUATOR-SENTINEL");
	const session = await service.createSession(left.userId);
	expect(
		await service.authenticateSession(session.token, session.csrf),
	).toEqual(left.principal);
	await expect(
		service.authenticateSession(session.token, "wrong-csrf"),
	).rejects.toThrow("Session is invalid");
	await service.revokeSession(session.token);
	await expect(service.authenticateSession(session.token)).rejects.toThrow(
		"Session is invalid",
	);
	const key = await service.createApiKey(
		left.principal,
		left.organizationId,
		left.userId,
		"CI",
		["BENCHMARK_RUN"],
	);
	const machine = await service.authenticateApiKey(key.key, "BENCHMARK_RUN");
	expect(machine).toMatchObject({
		type: "API_KEY",
		organizationId: left.organizationId,
	});
	await expect(
		service.authenticateApiKey(key.key, "API_KEY_MANAGE"),
	).rejects.toThrow("lacks scope");
	await service.revokeApiKey(left.principal, left.organizationId, key.id);
	await expect(service.authenticateApiKey(key.key)).rejects.toThrow(
		"API key is invalid",
	);
});

it("applies current entitlements and protects membership ownership", async () => {
	const owner = await service.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Owner",
	});
	const actor: Principal = { type: "USER", userId: owner };
	const organizationId = await service.createOrganization(
		owner,
		`community-${randomUUID().slice(0, 8)}`,
		"Community",
	);
	await expect(
		service.createRepository(actor, {
			organizationId,
			provider: "manual",
			owner: "o",
			name: "private",
			defaultBranch: "main",
			visibility: "PRIVATE",
		}),
	).rejects.toThrow("does not allow private");
	const member = await service.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Member",
	});
	await expect(
		service.setMembership(actor, organizationId, member, "VIEWER"),
	).rejects.toThrow("Member entitlement limit");
	await service.setPlan(actor, organizationId, "PRO");
	await service.createRepository(actor, {
		organizationId,
		provider: "manual",
		owner: "o",
		name: "private-pro",
		defaultBranch: "main",
		visibility: "PRIVATE",
	});
	await service.setPlan(actor, organizationId, "TEAM");
	await service.setMembership(actor, organizationId, member, "VIEWER");
	expect(await service.listMemberships(actor, organizationId)).toHaveLength(2);
	await expect(
		service.setMembership(actor, organizationId, owner, "ADMIN"),
	).rejects.toThrow("retain an active owner");
	const bucket = `test:${randomUUID()}`;
	expect(await service.consumeRateLimit(bucket, 1, 60_000)).toEqual({
		allowed: true,
		remaining: 0,
	});
	expect(await service.consumeRateLimit(bucket, 1, 60_000)).toEqual({
		allowed: false,
		remaining: 0,
	});
});

it("creates a run and job atomically and preserves idempotency", async () => {
	const context = await foundation(randomUUID().slice(0, 8));
	const input = {
		organizationId: context.organizationId,
		repositoryId: context.repositoryId,
		benchmarkVersionId: context.benchmark.versionId,
		idempotencyKey: "stable-create",
		budget: { max_attempts: 2 },
	};
	const first = await service.createRun(context.principal, input);
	const replay = await service.createRun(context.principal, input);
	expect(replay).toEqual({ ...first, replay: true });
	await expect(
		service.createRun(context.principal, {
			...input,
			budget: { max_attempts: 3 },
		}),
	).rejects.toThrow("different request");
	const rows = await database.query(
		"SELECT id FROM jobs WHERE benchmark_run_id=$1",
		[first.runId],
	);
	expect(rows.rowCount).toBe(1);
});

it("claims jobs exactly once across connections, reclaims expired leases and submits results idempotently", async () => {
	const context = await foundation(randomUUID().slice(0, 8));
	const first = await service.createRun(context.principal, {
		organizationId: context.organizationId,
		repositoryId: context.repositoryId,
		benchmarkVersionId: context.benchmark.versionId,
		idempotencyKey: randomUUID(),
	});
	const runnerA = await service.registerRunner(
		context.principal,
		context.organizationId,
		"runner-a",
		{ platform: "darwin", sandbox: "local" },
		"1.0.0",
	);
	const runnerB = await service.registerRunner(
		context.principal,
		context.organizationId,
		"runner-b",
		{ platform: "darwin", sandbox: "local" },
		"1.0.0",
	);
	const principalA = (await service.authenticateRunner(
		runnerA.token,
	)) as Extract<Principal, { type: "RUNNER" }>;
	const principalB = (await service.authenticateRunner(
		runnerB.token,
	)) as Extract<Principal, { type: "RUNNER" }>;
	await service.heartbeat(principalA);
	await service.heartbeat(principalB);
	const [claimA, claimB] = await Promise.all([
		service.claimJob(principalA, 1_000),
		service.claimJob(principalB, 1_000),
	]);
	expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
	const owner = claimA ? principalA : principalB;
	const other = claimA ? principalB : principalA;
	const claim = claimA ?? claimB;
	await expect(
		service.submitResult(other, first.jobId, {
			schema: "repoarena.benchmark-run/v1",
		}),
	).rejects.toThrow("does not own");
	clock = new Date(clock.getTime() + 2_000);
	const reclaimed = await service.claimJob(other, 1_000);
	expect(reclaimed?.id).toBe(claim?.id);
	const canonical = {
		schema: "repoarena.benchmark-run/v1",
		id: first.runId,
		status: "COMPLETED",
		attempts: [],
	};
	const usageId = await service.recordUsage(other, {
		runId: first.runId,
		type: "MODEL_TOKENS",
		provider: "fake",
		model: "deterministic",
		quantity: { input_tokens: 10 },
		cost: { micros: 20 },
	});
	expect(
		await service.recordUsage(other, {
			runId: first.runId,
			type: "MODEL_TOKENS",
			quantity: { input_tokens: 999 },
		}),
	).toBe(usageId);
	expect(await service.submitResult(other, first.jobId, canonical)).toEqual({
		replay: false,
	});
	expect(await service.submitResult(other, first.jobId, canonical)).toEqual({
		replay: true,
	});
	await expect(
		service.submitResult(other, first.jobId, {
			...canonical,
			status: "FAILED",
		}),
	).rejects.toThrow("Conflicting result replay");
	expect(await service.staleRunner(owner.runnerId, 500)).toBe(true);
});

it("prevents duplicate scheduled occurrences across scheduler instances", async () => {
	const context = await foundation(randomUUID().slice(0, 8));
	const scheduleId = await service.createSchedule(context.principal, {
		organizationId: context.organizationId,
		benchmarkVersionId: context.benchmark.versionId,
		cadence: "DAILY",
		nextRunAt: clock.toISOString(),
	});
	const second = new CloudService(database, () => clock);
	await Promise.all([service.schedulerTick(), second.schedulerTick()]);
	const occurrences = await database.query(
		"SELECT benchmark_run_id FROM schedule_occurrences WHERE schedule_id=$1",
		[scheduleId],
	);
	const jobs = await database.query(
		"SELECT j.id FROM jobs j JOIN schedule_occurrences so ON so.benchmark_run_id=j.benchmark_run_id WHERE so.schedule_id=$1",
		[scheduleId],
	);
	expect(occurrences.rowCount).toBe(1);
	expect(jobs.rowCount).toBe(1);
});

it("matches capabilities and enforces scoped job credentials, retries and runner revocation", async () => {
	const context = await foundation(randomUUID().slice(0, 8));
	const first = await service.createRun(context.principal, {
		organizationId: context.organizationId,
		repositoryId: context.repositoryId,
		benchmarkVersionId: context.benchmark.versionId,
		idempotencyKey: randomUUID(),
	});
	await database.query(
		"UPDATE jobs SET requirements=$2,priority=100 WHERE id=$1",
		[first.jobId, { platform: "linux", sandbox: "docker" }],
	);
	const registration = await service.registerRunner(
		context.principal,
		context.organizationId,
		"capability-runner",
		{ platform: "linux", sandbox: "local" },
		"1",
	);
	const runner = (await service.authenticateRunner(
		registration.token,
	)) as Extract<Principal, { type: "RUNNER" }>;
	expect(await service.claimJob(runner)).toBeNull();
	await service.heartbeat(runner, { platform: "linux", sandbox: "docker" });
	const claim = await service.claimJob(runner, 86_400_000);
	expect(claim?.id).toBe(first.jobId);
	expect(
		await service.authenticateJobCredential(
			claim?.credential ?? "",
			first.jobId,
			"result:write",
		),
	).toEqual(runner);
	await expect(
		service.authenticateJobCredential(
			claim?.credential ?? "",
			randomUUID(),
			"result:write",
		),
	).rejects.toThrow("invalid or lacks scope");
	await service.failJob(runner, first.jobId, "TRANSIENT", "retry", true);
	expect(
		(
			await database.query<{ state: string }>(
				"SELECT state FROM jobs WHERE id=$1",
				[first.jobId],
			)
		).rows[0]?.state,
	).toBe("QUEUED");
	clock = new Date(clock.getTime() + 3_000);
	await service.claimJob(runner);
	await service.failJob(runner, first.jobId, "FATAL", "safe diagnostic", false);
	const dead = await database.query<{
		state: string;
		attempt_count: number;
		final_error_message: string;
	}>("SELECT state,attempt_count,final_error_message FROM jobs WHERE id=$1", [
		first.jobId,
	]);
	expect(dead.rows[0]).toMatchObject({
		state: "DEAD_LETTER",
		attempt_count: 2,
		final_error_message: "safe diagnostic",
	});
	await service.revokeRunner(
		context.principal,
		context.organizationId,
		registration.id,
	);
	await expect(service.authenticateRunner(registration.token)).rejects.toThrow(
		"invalid",
	);
});

it("authorizes artifact allocation, checksum finalization and tenant-scoped reads", async () => {
	const context = await foundation(randomUUID().slice(0, 8));
	const outsider = await foundation(randomUUID().slice(0, 8));
	const run = await service.createRun(context.principal, {
		organizationId: context.organizationId,
		repositoryId: context.repositoryId,
		benchmarkVersionId: context.benchmark.versionId,
		idempotencyKey: randomUUID(),
	});
	const registration = await service.registerRunner(
		context.principal,
		context.organizationId,
		"artifact-runner",
		{},
		"1",
	);
	const runner = (await service.authenticateRunner(
		registration.token,
	)) as Extract<Principal, { type: "RUNNER" }>;
	await service.heartbeat(runner);
	await service.claimJob(runner);
	const root = await mkdtemp(join(tmpdir(), "repoarena-cloud-objects-"));
	const storage = new FileObjectStorage(root);
	const artifacts = new ArtifactService(database, storage, service);
	try {
		const key = await artifacts.allocate(runner, run.jobId);
		const bytes = Buffer.from("safe artifact");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await storage.put(key, bytes, {
			contentType: "text/plain",
			checksum: sha256,
		});
		const id = await artifacts.finalize(runner, {
			jobId: run.jobId,
			key,
			logicalPath: "logs/output.txt",
			sha256,
			size: bytes.length,
			mediaType: "text/plain",
			visibility: "PRIVATE",
		});
		expect(
			await artifacts.signedRead(context.principal, context.organizationId, id),
		).toContain(encodeURIComponent(key));
		await expect(
			artifacts.signedRead(outsider.principal, context.organizationId, id),
		).rejects.toThrow("Permission denied");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
