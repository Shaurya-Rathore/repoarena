import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmark } from "@repoarena/benchmark-engine";
import { type OAuthProvider, createCloudApi } from "@repoarena/cloud-api";
import { CloudService, type Principal } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { GitHubIntegration } from "@repoarena/github-integration";
import { FileObjectStorage } from "@repoarena/object-storage";
import { PublishingService } from "@repoarena/public-publishing";
import { toHtml, toJson, toJunit, toTerminal } from "@repoarena/reporter";
import { runArgv } from "@repoarena/runner-core";
import { taskSchema } from "@repoarena/task-spec";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudProduct } from "./index.js";

const configured = new URL(process.env.DATABASE_URL ?? "");
configured.pathname = "/repoarena_test";
const testUrl = configured.toString();
const database = createDatabase({ connectionString: testUrl, max: 16 });
const storageRoot = await mkdtemp(
	join(tmpdir(), "repoarena-integrated-store-"),
);
const repositoryRoot = await mkdtemp(
	join(tmpdir(), "repoarena-integrated-repo-"),
);

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

afterAll(async () => {
	await database.close();
	await Promise.all([
		rm(storageRoot, { recursive: true, force: true }),
		rm(repositoryRoot, { recursive: true, force: true }),
	]);
});

it("carries one canonical execution through GitHub, cloud, publication, leaderboard, share, and badge", async () => {
	execFileSync("git", ["init"], { cwd: repositoryRoot });
	execFileSync("git", ["config", "user.email", "integration@example.invalid"], {
		cwd: repositoryRoot,
	});
	execFileSync("git", ["config", "user.name", "Integration"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "subject.txt"), "bug\n");
	execFileSync("git", ["add", "."], { cwd: repositoryRoot });
	execFileSync("git", ["commit", "-m", "base"], { cwd: repositoryRoot });
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
	const evaluatorSentinel = "PRIVATE_EVALUATOR_INTEGRATION_SENTINEL_7b0d63";
	const providerSentinel = "PROVIDER_SECRET_INTEGRATION_SENTINEL_891a2e";
	const webhookSecret = "WEBHOOK_SECRET_INTEGRATION_SENTINEL_540fe4";
	const task = taskSchema.parse({
		schema: "repoarena.task/v1",
		id: "integrated-product",
		title: "Repair integrated behavior",
		prompt: "Make subject.txt contain fixed.",
		source: { type: "imported", base_commit: head },
		verification: {
			required: [
				{
					id: "public",
					command: [
						process.execPath,
						"-e",
						"if(require('fs').readFileSync('subject.txt','utf8')!=='fixed\\n')process.exit(1)",
					],
				},
			],
		},
		provenance: {
			created_at: "2026-09-02T00:00:00.000Z",
			updated_at: "2026-09-02T00:00:00.000Z",
			created_by: "integrated-product-test",
		},
	});
	const localRun = await runBenchmark({
		root: repositoryRoot,
		repository: {
			commit: head,
			remote: "https://github.com/acme/integrated.git",
		},
		tasks: [
			{
				task,
				private_data: {
					task_id: task.id,
					reference_commit: null,
					reference_patch: evaluatorSentinel,
					hidden_hook_source: null,
					private_notes: [],
				},
				private_verifier: async () => [
					[process.execPath, "-e", "process.exit(0)"],
				],
			},
		],
		agents: [
			{
				id: "integrated-agent",
				version: "1",
				model: "deterministic",
				provider: "fake",
				config_hash: "a".repeat(64),
				usage: { input_tokens: 100, output_tokens: 20 },
				secrets: [providerSentinel],
				execute: async (workspace) => {
					await writeFile(join(workspace, "subject.txt"), "fixed\n");
					return runArgv(
						[process.execPath, "-e", "process.exit(0)"],
						workspace,
						2,
					);
				},
			},
		],
		runs_per_task: 2,
		parallelism: 2,
		pricing: {
			version: "integration-v1",
			prices: [
				{
					id: "fake-integration-v1",
					provider: "fake",
					model: "deterministic",
					effective_from: "2026-01-01",
					input_per_million: 1,
					output_per_million: 2,
					currency: "USD",
				},
			],
		},
		state_path: join(repositoryRoot, ".repoarena", "integration-run.json"),
		runner_version: "integration-test",
	});
	expect(localRun.statistics).toMatchObject({
		attempt_count: 2,
		solved_count: 2,
		success_rate: 1,
	});

	const cloud = new CloudService(database);
	const ownerId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Integration Owner",
	});
	const owner: Principal = { type: "USER", userId: ownerId };
	const organizationId = await cloud.createOrganization(
		ownerId,
		`integrated-${randomUUID().slice(0, 8)}`,
		"Integrated Org",
	);
	await cloud.setPlan(owner, organizationId, "TEAM");
	const checks: unknown[] = [];
	const githubRepository = {
		id: 707070,
		name: "integrated",
		full_name: "acme/integrated",
		private: false,
		visibility: "public",
		default_branch: "main",
		archived: false,
		clone_url: "https://github.com/acme/integrated.git",
		html_url: "https://github.com/acme/integrated",
		owner: { login: "acme" },
	};
	const github = new GitHubIntegration(
		database,
		cloud,
		{
			listInstallationRepositories: async () => [githubRepository],
			createCheckRun: async () => ({ id: 404 }),
			updateCheckRun: async (_id, _owner, _repo, _check, input) => {
				checks.push(input);
			},
			upsertPullRequestComment: async () => 1,
			invalidateInstallationToken: () => undefined,
		},
		webhookSecret,
	);
	const installation = {
		id: 808080,
		account: { id: 909090, login: "acme", type: "Organization" as const },
		permissions: { checks: "write", contents: "read", metadata: "read" },
		repository_selection: "selected" as const,
	};
	await github.linkInstallation(owner, organizationId, installation);
	const sign = (payload: unknown, event: string) => {
		const raw = Buffer.from(JSON.stringify(payload));
		return {
			raw,
			headers: {
				event,
				delivery: randomUUID(),
				signature: `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
			},
		};
	};
	const installationDelivery = sign(
		{ action: "created", installation },
		"installation",
	);
	const acceptedInstallation = await github.ingest(
		installationDelivery.raw,
		installationDelivery.headers,
	);
	await github.processDelivery(acceptedInstallation.deliveryId);
	const repository = await database.query<{ id: string }>(
		"SELECT id FROM repositories WHERE organization_id=$1 AND external_id=$2",
		[organizationId, String(githubRepository.id)],
	);
	const repositoryId = repository.rows[0]?.id ?? "";
	const cloudTask = await cloud.createTaskVersion(owner, {
		organizationId,
		repositoryId,
		taskKey: task.id,
		title: task.title,
		publicTask: task,
		validationState: "VALIDATED",
		privatePayload: Buffer.from(evaluatorSentinel),
	});
	const benchmark = await cloud.createBenchmark(owner, {
		organizationId,
		repositoryId,
		name: "Integrated benchmark",
		configuration: { runs_per_task: 2, agents: ["integrated-agent"] },
		taskVersionIds: [cloudTask.versionId],
	});
	await github.setTriggerPolicy(owner, {
		organizationId,
		repositoryId,
		benchmarkVersionId: benchmark.versionId,
		policy: {
			pushDefaultBranch: true,
			pullRequests: true,
			includeDrafts: false,
			forkPolicy: "SKIP",
			budget: {
				max_attempts: 2,
				max_cost_micros: 10_000,
				max_runtime_ms: 60_000,
			},
		},
	});
	const push = sign(
		{
			installation: { id: installation.id },
			repository: githubRepository,
			ref: "refs/heads/main",
			before: "a".repeat(40),
			after: head,
		},
		"push",
	);
	const accepted = await github.ingest(push.raw, push.headers);
	const triggered = await github.processDelivery(accepted.deliveryId);
	const runId = triggered.runId ?? "";
	await github.markRunStarted(runId);
	const registration = await cloud.registerRunner(
		owner,
		organizationId,
		"integrated-runner",
		{},
		"1",
	);
	const runner = await cloud.authenticateRunner(registration.token);
	if (!runner || runner.type !== "RUNNER")
		throw new Error("Runner authentication failed.");
	const claim = await cloud.claimJob(runner);
	expect(claim?.benchmark_run_id).toBe(runId);
	const cloudResult = {
		...localRun,
		state: "COMPLETED",
		statistics: { ...localRun.statistics, task_count: 1 },
		agents: [{ id: "integrated-agent", model: "deterministic" }],
	};
	await cloud.submitResult(runner, claim?.id ?? "", cloudResult);
	await github.publishRun(runId);
	expect(checks).toContainEqual(
		expect.objectContaining({
			status: "completed",
			conclusion: "success",
			output: expect.objectContaining({
				summary: expect.stringContaining("Solved: 2"),
			}),
		}),
	);
	const outsiderId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Outsider",
	});
	await expect(
		new PublishingService(database, cloud).publish(
			{ type: "USER", userId: outsiderId },
			{ organizationId, runId },
		),
	).rejects.toThrow();
	const publication = await new PublishingService(database, cloud).publish(
		owner,
		{
			organizationId,
			runId,
		},
	);

	const oauth: OAuthProvider = {
		authorizationUrl: (state) => `https://identity.invalid?state=${state}`,
		exchange: async () => ({
			provider: "mock",
			subject: "unused",
			displayName: "Unused",
		}),
	};
	const api = createCloudApi({
		database,
		storage: new FileObjectStorage(storageRoot),
		oauth,
		publicOrigin: "http://127.0.0.1",
		github,
	});
	const apiAddress = await api.start("127.0.0.1", 0);
	const product = createCloudProduct({
		cloudOrigin: apiAddress.url,
		publicOrigin: "http://127.0.0.1",
	});
	const productAddress = await product.start("127.0.0.1", 0);
	try {
		const share = await (
			await fetch(`${productAddress.url}/share/${publication.public_id}`)
		).text();
		const leaderboard = await (
			await fetch(`${productAddress.url}/leaderboard`)
		).text();
		const badgeResponse = await fetch(
			`${productAddress.url}/badge/repository/${publication.repository_public_id}.svg`,
		);
		const badge = await badgeResponse.text();
		expect(share).toContain("2/2");
		expect(leaderboard).toContain("integrated-agent/deterministic");
		expect(badgeResponse.headers.get("content-type")).toContain(
			"image/svg+xml",
		);
		expect(badge).toContain("100% solved");
		const publicApi = await (
			await fetch(
				`${apiAddress.url}/api/v1/public/runs/${publication.public_id}`,
			)
		).text();
		const persisted = JSON.stringify(
			(
				await database.query(
					"SELECT canonical_result FROM benchmark_runs WHERE id=$1",
					[runId],
				)
			).rows,
		);
		const surfaces = [
			toTerminal(localRun),
			toJson(localRun),
			toHtml(localRun),
			toJunit(localRun),
			JSON.stringify(checks),
			persisted,
			share,
			leaderboard,
			badge,
			publicApi,
		].join("\n");
		for (const forbidden of [
			evaluatorSentinel,
			providerSentinel,
			webhookSecret,
		])
			expect(surfaces).not.toContain(forbidden);
	} finally {
		await product.close();
		await api.close();
	}
});
