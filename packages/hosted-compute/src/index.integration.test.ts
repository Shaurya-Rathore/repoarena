import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import { CloudService, type Principal } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import {
	DeterministicHostedComputeProvider,
	HostedComputeService,
} from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 20 });
let clock = new Date("2032-01-01T00:00:00.000Z");
const cloud = new CloudService(database, () => clock);
const provider = new DeterministicHostedComputeProvider();
const hosted = new HostedComputeService(database, cloud, provider, () => clock);
type StateRow = { state: string; failure_code: string | null };
type UsageRow = {
	cost_micros: string;
	pricing_snapshot: { version: string; rate_micros_per_minute: number };
};

beforeEach(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
	clock = new Date("2032-01-01T00:00:00.000Z");
	provider.scenario = "SUCCESS";
	provider.resources.clear();
	provider.provisionCalls.length = 0;
	provider.terminationCalls.length = 0;
});
afterAll(() => database.close());
const foundation = async (suffix = randomUUID().slice(0, 8)) => {
	const userId = await cloud.createUser({
		provider: "mock",
		subject: `u-${suffix}`,
		displayName: "Owner",
	});
	const principal: Principal = { type: "USER", userId };
	const organizationId = await cloud.createOrganization(
		userId,
		`hosted-${suffix}`,
		"Hosted",
	);
	await cloud.setPlan(principal, organizationId, "ENTERPRISE");
	const repositoryId = await cloud.createRepository(principal, {
		organizationId,
		provider: "manual",
		externalId: `r-${suffix}`,
		owner: "o",
		name: "r",
		defaultBranch: "main",
		visibility: "PRIVATE",
	});
	const task = await cloud.createTaskVersion(principal, {
		organizationId,
		repositoryId,
		taskKey: "t",
		title: "T",
		publicTask: { schema: "repoarena.task/v1", id: `t-${suffix}` },
		validationState: "READY",
		privatePayload: Buffer.from("PRIVATE_EVALUATOR_SENTINEL"),
	});
	const benchmark = await cloud.createBenchmark(principal, {
		organizationId,
		repositoryId,
		name: "B",
		configuration: { runs_per_task: 1 },
		taskVersionIds: [task.versionId],
	});
	await database.query(
		"INSERT INTO organization_hosted_policies(organization_id,max_concurrency,max_queued,monthly_budget_micros) VALUES($1,1,10,1000000)",
		[organizationId],
	);
	return { principal, organizationId, repositoryId, benchmark };
};
const enable = () =>
	database.query(
		"UPDATE hosted_compute_settings SET enabled=true,global_max_active=1,global_max_queued=100,environment='test',deployment_id='suite'",
	);

it("runs the canonical job protocol, meters immutable pricing, and revokes ephemeral runner", async () => {
	await enable();
	const f = await foundation();
	const run = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "hosted-flow",
		budget: { max_attempts: 1 },
	});
	const request = await hosted.request(f.principal, {
		organizationId: f.organizationId,
		runId: run.runId,
		jobId: run.jobId,
		resourceClassId: "SMALL",
		maxWallTimeMs: 60000,
		networkPolicy: "NETWORK_DISABLED",
		computeBudgetMicros: 12000,
	});
	const boot = await hosted.provisionNext();
	expect(boot?.leaseId).toBe(request.leaseId);
	const authenticated = await cloud.authenticateRunner(boot?.runnerToken ?? "");
	if (authenticated.type !== "RUNNER") throw new Error("expected runner");
	const runner = authenticated;
	await cloud.heartbeat(runner);
	await hosted.runnerHeartbeat(runner.runnerId);
	const claim = await cloud.claimJob(runner);
	expect(claim?.id).toBe(run.jobId);
	await hosted.runnerClaimed(runner.runnerId, run.jobId);
	await cloud.submitResult(runner, run.jobId, {
		statistics: { attempt_count: 1, solved_count: 1 },
		cost_micros: 77,
	});
	clock = new Date(clock.getTime() + 30000);
	await hosted.resultSubmitted(runner.runnerId, run.jobId);
	const usage: UsageRow[] = (
		await database.query<UsageRow>(
			"SELECT * FROM hosted_compute_usage WHERE hosted_execution_lease_id=$1",
			[request.leaseId],
		)
	).rows;
	expect(usage).toHaveLength(1);
	expect(Number(usage[0]?.cost_micros)).toBe(12000);
	await database.query(
		"UPDATE hosted_resource_classes SET rate_micros_per_minute=999999,pricing_version='v2' WHERE id='SMALL' AND version=1",
	);
	expect(
		(
			await database.query<UsageRow>(
				"SELECT pricing_snapshot,cost_micros FROM hosted_compute_usage WHERE hosted_execution_lease_id=$1",
				[request.leaseId],
			)
		).rows[0],
	).toMatchObject({
		pricing_snapshot: { version: "2026-09-v1", rate_micros_per_minute: 12000 },
		cost_micros: "12000",
	});
	await expect(
		cloud.authenticateRunner(boot?.runnerToken ?? ""),
	).rejects.toThrow("invalid");
});

it("enforces transactional capacity, budgets, cancellation, and exact tenant placement", async () => {
	await database.query(
		"UPDATE hosted_resource_classes SET rate_micros_per_minute=12000,pricing_version='2026-09-v1' WHERE id='SMALL' AND version=1",
	);
	await enable();
	const f = await foundation();
	const make = async (key: string) => {
		const run = await cloud.createRun(f.principal, {
			organizationId: f.organizationId,
			repositoryId: f.repositoryId,
			benchmarkVersionId: f.benchmark.versionId,
			idempotencyKey: key,
		});
		return {
			run,
			lease: await hosted.request(f.principal, {
				organizationId: f.organizationId,
				runId: run.runId,
				jobId: run.jobId,
				resourceClassId: "SMALL",
				maxWallTimeMs: 60000,
				networkPolicy: "NETWORK_DISABLED",
				computeBudgetMicros: 12000,
			}),
		};
	};
	const [a, b] = await Promise.all([make("cap-a"), make("cap-b")]);
	const provisions = await Promise.all([
		hosted.provisionNext(),
		hosted.provisionNext(),
	]);
	expect(provisions.filter(Boolean)).toHaveLength(1);
	expect(
		provider.provisionCalls.filter(
			(c) => c.leaseId === a.lease.leaseId || c.leaseId === b.lease.leaseId,
		),
	).toHaveLength(1);
	const active = provisions.find(Boolean);
	await hosted.cancel(f.principal, f.organizationId, active?.leaseId ?? "");
	expect(await hosted.provisionNext()).not.toBeNull();
	const run = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "budget",
	});
	await expect(
		hosted.request(f.principal, {
			organizationId: f.organizationId,
			runId: run.runId,
			jobId: run.jobId,
			resourceClassId: "SMALL",
			maxWallTimeMs: 60000,
			networkPolicy: "NETWORK_DISABLED",
			computeBudgetMicros: 11999,
		}),
	).rejects.toThrow("budget");
});

it("cleans only strongly identified orphans and redacts provider secrets", async () => {
	await enable();
	provider.addResource({
		id: "managed-orphan",
		state: "RUNNING",
		labels: {
			managed_by: "repoarena",
			environment: "test",
			deployment_id: "suite",
			lease_id: randomUUID(),
		},
	});
	provider.addResource({
		id: "foreign",
		state: "RUNNING",
		labels: {
			managed_by: "somebody-else",
			environment: "test",
			deployment_id: "suite",
			lease_id: "x",
		},
	});
	const result = await hosted.reconcile();
	expect(result.terminatedOrphans).toBeGreaterThanOrEqual(1);
	expect(provider.terminationCalls).toContain("managed-orphan");
	expect(provider.terminationCalls).not.toContain("foreign");
	expect(
		JSON.stringify(
			await database.query(
				"SELECT failure_code,safe_failure_message FROM hosted_execution_leases",
			),
		),
	).not.toContain("PRIVATE_EVALUATOR_SENTINEL");
});

it("times out runners that never heartbeat and records infrastructure usage", async () => {
	provider.scenario = "NO_HEARTBEAT";
	await enable();
	const f = await foundation();
	const run = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "no-heartbeat",
	});
	const lease = await hosted.request(f.principal, {
		organizationId: f.organizationId,
		runId: run.runId,
		jobId: run.jobId,
		resourceClassId: "SMALL",
		maxWallTimeMs: 60000,
		networkPolicy: "NETWORK_DISABLED",
		computeBudgetMicros: 12000,
	});
	await hosted.provisionNext();
	clock = new Date(clock.getTime() + 121000);
	expect((await hosted.reconcile()).lost).toBeGreaterThanOrEqual(1);
	expect(
		(
			await database.query<StateRow>(
				"SELECT state,failure_code FROM hosted_execution_leases WHERE id=$1",
				[lease.leaseId],
			)
		).rows[0],
	).toMatchObject({ state: "FAILED", failure_code: "RUNNER_READY_TIMEOUT" });
	provider.scenario = "SUCCESS";
});

it("keeps failed termination visible for reconciliation and honors the global kill switch", async () => {
	await enable();
	const f = await foundation();
	const run = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "termination",
	});
	const lease = await hosted.request(f.principal, {
		organizationId: f.organizationId,
		runId: run.runId,
		jobId: run.jobId,
		resourceClassId: "SMALL",
		maxWallTimeMs: 60000,
		networkPolicy: "NETWORK_DISABLED",
		computeBudgetMicros: 12000,
	});
	await hosted.provisionNext();
	provider.scenario = "TERMINATION_FAILURE";
	await hosted.cancel(f.principal, f.organizationId, lease.leaseId);
	expect(
		(
			await database.query<StateRow>(
				"SELECT state,failure_code FROM hosted_execution_leases WHERE id=$1",
				[lease.leaseId],
			)
		).rows[0],
	).toMatchObject({ state: "ORPHANED", failure_code: "TERMINATION_FAILED" });
	provider.scenario = "SUCCESS";
	await database.query(
		"UPDATE hosted_compute_settings SET emergency_stop=true",
	);
	const another = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "stopped",
	});
	await expect(
		hosted.request(f.principal, {
			organizationId: f.organizationId,
			runId: another.runId,
			jobId: another.jobId,
			resourceClassId: "SMALL",
			maxWallTimeMs: 60000,
			networkPolicy: "NETWORK_DISABLED",
			computeBudgetMicros: 12000,
		}),
	).rejects.toThrow("disabled");
	await database.query(
		"UPDATE hosted_compute_settings SET emergency_stop=false",
	);
});

it("force terminates an execution at the server absolute wall time", async () => {
	await enable();
	const f = await foundation();
	const run = await cloud.createRun(f.principal, {
		organizationId: f.organizationId,
		repositoryId: f.repositoryId,
		benchmarkVersionId: f.benchmark.versionId,
		idempotencyKey: "absolute-timeout",
	});
	const lease = await hosted.request(f.principal, {
		organizationId: f.organizationId,
		runId: run.runId,
		jobId: run.jobId,
		resourceClassId: "SMALL",
		maxWallTimeMs: 60000,
		networkPolicy: "NETWORK_DISABLED",
		computeBudgetMicros: 12000,
	});
	const boot = await hosted.provisionNext();
	const authenticated = await cloud.authenticateRunner(boot?.runnerToken ?? "");
	if (authenticated.type !== "RUNNER") throw new Error("expected runner");
	await hosted.runnerHeartbeat(authenticated.runnerId);
	await cloud.claimJob(authenticated);
	await hosted.runnerClaimed(authenticated.runnerId, run.jobId);
	clock = new Date(clock.getTime() + 60001);
	await hosted.reconcile();
	expect(
		(
			await database.query<StateRow>(
				"SELECT state,failure_code FROM hosted_execution_leases WHERE id=$1",
				[lease.leaseId],
			)
		).rows[0],
	).toMatchObject({ state: "FAILED", failure_code: "EXECUTION_TIMEOUT" });
	expect(provider.terminationCalls).toContain(`resource-${lease.leaseId}`);
});
