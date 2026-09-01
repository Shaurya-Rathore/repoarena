import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudApi, type OAuthProvider } from "@repoarena/cloud-api";
import { CloudService } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { GitHubIntegration } from "@repoarena/github-integration";
import { FileObjectStorage } from "@repoarena/object-storage";
import { PublishingService } from "@repoarena/public-publishing";
import { createCloudProduct } from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 12 });
const root = await mkdtemp(join(tmpdir(), "repoarena-cloud-product-"));

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});
afterAll(async () => {
	await database.close();
	await rm(root, { recursive: true, force: true });
});

it("serves an authenticated canonical run and its explicit safe publication", async () => {
	const oauth: OAuthProvider = {
		authorizationUrl: (state) => `https://identity.invalid?state=${state}`,
		exchange: async () => ({
			provider: "mock",
			subject: "product-owner",
			displayName: "Product Owner",
		}),
	};
	const cloud = new CloudService(database);
	const github = new GitHubIntegration(
		database,
		cloud,
		{
			listInstallationRepositories: async () => [],
			createCheckRun: async () => ({ id: 1 }),
			updateCheckRun: async () => undefined,
			upsertPullRequestComment: async () => 1,
			invalidateInstallationToken: () => undefined,
		},
		"webhook-secret",
	);
	const api = createCloudApi({
		database,
		storage: new FileObjectStorage(root),
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
		const login = await fetch(`${apiAddress.url}/auth/login`, {
			redirect: "manual",
		});
		const state = new URL(login.headers.get("location") ?? "").searchParams.get(
			"state",
		);
		const callback = await fetch(
			`${apiAddress.url}/auth/callback?state=${state}&code=ok`,
		);
		const cookies = callback.headers.getSetCookie();
		const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
		const userId = ((await callback.json()) as { data: { user_id: string } })
			.data.user_id;
		const orgId = await cloud.createOrganization(userId, "product", "Product");
		const principal = { type: "USER" as const, userId };
		const repositoryId = await cloud.createRepository(principal, {
			organizationId: orgId,
			provider: "MANUAL",
			owner: "acme",
			name: "safe-repo",
			defaultBranch: "main",
			visibility: "PUBLIC",
		});
		const task = await cloud.createTaskVersion(principal, {
			organizationId: orgId,
			repositoryId,
			taskKey: "bug",
			title: "Bug",
			publicTask: { prompt: "fix" },
			validationState: "VALIDATED",
		});
		const benchmark = await cloud.createBenchmark(principal, {
			organizationId: orgId,
			repositoryId,
			name: "Main",
			configuration: { agents: [{ id: "fake", model: "perfect" }] },
			taskVersionIds: [task.versionId],
		});
		const run = await cloud.createRun(principal, {
			organizationId: orgId,
			repositoryId,
			benchmarkVersionId: benchmark.versionId,
			idempotencyKey: "product-e2e",
			budget: { max_attempts: 1 },
		});
		const sentinel = "PRIVATE_EVALUATOR_SENTINEL_MUST_NOT_LEAK";
		await database.query(
			"UPDATE benchmark_runs SET state='COMPLETED',completed_at=now(),canonical_result=$2 WHERE id=$1",
			[
				run.runId,
				{
					schema: "repoarena.benchmark-run/v1",
					state: "COMPLETED",
					statistics: {
						task_count: 1,
						attempt_count: 1,
						solved_count: 1,
						success_rate: 1,
						pass_at_k: 1,
						median_duration_ms: 42,
						total_cost_micros: 1200,
					},
					agents: [{ id: "fake", model: "perfect" }],
				},
			],
		);
		const publication = await new PublishingService(database, cloud).publish(
			principal,
			{ organizationId: orgId, runId: run.runId },
		);
		const app = await fetch(`${productAddress.url}/app`, {
			headers: { cookie },
		});
		expect(app.status).toBe(200);
		expect(app.headers.get("cache-control")).toBe("private, no-store");
		const share = await fetch(
			`${productAddress.url}/share/${publication.public_id}`,
		);
		const html = await share.text();
		expect(html).toContain("safe-repo");
		expect(html).toContain("100.0%");
		expect(html).not.toContain(sentinel);
		const leaderboard = await (
			await fetch(`${productAddress.url}/leaderboard`)
		).text();
		expect(leaderboard).toContain("fake/perfect");
		expect(leaderboard).not.toContain(sentinel);
	} finally {
		await product.close();
		await api.close();
	}
});
