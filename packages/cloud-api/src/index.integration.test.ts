import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { CloudService } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { FileObjectStorage } from "@repoarena/object-storage";
import { createCloudApi, type OAuthProvider } from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 12 });
beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

it("runs the authenticated API-to-job-to-run flow with CSRF, tenant and replay protection", async () => {
	const root = await mkdtemp(join(tmpdir(), "repoarena-cloud-api-"));
	const provider: OAuthProvider = {
		authorizationUrl: (state) =>
			`https://identity.example/login?state=${state}`,
		exchange: async () => ({
			provider: "mock",
			subject: "api-owner",
			displayName: "Owner",
		}),
	};
	const api = createCloudApi({
		database,
		storage: new FileObjectStorage(root),
		oauth: provider,
		publicOrigin: "http://127.0.0.1",
	});
	const address = await api.start("127.0.0.1", 0);
	const origin = address.url;
	try {
		const live = await fetch(`${origin}/health/live`);
		expect(live.status).toBe(200);
		const ready = await fetch(`${origin}/health/ready`);
		expect(ready.status).toBe(200);
		const login = await fetch(`${origin}/auth/login`, { redirect: "manual" });
		const state = new URL(login.headers.get("location") ?? "").searchParams.get(
			"state",
		);
		const callback = await fetch(
			`${origin}/auth/callback?state=${state}&code=valid`,
		);
		expect(callback.status).toBe(200);
		const cookies = callback.headers.getSetCookie();
		const session = cookies
			.find((item) => item.startsWith("repoarena_session="))
			?.split(";")[0];
		const csrf = cookies
			.find((item) => item.startsWith("repoarena_csrf="))
			?.split(";")[0]
			?.split("=")[1];
		const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
		expect(session).toBeDefined();
		expect(csrf).toBeDefined();
		const unauthenticated = await fetch(`${origin}/api/v1/organizations`);
		expect(unauthenticated.status).toBe(401);
		expect(
			((await unauthenticated.json()) as { error: { request_id: string } })
				.error.request_id,
		).toBeTruthy();
		const noCsrf = await fetch(`${origin}/api/v1/organizations`, {
			method: "POST",
			headers: {
				cookie,
				origin: "http://127.0.0.1",
				"content-type": "application/json",
			},
			body: JSON.stringify({ slug: "api-org", display_name: "API Org" }),
		});
		expect(noCsrf.status).toBe(403);
		const headers = {
			cookie,
			origin: "http://127.0.0.1",
			"x-csrf-token": csrf ?? "",
			"content-type": "application/json",
		};
		const created = await fetch(`${origin}/api/v1/organizations`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "api-org", display_name: "API Org" }),
		});
		expect(created.status).toBe(201);
		const organizationId = ((await created.json()) as { data: { id: string } })
			.data.id;
		const service = new CloudService(database);
		const organizations = await service.listOrganizations(
			await service.createUser({
				provider: "mock",
				subject: "other",
				displayName: "Other",
			}),
		);
		expect(organizations).toEqual([]);
		const malformed = await fetch(`${origin}/api/v1/organizations`, {
			method: "POST",
			headers,
			body: "{",
		});
		expect(malformed.status).toBe(400);
		expect(JSON.stringify(await malformed.json())).not.toContain("SyntaxError");
		const list = await fetch(`${origin}/api/v1/organizations`, {
			headers: { cookie },
		});
		expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
		const oversized = await fetch(`${origin}/api/v1/organizations`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: "oversized",
				display_name: "x".repeat(1_000_001),
			}),
		});
		expect(oversized.status).toBe(400);
		const repositoryResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/repositories`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					provider: "manual",
					owner: "repoarena",
					name: "fixture",
					default_branch: "main",
					visibility: "PUBLIC",
				}),
			},
		);
		expect(repositoryResponse.status).toBe(201);
		const repositoryId = (
			(await repositoryResponse.json()) as { data: { id: string } }
		).data.id;
		const taskResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/tasks`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					repository_id: repositoryId,
					task_key: "bug-1",
					title: "Fix behavior",
					public_task: { schema: "repoarena.task/v1", prompt: "safe" },
					validation_state: "VALID",
				}),
			},
		);
		expect(taskResponse.status).toBe(201);
		const taskVersionId = (
			(await taskResponse.json()) as { data: { versionId: string } }
		).data.versionId;
		const benchmarkResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/benchmarks`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					repository_id: repositoryId,
					name: "API benchmark",
					configuration: { runs_per_task: 1 },
					task_version_ids: [taskVersionId],
				}),
			},
		);
		expect(benchmarkResponse.status).toBe(201);
		const benchmarkVersionId = (
			(await benchmarkResponse.json()) as { data: { versionId: string } }
		).data.versionId;
		const runResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/runs`,
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "api-e2e-run" },
				body: JSON.stringify({
					repository_id: repositoryId,
					benchmark_version_id: benchmarkVersionId,
					budget: { max_attempts: 1 },
				}),
			},
		);
		expect(runResponse.status).toBe(201);
		const run = (await runResponse.json()) as {
			data: { runId: string; jobId: string };
		};
		const replayResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/runs`,
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "api-e2e-run" },
				body: JSON.stringify({
					repository_id: repositoryId,
					benchmark_version_id: benchmarkVersionId,
					budget: { max_attempts: 1 },
				}),
			},
		);
		expect(
			((await replayResponse.json()) as { data: { replay: boolean } }).data
				.replay,
		).toBe(true);
		const runnerResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/runners`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					name: "api-runner",
					capabilities: { sandbox: "local" },
					software_version: "test",
				}),
			},
		);
		const runner = (await runnerResponse.json()) as {
			data: { id: string; token: string };
		};
		const claimResponse = await fetch(`${origin}/api/v1/runner/jobs/claim`, {
			method: "POST",
			headers: { authorization: `Bearer ${runner.data.token}` },
		});
		expect(claimResponse.status).toBe(200);
		const claim = (await claimResponse.json()) as {
			data: { id: string; credential: string };
		};
		expect(claim.data.id).toBe(run.data.jobId);
		const safeResult = { schema_version: 1, status: "COMPLETED", solved: 1 };
		const resultResponse = await fetch(
			`${origin}/api/v1/runner/jobs/${claim.data.id}/result`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${claim.data.credential}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ result: safeResult }),
			},
		);
		expect(resultResponse.status).toBe(200);
		const completedResponse = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/runs/${run.data.runId}`,
			{ headers: { cookie } },
		);
		const completed = (await completedResponse.json()) as {
			data: { state: string; canonical_result: unknown };
		};
		expect(completed.data).toMatchObject({
			state: "COMPLETED",
			canonical_result: safeResult,
		});
		const invalidCursor = await fetch(
			`${origin}/api/v1/organizations/${organizationId}/runs?cursor=invalid`,
			{ headers: { cookie } },
		);
		expect(invalidCursor.status).toBe(400);
		const audit = await database.query(
			"SELECT action,metadata FROM audit_events WHERE organization_id=$1 ORDER BY created_at",
			[organizationId],
		);
		expect(audit.rows.map((row) => row.action)).toContain(
			"organization.created",
		);
		expect(JSON.stringify(audit.rows)).not.toContain(session);
	} finally {
		await api.close();
		await rm(root, { recursive: true, force: true });
	}
});
