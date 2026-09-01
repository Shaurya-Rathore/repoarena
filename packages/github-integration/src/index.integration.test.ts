import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { CloudService, type Principal } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { GitHubError, type GitHubRepository } from "@repoarena/github-provider";
import {
	GitHubActionsAuth,
	GitHubIntegration,
	type OidcClaims,
	type TriggerPolicy,
} from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 20 });
const cloud = new CloudService(database);
const webhookSecret = "github-webhook-secret-sentinel";
const installationTokenSentinel = "installation-token-must-never-persist";

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

const signed = (payload: unknown, event: string, delivery = randomUUID()) => {
	const raw = Buffer.from(JSON.stringify(payload));
	return {
		raw,
		headers: {
			event,
			delivery,
			signature: `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
		},
	};
};

it("connects installation, push, PR, checks, runner result and uninstall without tenant or secret leakage", async () => {
	const ownerId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Owner",
	});
	const owner: Principal = { type: "USER", userId: ownerId };
	const organizationId = await cloud.createOrganization(
		ownerId,
		`github-${randomUUID().slice(0, 8)}`,
		"GitHub Org",
	);
	await cloud.setPlan(owner, organizationId, "TEAM");
	const repositories: GitHubRepository[] = [
		{
			id: 900719,
			name: "renamable",
			full_name: "octo/renamable",
			private: true,
			visibility: "private",
			default_branch: "main",
			archived: false,
			clone_url: "https://github.com/octo/renamable.git",
			html_url: "https://github.com/octo/renamable",
			owner: { login: "octo" },
		},
	];
	const createdChecks: Array<{ id: string; input: unknown }> = [];
	const updatedChecks: unknown[] = [];
	const comments: string[] = [];
	const invalidated: string[] = [];
	let listFailure: Error | null = null;
	const provider = {
		listInstallationRepositories: async () => {
			if (listFailure) throw listFailure;
			return repositories;
		},
		createCheckRun: async (
			id: string,
			_owner: string,
			_repo: string,
			input: unknown,
		) => {
			createdChecks.push({ id, input });
			return { id: 55 + createdChecks.length };
		},
		updateCheckRun: async (
			_id: string,
			_owner: string,
			_repo: string,
			_check: number,
			input: unknown,
		) => {
			updatedChecks.push(input);
		},
		upsertPullRequestComment: async (
			_id: string,
			_owner: string,
			_repo: string,
			_pull: number,
			_marker: string,
			body: string,
		) => {
			comments.splice(0, comments.length, body);
			return 77;
		},
		invalidateInstallationToken: (id: string) => invalidated.push(id),
	};
	const github = new GitHubIntegration(
		database,
		cloud,
		provider,
		webhookSecret,
	);
	const installation = {
		id: 123456,
		account: { id: 789, login: "octo", type: "Organization" as const },
		permissions: { checks: "write", contents: "read", metadata: "read" },
		repository_selection: "selected" as const,
	};
	const installationId = await github.linkInstallation(
		owner,
		organizationId,
		installation,
	);
	const outsiderId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Outsider",
	});
	const outsiderOrg = await cloud.createOrganization(
		outsiderId,
		`outside-${randomUUID().slice(0, 8)}`,
		"Outside",
	);
	await expect(
		github.linkInstallation(
			{ type: "USER", userId: outsiderId },
			outsiderOrg,
			installation,
		),
	).rejects.toThrow("already linked");
	const installed = signed({ action: "created", installation }, "installation");
	const acceptedInstallation = await github.ingest(
		installed.raw,
		installed.headers,
	);
	await github.processDelivery(acceptedInstallation.deliveryId);
	const repository = await database.query<{
		id: string;
		state: string;
		full_name: string;
	}>(
		"SELECT id,state,full_name FROM repositories WHERE github_installation_id=$1",
		[installationId],
	);
	expect(repository.rows[0]).toMatchObject({
		state: "ACTIVE",
		full_name: "octo/renamable",
	});
	const repositoryId = repository.rows[0]?.id ?? "";
	const task = await cloud.createTaskVersion(owner, {
		organizationId,
		repositoryId,
		taskKey: "task",
		title: "Task",
		publicTask: { schema: "repoarena.task/v1" },
		validationState: "READY",
		privatePayload: Buffer.from("evaluator-private-sentinel"),
	});
	const benchmark = await cloud.createBenchmark(owner, {
		organizationId,
		repositoryId,
		name: "GitHub benchmark",
		configuration: { runs_per_task: 1 },
		taskVersionIds: [task.versionId],
	});
	const policy: TriggerPolicy = {
		pushDefaultBranch: true,
		pullRequests: true,
		includeDrafts: false,
		forkPolicy: "SKIP",
		budget: {
			max_attempts: 2,
			max_cost_micros: 50_000,
			max_runtime_ms: 300_000,
		},
	};
	await github.setTriggerPolicy(owner, {
		organizationId,
		repositoryId,
		benchmarkVersionId: benchmark.versionId,
		policy,
	});
	const push = signed(
		{
			installation: { id: installation.id },
			repository: repositories[0],
			ref: "refs/heads/main",
			before: "a".repeat(40),
			after: "b".repeat(40),
		},
		"push",
	);
	const acceptedPush = await github.ingest(push.raw, push.headers);
	expect(await github.ingest(push.raw, push.headers)).toEqual({
		...acceptedPush,
		duplicate: true,
	});
	const processedPush = await github.processDelivery(acceptedPush.deliveryId);
	expect(processedPush.state).toBe("PROCESSED");
	expect(createdChecks).toHaveLength(1);
	const runId = processedPush.runId ?? "";
	await github.markRunStarted(runId);
	expect(updatedChecks).toContainEqual(
		expect.objectContaining({ status: "in_progress" }),
	);
	const registration = await cloud.registerRunner(
		owner,
		organizationId,
		"github-runner",
		{},
		"1",
	);
	const runner = (await cloud.authenticateRunner(
		registration.token,
	)) as Extract<Principal, { type: "RUNNER" }>;
	const claim = await cloud.claimJob(runner);
	expect(claim?.benchmark_run_id).toBe(runId);
	await cloud.submitResult(runner, claim?.id ?? "", {
		state: "COMPLETED",
		statistics: { solved: 1, task_count: 1 },
		attempts: [],
	});
	await github.publishRun(runId);
	expect(updatedChecks).toContainEqual(
		expect.objectContaining({ status: "completed", conclusion: "success" }),
	);
	const pull = signed(
		{
			action: "synchronize",
			installation: { id: installation.id },
			repository: repositories[0],
			pull_request: {
				number: 8,
				draft: false,
				head: { sha: "c".repeat(40), repo: { id: repositories[0]?.id } },
				base: { sha: "b".repeat(40), repo: { id: repositories[0]?.id } },
			},
		},
		"pull_request",
	);
	const acceptedPull = await github.ingest(pull.raw, pull.headers);
	const processedPull = await github.processDelivery(acceptedPull.deliveryId);
	expect(processedPull.runId).not.toBe(runId);
	const pullClaim = await cloud.claimJob(runner);
	await cloud.submitResult(runner, pullClaim?.id ?? "", {
		state: "COMPLETED",
		statistics: { solved: 0, task_count: 1 },
	});
	await github.publishRun(processedPull.runId ?? "");
	expect(comments).toHaveLength(1);
	const fork = signed(
		{
			action: "opened",
			installation: { id: installation.id },
			repository: repositories[0],
			pull_request: {
				number: 9,
				draft: false,
				head: { sha: "d".repeat(40), repo: { id: 999999 } },
				base: { sha: "b".repeat(40), repo: { id: repositories[0]?.id } },
			},
		},
		"pull_request",
	);
	const forkAccepted = await github.ingest(fork.raw, fork.headers);
	expect(await github.processDelivery(forkAccepted.deliveryId)).toEqual({
		state: "IGNORED",
	});
	await expect(
		github.ingest(Buffer.from(`${push.raw}x`), push.headers),
	).rejects.toThrow("signature");
	listFailure = new GitHubError(
		"SECONDARY_RATE_LIMITED",
		"GitHub asked the processor to slow down.",
		true,
		1_000,
	);
	const transient = signed(
		{
			action: "added",
			installation: { id: installation.id },
			repositories_added: [],
		},
		"installation_repositories",
	);
	const transientAccepted = await github.ingest(
		transient.raw,
		transient.headers,
	);
	await expect(
		github.processDelivery(transientAccepted.deliveryId),
	).rejects.toThrow("slow down");
	const retryJob = await database.query<{
		state: string;
		attempt_count: number;
	}>(
		"SELECT state,attempt_count FROM jobs WHERE type='GITHUB_WEBHOOK' AND payload->>'delivery_id'=$1",
		[transientAccepted.deliveryId],
	);
	expect(retryJob.rows[0]).toMatchObject({ state: "QUEUED", attempt_count: 1 });
	listFailure = null;
	await database.query(
		"UPDATE jobs SET available_at='2000-01-01T00:00:00Z' WHERE payload->>'delivery_id'=$1",
		[transientAccepted.deliveryId],
	);
	expect(await github.processQueued()).toMatchObject({ processed: 1 });
	repositories.splice(0);
	const removed = signed(
		{
			action: "removed",
			installation: { id: installation.id },
			repositories_removed: [{ id: 900719 }],
		},
		"installation_repositories",
	);
	const removedAccepted = await github.ingest(removed.raw, removed.headers);
	await github.processDelivery(removedAccepted.deliveryId);
	expect(
		(
			await database.query<{ state: string }>(
				"SELECT state FROM repositories WHERE id=$1",
				[repositoryId],
			)
		).rows[0]?.state,
	).toBe("ARCHIVED");
	const uninstall = signed({ action: "deleted", installation }, "installation");
	const uninstallAccepted = await github.ingest(
		uninstall.raw,
		uninstall.headers,
	);
	await github.processDelivery(uninstallAccepted.deliveryId);
	expect(invalidated).toContain(String(installation.id));
	expect(
		(await database.query("SELECT 1 FROM benchmark_runs WHERE id=$1", [runId]))
			.rowCount,
	).toBe(1);
	const publicSurfaces = JSON.stringify({
		createdChecks,
		updatedChecks,
		comments,
		audit: (
			await database.query(
				"SELECT action,metadata FROM audit_events WHERE organization_id=$1",
				[organizationId],
			)
		).rows,
		deliveries: (
			await database.query(
				"SELECT event_type,state,failure_code FROM github_webhook_deliveries WHERE organization_id=$1",
				[organizationId],
			)
		).rows,
	});
	for (const forbidden of [
		webhookSecret,
		installationTokenSentinel,
		"evaluator-private-sentinel",
	])
		expect(publicSurfaces).not.toContain(forbidden);
});

it("exchanges repository-bound OIDC once for a short-lived action credential", async () => {
	const ownerId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Action Owner",
	});
	const owner: Principal = { type: "USER", userId: ownerId };
	const organizationId = await cloud.createOrganization(
		ownerId,
		`action-${randomUUID().slice(0, 8)}`,
		"Action Org",
	);
	await cloud.setPlan(owner, organizationId, "TEAM");
	const repositoryId = await cloud.createRepository(owner, {
		organizationId,
		provider: "github",
		externalId: "424242",
		owner: "octo",
		name: "action",
		defaultBranch: "main",
		visibility: "PRIVATE",
	});
	const task = await cloud.createTaskVersion(owner, {
		organizationId,
		repositoryId,
		taskKey: "action-task",
		title: "Action task",
		publicTask: { schema: "repoarena.task/v1" },
		validationState: "READY",
	});
	const benchmark = await cloud.createBenchmark(owner, {
		organizationId,
		repositoryId,
		name: "Action benchmark",
		configuration: {},
		taskVersionIds: [task.versionId],
	});
	const run = await cloud.createRun(owner, {
		organizationId,
		repositoryId,
		benchmarkVersionId: benchmark.versionId,
		idempotencyKey: randomUUID(),
	});
	const now = new Date("2026-09-01T12:00:00Z");
	const verifier = {
		verify: async (value: string): Promise<OidcClaims> =>
			JSON.parse(
				Buffer.from(value.split(".")[1] ?? "", "base64url").toString(),
			) as OidcClaims,
	};
	const auth = new GitHubActionsAuth(database, cloud, verifier, () => now);
	await auth.createTrust(owner, {
		organizationId,
		repositoryId,
		githubRepositoryId: "424242",
		audience: "repoarena-cloud",
		allowedRefs: ["refs/heads/main"],
		workflowPattern: "octo/action/.github/workflows/repoarena.yml@**",
	});
	const tokenFor = (overrides: Partial<OidcClaims> = {}) => {
		const payload: OidcClaims = {
			iss: "https://token.actions.githubusercontent.com",
			aud: "repoarena-cloud",
			iat: Math.floor(now.getTime() / 1_000) - 10,
			exp: Math.floor(now.getTime() / 1_000) + 300,
			jti: randomUUID(),
			repository_id: "424242",
			repository: "octo/action",
			ref: "refs/heads/main",
			job_workflow_ref:
				"octo/action/.github/workflows/repoarena.yml@refs/heads/main",
			...overrides,
		};
		return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
	};
	const oidc = tokenFor();
	const credential = await auth.exchange(oidc, "repoarena-cloud");
	expect(credential).toMatchObject({ organizationId, repositoryId });
	expect(credential.token).toMatch(/^raa_/);
	await expect(auth.exchange(oidc, "repoarena-cloud")).rejects.toThrow(
		"already used",
	);
	await expect(
		auth.exchange(tokenFor({ ref: "refs/pull/1/merge" }), "repoarena-cloud"),
	).rejects.toThrow("ref is not trusted");
	await expect(
		auth.exchange(tokenFor({ repository_id: "999" }), "repoarena-cloud"),
	).rejects.toThrow("trust is unavailable");
	await expect(
		auth.exchange(
			tokenFor({ iss: "https://attacker.invalid" }),
			"repoarena-cloud",
		),
	).rejects.toThrow("claims are invalid");
	await expect(
		auth.exchange(
			tokenFor({ exp: Math.floor(now.getTime() / 1_000) - 1 }),
			"repoarena-cloud",
		),
	).rejects.toThrow("expired or stale");
	const publicResult = {
		state: "COMPLETED",
		statistics: { solved: 1, task_count: 1 },
	};
	expect(
		await auth.submitResult(credential.token, run.runId, publicResult),
	).toEqual({ replay: false });
	expect(
		await auth.submitResult(credential.token, run.runId, publicResult),
	).toEqual({ replay: true });
	await expect(
		auth.submitResult(credential.token, run.runId, {
			...publicResult,
			evaluator_private: "hidden",
		}),
	).rejects.toThrow("evaluator-private");
	const persisted = JSON.stringify(
		(
			await database.query(
				"SELECT action,metadata FROM audit_events WHERE organization_id=$1",
				[organizationId],
			)
		).rows,
	);
	expect(persisted).not.toContain(credential.token);
});
