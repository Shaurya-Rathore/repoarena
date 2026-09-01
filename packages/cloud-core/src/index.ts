import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { Database } from "@repoarena/cloud-db";
import { contentHash, RepoArenaError, type ErrorCode } from "@repoarena/core";
import { objectKey, type ObjectStorage } from "@repoarena/object-storage";

export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type Permission =
	| "ORG_READ"
	| "ORG_MANAGE"
	| "MEMBER_MANAGE"
	| "REPOSITORY_READ"
	| "REPOSITORY_MANAGE"
	| "BENCHMARK_RUN"
	| "RUNNER_MANAGE"
	| "API_KEY_MANAGE"
	| "BILLING_MANAGE";
const permissions: Record<Role, ReadonlySet<Permission>> = {
	OWNER: new Set([
		"ORG_READ",
		"ORG_MANAGE",
		"MEMBER_MANAGE",
		"REPOSITORY_READ",
		"REPOSITORY_MANAGE",
		"BENCHMARK_RUN",
		"RUNNER_MANAGE",
		"API_KEY_MANAGE",
		"BILLING_MANAGE",
	]),
	ADMIN: new Set([
		"ORG_READ",
		"ORG_MANAGE",
		"MEMBER_MANAGE",
		"REPOSITORY_READ",
		"REPOSITORY_MANAGE",
		"BENCHMARK_RUN",
		"RUNNER_MANAGE",
		"API_KEY_MANAGE",
	]),
	MEMBER: new Set(["ORG_READ", "REPOSITORY_READ", "BENCHMARK_RUN"]),
	VIEWER: new Set(["ORG_READ", "REPOSITORY_READ"]),
};
export const roleAllows = (role: Role, permission: Permission) =>
	permissions[role].has(permission);

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const token = (kind: string) => {
	const secret = randomBytes(32).toString("base64url");
	const prefix = `${kind}_${randomBytes(6).toString("hex")}`;
	return {
		plaintext: `${prefix}.${secret}`,
		prefix,
		hash: digest(`${prefix}.${secret}`),
	};
};
const equalDigest = (value: string, expected: string) => {
	const actual = Buffer.from(digest(value), "hex");
	const target = Buffer.from(expected, "hex");
	return actual.length === target.length && timingSafeEqual(actual, target);
};
const fail = (code: ErrorCode, message: string): never => {
	throw new RepoArenaError(code, message);
};

const privateResultKeys = new Set([
	"evaluator_private",
	"private_evidence",
	"private_path",
	"hidden_source",
	"hidden_assertion",
	"reference_solution",
]);
export const assertPublicResult = (value: unknown): void => {
	let visited = 0;
	const walk = (current: unknown, depth: number): void => {
		if (++visited > 100_000 || depth > 64)
			fail("CONFIG_INVALID", "Result exceeds structural limits.");
		if (Array.isArray(current)) {
			for (const item of current) walk(item, depth + 1);
			return;
		}
		if (!current || typeof current !== "object") return;
		for (const [key, nested] of Object.entries(current)) {
			if (privateResultKeys.has(key.toLowerCase()))
				fail("CONFIG_INVALID", "Result contains evaluator-private data.");
			walk(nested, depth + 1);
		}
	};
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("CONFIG_INVALID", "Canonical result must be an object.");
	walk(value, 0);
};

export type Principal = Readonly<
	| { type: "USER"; userId: string }
	| {
			type: "API_KEY";
			apiKeyId: string;
			organizationId: string;
			scopes: readonly string[];
	  }
	| { type: "RUNNER"; runnerId: string; organizationId: string }
	| {
			type: "SYSTEM";
			organizationId: string;
			actorId: string;
			integration: "GITHUB";
	  }
>;
const actorId = (principal: Principal) =>
	principal.type === "USER"
		? principal.userId
		: principal.type === "API_KEY"
			? principal.apiKeyId
			: principal.type === "RUNNER"
				? principal.runnerId
				: principal.actorId;
export type Entitlements = Readonly<{
	private_repositories: boolean;
	scheduled_runs: boolean;
	max_schedules: number;
	max_runners: number;
	api_access: boolean;
	max_members: number;
	hosted_compute: boolean;
}>;
export type JobClaim = Readonly<{
	id: string;
	organization_id: string;
	benchmark_run_id: string | null;
	type: string;
	payload: unknown;
	lease_expires_at: string;
	credential: string;
}>;

export class CloudService {
	constructor(
		private readonly database: Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	async createUser(input: {
		provider: string;
		subject: string;
		displayName: string;
		email?: string;
	}): Promise<string> {
		const id = randomUUID();
		const result = await this.database.query<{ id: string }>(
			"INSERT INTO users(id,provider,provider_subject,display_name,email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider,provider_subject) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,updated_at=now() RETURNING id",
			[
				id,
				input.provider,
				input.subject,
				input.displayName,
				input.email ?? null,
			],
		);
		return result.rows[0]?.id ?? fail("ATTEMPT_FAILED", "User mapping failed.");
	}

	async createOrganization(
		userId: string,
		slug: string,
		displayName: string,
	): Promise<string> {
		return this.database.transaction(async (client) => {
			const id = randomUUID();
			await client.query(
				"INSERT INTO organizations(id,slug,display_name,plan_id) VALUES($1,$2,$3,'COMMUNITY')",
				[id, slug.toLowerCase(), displayName],
			);
			await client.query(
				"INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",
				[id, userId],
			);
			await this.audit(
				client,
				id,
				"USER",
				userId,
				"organization.created",
				"organization",
				id,
				{},
			);
			return id;
		});
	}

	async authorize(
		principal: Principal,
		organizationId: string,
		permission: Permission,
	): Promise<void> {
		if (principal.type === "API_KEY") {
			if (
				principal.organizationId !== organizationId ||
				!principal.scopes.includes(permission)
			)
				fail("FORBIDDEN", "Permission denied.");
			return;
		}
		if (principal.type === "SYSTEM") {
			if (
				principal.organizationId !== organizationId ||
				!(["REPOSITORY_MANAGE", "BENCHMARK_RUN"] as Permission[]).includes(
					permission,
				)
			)
				fail("FORBIDDEN", "Permission denied.");
			return;
		}
		if (principal.type !== "USER")
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"User authorization required.",
			);
		const result = await this.database.query<{ role: Role }>(
			"SELECT m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.state='ACTIVE' AND o.state='ACTIVE'",
			[organizationId, principal.userId],
		);
		const role = result.rows[0]?.role;
		if (!role || !roleAllows(role, permission))
			fail("FORBIDDEN", "Permission denied.");
	}

	async listOrganizations(userId: string): Promise<unknown[]> {
		const result = await this.database.query(
			"SELECT o.id,o.slug,o.display_name,o.plan_id,o.state,o.created_at,o.updated_at,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 AND m.state='ACTIVE' AND o.state='ACTIVE' ORDER BY o.created_at DESC,o.id DESC",
			[userId],
		);
		return result.rows;
	}

	async listRepositories(
		actor: Principal,
		organizationId: string,
	): Promise<unknown[]> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		return (
			await this.database.query(
				"SELECT id,provider,external_id,owner_name,repository_name,default_branch,visibility,state,created_at,updated_at FROM repositories WHERE organization_id=$1 AND state='ACTIVE' ORDER BY created_at DESC,id DESC",
				[organizationId],
			)
		).rows;
	}

	async listMemberships(
		actor: Principal,
		organizationId: string,
	): Promise<unknown[]> {
		await this.authorize(actor, organizationId, "ORG_READ");
		return (
			await this.database.query(
				"SELECT m.user_id,m.role,m.state,m.created_at,m.updated_at,u.display_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at,m.user_id",
				[organizationId],
			)
		).rows;
	}

	async setMembership(
		actor: Principal,
		organizationId: string,
		userId: string,
		role: Role,
		state: "ACTIVE" | "REVOKED" = "ACTIVE",
	): Promise<void> {
		await this.authorize(actor, organizationId, "MEMBER_MANAGE");
		const limits = await this.entitlements(organizationId);
		await this.database.transaction(async (client) => {
			const members = await client.query<{
				user_id: string;
				role: Role;
				state: string;
			}>(
				"SELECT user_id,role,state FROM memberships WHERE organization_id=$1 FOR UPDATE",
				[organizationId],
			);
			const current = members.rows.find((item) => item.user_id === userId);
			if (
				current?.role === "OWNER" &&
				current.state === "ACTIVE" &&
				(role !== "OWNER" || state !== "ACTIVE") &&
				members.rows.filter(
					(item) => item.role === "OWNER" && item.state === "ACTIVE",
				).length === 1
			)
				fail("CONFLICT", "Organization must retain an active owner.");
			if (
				(!current || current.state !== "ACTIVE") &&
				state === "ACTIVE" &&
				members.rows.filter((item) => item.state === "ACTIVE").length >=
					limits.max_members
			)
				fail("AUTH_UNAVAILABLE", "Member entitlement limit reached.");
			await client.query(
				"INSERT INTO memberships(organization_id,user_id,role,state) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,state=excluded.state,updated_at=now()",
				[organizationId, userId, role, state],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"membership.changed",
				"user",
				userId,
				{ role, state },
			);
		});
	}

	async getRun(
		actor: Principal,
		organizationId: string,
		runId: string,
	): Promise<unknown> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		const result = await this.database.query(
			"SELECT id,state,repository_id,benchmark_version_id,runner_id,billing_owner,budget,canonical_result,created_at,started_at,completed_at,updated_at FROM benchmark_runs WHERE id=$1 AND organization_id=$2",
			[runId, organizationId],
		);
		return result.rows[0] ?? fail("NOT_FOUND", "Run not found.");
	}

	async entitlements(organizationId: string): Promise<Entitlements> {
		const result = await this.database.query<{
			entitlements: Entitlements;
			overrides: Record<string, unknown>;
		}>(
			"SELECT p.entitlements,coalesce((SELECT jsonb_object_agg(entitlement,value) FROM organization_entitlement_overrides WHERE organization_id=o.id),'{}') AS overrides FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE o.id=$1 AND o.state='ACTIVE'",
			[organizationId],
		);
		const row =
			result.rows[0] ?? fail("CONFIG_INVALID", "Organization is unavailable.");
		return { ...row.entitlements, ...row.overrides } as Entitlements;
	}

	async setPlan(
		actor: Principal,
		organizationId: string,
		plan: "COMMUNITY" | "PRO" | "TEAM" | "ENTERPRISE",
	): Promise<void> {
		await this.authorize(actor, organizationId, "BILLING_MANAGE");
		await this.database.transaction(async (client) => {
			await client.query(
				"UPDATE organizations SET plan_id=$2,updated_at=now() WHERE id=$1",
				[organizationId, plan],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"organization.plan_changed",
				"organization",
				organizationId,
				{ plan },
			);
		});
	}

	async createRepository(
		actor: Principal,
		input: {
			organizationId: string;
			provider: string;
			externalId?: string;
			owner: string;
			name: string;
			defaultBranch: string;
			visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
		},
	): Promise<string> {
		await this.authorize(actor, input.organizationId, "REPOSITORY_MANAGE");
		if (
			input.visibility === "PRIVATE" &&
			!(await this.entitlements(input.organizationId)).private_repositories
		)
			fail(
				"AUTH_UNAVAILABLE",
				"The organization plan does not allow private repositories.",
			);
		const id = randomUUID();
		await this.database.query(
			"INSERT INTO repositories(id,organization_id,provider,external_id,owner_name,repository_name,default_branch,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
			[
				id,
				input.organizationId,
				input.provider,
				input.externalId ?? null,
				input.owner,
				input.name,
				input.defaultBranch,
				input.visibility,
			],
		);
		return id;
	}

	async createTaskVersion(
		actor: Principal,
		input: {
			organizationId: string;
			repositoryId: string;
			taskKey: string;
			title: string;
			publicTask: unknown;
			validationState: string;
			privatePayload?: Buffer;
		},
	): Promise<{ taskId: string; versionId: string }> {
		await this.authorize(actor, input.organizationId, "REPOSITORY_MANAGE");
		const publicHash = contentHash(input.publicTask);
		return this.database.transaction(async (client) => {
			const ownership = await client.query(
				"SELECT 1 FROM repositories WHERE id=$1 AND organization_id=$2 AND state='ACTIVE'",
				[input.repositoryId, input.organizationId],
			);
			if (!ownership.rowCount)
				fail("AUTH_UNAVAILABLE", "Repository is unavailable.");
			const taskId = randomUUID();
			const task = await client.query<{ id: string }>(
				"INSERT INTO tasks(id,organization_id,repository_id,task_key,title) VALUES($1,$2,$3,$4,$5) ON CONFLICT(repository_id,task_key) DO UPDATE SET title=excluded.title RETURNING id",
				[
					taskId,
					input.organizationId,
					input.repositoryId,
					input.taskKey,
					input.title,
				],
			);
			const id = randomUUID();
			const next = await client.query<{ version: number }>(
				"SELECT coalesce(max(version),0)+1 AS version FROM task_versions WHERE task_id=$1",
				[task.rows[0]?.id],
			);
			await client.query(
				"INSERT INTO task_versions(id,task_id,version,content_hash,public_task,validation_state) VALUES($1,$2,$3,$4,$5,$6)",
				[
					id,
					task.rows[0]?.id,
					next.rows[0]?.version,
					publicHash,
					input.publicTask,
					input.validationState,
				],
			);
			if (input.privatePayload)
				await client.query(
					"INSERT INTO task_private_versions(task_version_id,encrypted_payload,content_hash) VALUES($1,$2,$3)",
					[
						id,
						input.privatePayload,
						digest(input.privatePayload.toString("base64")),
					],
				);
			return { taskId: task.rows[0]?.id ?? taskId, versionId: id };
		});
	}

	async getPublicTask(
		actor: Principal,
		organizationId: string,
		taskVersionId: string,
	): Promise<unknown> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		const result = await this.database.query<{ public_task: unknown }>(
			"SELECT tv.public_task FROM task_versions tv JOIN tasks t ON t.id=tv.task_id WHERE tv.id=$1 AND t.organization_id=$2",
			[taskVersionId, organizationId],
		);
		return (
			result.rows[0]?.public_task ??
			fail("CONFIG_INVALID", "Task version not found.")
		);
	}

	async listTasks(
		actor: Principal,
		organizationId: string,
	): Promise<unknown[]> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		return (
			await this.database.query(
				"SELECT t.id,t.repository_id,t.task_key,t.title,t.archived_at,t.created_at,tv.id AS latest_version_id,tv.version,tv.content_hash,tv.validation_state,tv.created_at AS version_created_at FROM tasks t LEFT JOIN LATERAL (SELECT id,version,content_hash,validation_state,created_at FROM task_versions WHERE task_id=t.id ORDER BY version DESC LIMIT 1) tv ON true WHERE t.organization_id=$1 AND t.archived_at IS NULL ORDER BY t.created_at DESC,t.id DESC",
				[organizationId],
			)
		).rows;
	}

	async listBenchmarks(
		actor: Principal,
		organizationId: string,
	): Promise<unknown[]> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		return (
			await this.database.query(
				"SELECT b.id,b.repository_id,b.name,b.state,b.created_at,b.updated_at,bv.id AS latest_version_id,bv.version,bv.config_hash,bv.created_at AS version_created_at FROM benchmarks b LEFT JOIN LATERAL (SELECT id,version,config_hash,created_at FROM benchmark_versions WHERE benchmark_id=b.id ORDER BY version DESC LIMIT 1) bv ON true WHERE b.organization_id=$1 AND b.state='ACTIVE' ORDER BY b.created_at DESC,b.id DESC",
				[organizationId],
			)
		).rows;
	}

	async createBenchmark(
		actor: Principal,
		input: {
			organizationId: string;
			repositoryId: string;
			name: string;
			configuration: unknown;
			taskVersionIds: readonly string[];
		},
	): Promise<{ benchmarkId: string; versionId: string }> {
		await this.authorize(actor, input.organizationId, "REPOSITORY_MANAGE");
		return this.database.transaction(async (client) => {
			const benchmarkId = randomUUID();
			const versionId = randomUUID();
			await client.query(
				"INSERT INTO benchmarks(id,organization_id,repository_id,name) SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM repositories WHERE id=$3 AND organization_id=$2)",
				[benchmarkId, input.organizationId, input.repositoryId, input.name],
			);
			await client.query(
				"INSERT INTO benchmark_versions(id,benchmark_id,version,config_hash,configuration) VALUES($1,$2,1,$3,$4)",
				[
					versionId,
					benchmarkId,
					contentHash(input.configuration),
					input.configuration,
				],
			);
			for (const [ordinal, taskVersionId] of input.taskVersionIds.entries())
				await client.query(
					"INSERT INTO benchmark_version_tasks(benchmark_version_id,task_version_id,ordinal) SELECT $1,tv.id,$3 FROM task_versions tv JOIN tasks t ON t.id=tv.task_id WHERE tv.id=$2 AND t.organization_id=$4",
					[versionId, taskVersionId, ordinal, input.organizationId],
				);
			return { benchmarkId, versionId };
		});
	}

	async createRun(
		actor: Principal,
		input: {
			organizationId: string;
			repositoryId: string;
			benchmarkVersionId: string;
			idempotencyKey: string;
			budget?: unknown;
		},
	): Promise<{ runId: string; jobId: string; replay: boolean }> {
		await this.authorize(actor, input.organizationId, "BENCHMARK_RUN");
		const requestHash = contentHash(input);
		const keyHash = digest(input.idempotencyKey);
		return this.database.transaction(async (client) => {
			const previous = await client.query<{
				response_body: { runId: string; jobId: string };
				request_hash: string;
			}>(
				"SELECT response_body,request_hash FROM idempotency_keys WHERE organization_id=$1 AND scope='create-run' AND key_hash=$2 AND expires_at>now() FOR UPDATE",
				[input.organizationId, keyHash],
			);
			if (previous.rowCount) {
				if (previous.rows[0]?.request_hash !== requestHash)
					fail(
						"CONFIG_INVALID",
						"Idempotency key was reused with a different request.",
					);
				return {
					...(previous.rows[0]?.response_body ??
						fail("ATTEMPT_FAILED", "Stored idempotency response is invalid.")),
					replay: true,
				};
			}
			const valid = await client.query(
				"SELECT 1 FROM benchmark_versions bv JOIN benchmarks b ON b.id=bv.benchmark_id WHERE bv.id=$1 AND b.organization_id=$2 AND b.repository_id=$3",
				[input.benchmarkVersionId, input.organizationId, input.repositoryId],
			);
			if (!valid.rowCount)
				fail("AUTH_UNAVAILABLE", "Benchmark version is unavailable.");
			const runId = randomUUID();
			const jobId = randomUUID();
			await client.query(
				"INSERT INTO benchmark_runs(id,organization_id,repository_id,benchmark_version_id,state,budget) VALUES($1,$2,$3,$4,'QUEUED',$5)",
				[
					runId,
					input.organizationId,
					input.repositoryId,
					input.benchmarkVersionId,
					input.budget ?? {},
				],
			);
			await client.query(
				"INSERT INTO jobs(id,organization_id,benchmark_run_id,type,payload,state,requirements,scheduled_at,available_at) VALUES($1,$2,$3,'BENCHMARK_RUN',$4,'QUEUED',$5,$6,$6)",
				[
					jobId,
					input.organizationId,
					runId,
					{ run_id: runId },
					{},
					this.now().toISOString(),
				],
			);
			const response = { runId, jobId };
			await client.query(
				"INSERT INTO idempotency_keys(organization_id,scope,key_hash,request_hash,response_status,response_body,expires_at) VALUES($1,'create-run',$2,$3,201,$4,now()+interval '24 hours')",
				[input.organizationId, keyHash, requestHash, response],
			);
			await this.audit(
				client,
				input.organizationId,
				actor.type,
				actorId(actor),
				"run.created",
				"benchmark_run",
				runId,
				{},
			);
			return { ...response, replay: false };
		});
	}

	async createSession(
		userId: string,
		lifetimeMs = 86_400_000,
	): Promise<{ token: string; csrf: string; expiresAt: string }> {
		const session = token("ras");
		const csrf = randomBytes(24).toString("base64url");
		const expiresAt = new Date(this.now().getTime() + lifetimeMs).toISOString();
		await this.database.query(
			"INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
			[randomUUID(), userId, session.hash, digest(csrf), expiresAt],
		);
		await this.database.query(
			"INSERT INTO audit_events(id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,'USER',$2,'session.created','session',NULL,'{}')",
			[randomUUID(), userId],
		);
		return { token: session.plaintext, csrf, expiresAt };
	}

	async authenticateSession(value: string, csrf?: string): Promise<Principal> {
		const result = await this.database.query<{
			user_id: string;
			token_hash: string;
			csrf_hash: string;
		}>(
			"SELECT user_id,token_hash,csrf_hash FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",
			[digest(value)],
		);
		const row =
			result.rows[0] ?? fail("AUTH_UNAVAILABLE", "Session is invalid.");
		if (
			!equalDigest(value, row.token_hash) ||
			(csrf !== undefined && !equalDigest(csrf, row.csrf_hash))
		)
			fail("AUTH_UNAVAILABLE", "Session is invalid.");
		return { type: "USER", userId: row.user_id };
	}

	async revokeSession(value: string): Promise<void> {
		await this.database.transaction(async (client) => {
			const result = await client.query<{ user_id: string }>(
				"UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING user_id",
				[digest(value)],
			);
			if (result.rows[0])
				await this.audit(
					client,
					null,
					"USER",
					result.rows[0].user_id,
					"session.revoked",
					"session",
					result.rows[0].user_id,
					{},
				);
		});
	}

	async revokeApiKey(
		actor: Principal,
		organizationId: string,
		apiKeyId: string,
	): Promise<void> {
		await this.authorize(actor, organizationId, "API_KEY_MANAGE");
		await this.database.transaction(async (client) => {
			const result = await client.query(
				"UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL",
				[apiKeyId, organizationId],
			);
			if (!result.rowCount) fail("NOT_FOUND", "API key not found.");
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"api_key.revoked",
				"api_key",
				apiKeyId,
				{},
			);
		});
	}

	async createApiKey(
		actor: Principal,
		organizationId: string,
		userId: string,
		name: string,
		scopes: readonly Permission[],
		expiresAt?: string,
	): Promise<{ id: string; key: string; prefix: string }> {
		await this.authorize(actor, organizationId, "API_KEY_MANAGE");
		if (!(await this.entitlements(organizationId)).api_access)
			fail("FORBIDDEN", "The organization plan does not allow API access.");
		const generated = token("rak");
		const id = randomUUID();
		await this.database.transaction(async (client) => {
			await client.query(
				"INSERT INTO api_keys(id,organization_id,created_by_user_id,name,key_prefix,key_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
				[
					id,
					organizationId,
					userId,
					name,
					generated.prefix,
					generated.hash,
					scopes,
					expiresAt ?? null,
				],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"api_key.created",
				"api_key",
				id,
				{ prefix: generated.prefix, scopes },
			);
		});
		return { id, key: generated.plaintext, prefix: generated.prefix };
	}

	async authenticateApiKey(
		value: string,
		requiredScope?: Permission,
	): Promise<Principal> {
		const prefix = value.split(".")[0] ?? "";
		const result = await this.database.query<{
			id: string;
			organization_id: string;
			key_hash: string;
			scopes: string[];
		}>(
			"SELECT id,organization_id,key_hash,scopes FROM api_keys WHERE key_prefix=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
			[prefix],
		);
		const row =
			result.rows[0] ??
			fail("AUTH_UNAVAILABLE", "API key is invalid or lacks scope.");
		if (
			!equalDigest(value, row.key_hash) ||
			(requiredScope && !row.scopes.includes(requiredScope))
		)
			fail("AUTH_UNAVAILABLE", "API key is invalid or lacks scope.");
		await this.database.query(
			"UPDATE api_keys SET last_used_at=now() WHERE id=$1",
			[row.id],
		);
		return {
			type: "API_KEY",
			apiKeyId: row.id,
			organizationId: row.organization_id,
			scopes: row.scopes,
		};
	}

	async registerRunner(
		actor: Principal,
		organizationId: string,
		name: string,
		capabilities: unknown,
		softwareVersion: string,
	): Promise<{ id: string; token: string }> {
		await this.authorize(actor, organizationId, "RUNNER_MANAGE");
		const generated = token("rar");
		const id = randomUUID();
		const maximum = (await this.entitlements(organizationId)).max_runners;
		return this.database.transaction(async (client) => {
			const count = await client.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM runners WHERE organization_id=$1 AND state='ACTIVE'",
				[organizationId],
			);
			if (Number(count.rows[0]?.count ?? 0) >= maximum)
				fail("AUTH_UNAVAILABLE", "Runner entitlement limit reached.");
			await client.query(
				"INSERT INTO runners(id,organization_id,name,token_prefix,token_hash,capabilities,software_version) VALUES($1,$2,$3,$4,$5,$6,$7)",
				[
					id,
					organizationId,
					name,
					generated.prefix,
					generated.hash,
					capabilities,
					softwareVersion,
				],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"runner.registered",
				"runner",
				id,
				{},
			);
			return { id, token: generated.plaintext };
		});
	}

	async authenticateRunner(value: string): Promise<Principal> {
		const prefix = value.split(".")[0] ?? "";
		const result = await this.database.query<{
			id: string;
			organization_id: string;
			token_hash: string;
		}>(
			"SELECT id,organization_id,token_hash FROM runners WHERE token_prefix=$1 AND state='ACTIVE'",
			[prefix],
		);
		const row =
			result.rows[0] ?? fail("AUTH_UNAVAILABLE", "Runner token is invalid.");
		if (!equalDigest(value, row.token_hash))
			fail("AUTH_UNAVAILABLE", "Runner token is invalid.");
		return {
			type: "RUNNER",
			runnerId: row.id,
			organizationId: row.organization_id,
		};
	}

	async authenticateJobCredential(
		value: string,
		jobId: string,
		requiredScope: "result:write" | "artifact:write",
	): Promise<Extract<Principal, { type: "RUNNER" }>> {
		const result = await this.database.query<{
			runner_id: string;
			organization_id: string;
			token_hash: string;
			scopes: string[];
		}>(
			"SELECT jc.runner_id,j.organization_id,jc.token_hash,jc.scopes FROM job_credentials jc JOIN jobs j ON j.id=jc.job_id JOIN runners r ON r.id=jc.runner_id WHERE jc.job_id=$1 AND jc.token_hash=$2 AND jc.consumed_at IS NULL AND jc.expires_at>now() AND j.state='LEASED' AND j.lease_owner=jc.runner_id AND r.state='ACTIVE'",
			[jobId, digest(value)],
		);
		const row =
			result.rows[0] ??
			fail("AUTH_UNAVAILABLE", "Job credential is invalid or lacks scope.");
		if (
			!equalDigest(value, row.token_hash) ||
			!row.scopes.includes(requiredScope)
		)
			fail("AUTH_UNAVAILABLE", "Job credential is invalid or lacks scope.");
		return {
			type: "RUNNER",
			runnerId: row.runner_id,
			organizationId: row.organization_id,
		};
	}

	async revokeRunner(
		actor: Principal,
		organizationId: string,
		runnerId: string,
	): Promise<void> {
		await this.authorize(actor, organizationId, "RUNNER_MANAGE");
		await this.database.transaction(async (client) => {
			const result = await client.query(
				"UPDATE runners SET state='REVOKED',revoked_at=now(),current_job_id=NULL WHERE id=$1 AND organization_id=$2 AND state='ACTIVE'",
				[runnerId, organizationId],
			);
			if (!result.rowCount) fail("NOT_FOUND", "Runner not found.");
			await client.query(
				"UPDATE jobs SET state='QUEUED',lease_owner=NULL,lease_expires_at=NULL,available_at=now(),updated_at=now() WHERE lease_owner=$1 AND state='LEASED'",
				[runnerId],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"runner.revoked",
				"runner",
				runnerId,
				{},
			);
		});
	}

	async heartbeat(
		runner: Extract<Principal, { type: "RUNNER" }>,
		capabilities?: unknown,
	): Promise<void> {
		const result = await this.database.query(
			"UPDATE runners SET last_heartbeat_at=$2,capabilities=coalesce($3,capabilities) WHERE id=$1 AND organization_id=$4 AND state='ACTIVE'",
			[
				runner.runnerId,
				this.now().toISOString(),
				capabilities ?? null,
				runner.organizationId,
			],
		);
		if (!result.rowCount) fail("AUTH_UNAVAILABLE", "Runner is revoked.");
	}

	async claimJob(
		runner: Extract<Principal, { type: "RUNNER" }>,
		leaseMs = 60_000,
	): Promise<JobClaim | null> {
		return this.database.transaction(async (client) => {
			const selected = await client.query<{
				id: string;
				organization_id: string;
				benchmark_run_id: string | null;
				type: string;
				payload: unknown;
			}>(
				"SELECT j.id,j.organization_id,j.benchmark_run_id,j.type,j.payload FROM jobs j JOIN runners r ON r.id=$1 WHERE j.organization_id=$2 AND r.state='ACTIVE' AND j.state IN ('QUEUED','LEASED') AND j.available_at<=$3 AND (j.state='QUEUED' OR j.lease_expires_at<=$3) AND j.requirements <@ r.capabilities ORDER BY j.priority DESC,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1",
				[runner.runnerId, runner.organizationId, this.now().toISOString()],
			);
			const job = selected.rows[0];
			if (!job) return null;
			const expires = new Date(this.now().getTime() + leaseMs).toISOString();
			await client.query(
				"UPDATE jobs SET state='LEASED',lease_owner=$2,lease_expires_at=$3,attempt_count=attempt_count+1,updated_at=$4 WHERE id=$1",
				[job.id, runner.runnerId, expires, this.now().toISOString()],
			);
			if (job.benchmark_run_id)
				await client.query(
					"UPDATE benchmark_runs SET state='RUNNING',runner_id=$2,started_at=coalesce(started_at,$3),updated_at=$3 WHERE id=$1",
					[job.benchmark_run_id, runner.runnerId, this.now().toISOString()],
				);
			const credential = token("raj");
			await client.query(
				"INSERT INTO job_credentials(id,job_id,runner_id,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
				[
					randomUUID(),
					job.id,
					runner.runnerId,
					credential.hash,
					["result:write", "artifact:write"],
					expires,
				],
			);
			return {
				...job,
				lease_expires_at: expires,
				credential: credential.plaintext,
			};
		});
	}

	async extendLease(
		runner: Extract<Principal, { type: "RUNNER" }>,
		jobId: string,
		leaseMs = 60_000,
	): Promise<void> {
		const result = await this.database.query(
			"UPDATE jobs SET lease_expires_at=$4,updated_at=$3 WHERE id=$1 AND lease_owner=$2 AND state='LEASED' AND lease_expires_at>$3",
			[
				jobId,
				runner.runnerId,
				this.now().toISOString(),
				new Date(this.now().getTime() + leaseMs).toISOString(),
			],
		);
		if (!result.rowCount) fail("AUTH_UNAVAILABLE", "Job lease is unavailable.");
	}

	async submitResult(
		runner: Extract<Principal, { type: "RUNNER" }>,
		jobId: string,
		result: unknown,
	): Promise<{ replay: boolean }> {
		assertPublicResult(result);
		const hash = contentHash(result);
		return this.database.transaction(async (client) => {
			const job = await client.query<{
				benchmark_run_id: string;
				state: string;
				lease_owner: string | null;
				result_hash: string | null;
				runner_id: string | null;
			}>(
				"SELECT j.benchmark_run_id,j.state,j.lease_owner,br.result_hash,br.runner_id FROM jobs j JOIN benchmark_runs br ON br.id=j.benchmark_run_id WHERE j.id=$1 AND j.organization_id=$2 FOR UPDATE",
				[jobId, runner.organizationId],
			);
			const row =
				job.rows[0] ??
				fail("AUTH_UNAVAILABLE", "Runner does not own this job.");
			if (row.state === "SUCCEEDED") {
				if (row.runner_id !== runner.runnerId)
					fail("AUTH_UNAVAILABLE", "Runner does not own this job.");
				if (row.result_hash !== hash)
					fail("CONFIG_INVALID", "Conflicting result replay.");
				return { replay: true };
			}
			if (row.lease_owner !== runner.runnerId)
				fail("AUTH_UNAVAILABLE", "Runner does not own this job.");
			if (
				row.state !== "LEASED" ||
				!(
					await client.query(
						"SELECT 1 FROM runners WHERE id=$1 AND state='ACTIVE'",
						[runner.runnerId],
					)
				).rowCount
			)
				fail("AUTH_UNAVAILABLE", "Job lease is not active.");
			await client.query(
				"UPDATE benchmark_runs SET state='COMPLETED',canonical_result=$2,result_hash=$3,completed_at=$4,updated_at=$4 WHERE id=$1",
				[row.benchmark_run_id, result, hash, this.now().toISOString()],
			);
			await client.query(
				"UPDATE jobs SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,completed_at=$2,updated_at=$2 WHERE id=$1",
				[jobId, this.now().toISOString()],
			);
			await this.audit(
				client,
				runner.organizationId,
				"RUNNER",
				runner.runnerId,
				"run.completed",
				"benchmark_run",
				row.benchmark_run_id,
				{ result_hash: hash },
			);
			return { replay: false };
		});
	}

	async failJob(
		runner: Extract<Principal, { type: "RUNNER" }>,
		jobId: string,
		code: string,
		safeMessage: string,
		retryable: boolean,
	): Promise<void> {
		await this.database.transaction(async (client) => {
			const result = await client.query<{
				attempt_count: number;
				max_attempts: number;
			}>(
				"SELECT attempt_count,max_attempts FROM jobs WHERE id=$1 AND lease_owner=$2 AND state='LEASED' FOR UPDATE",
				[jobId, runner.runnerId],
			);
			const job =
				result.rows[0] ?? fail("AUTH_UNAVAILABLE", "Job lease is unavailable.");
			const terminal = !retryable || job.attempt_count >= job.max_attempts;
			const availableAt = new Date(
				this.now().getTime() + Math.min(300, 2 ** job.attempt_count) * 1_000,
			).toISOString();
			await client.query(
				"UPDATE jobs SET state=$2,lease_owner=NULL,lease_expires_at=NULL,available_at=CASE WHEN $2='QUEUED' THEN $5::timestamptz ELSE available_at END,final_error_code=$3,final_error_message=$4,completed_at=CASE WHEN $2='DEAD_LETTER' THEN $6::timestamptz ELSE NULL END,updated_at=$6::timestamptz WHERE id=$1",
				[
					jobId,
					terminal ? "DEAD_LETTER" : "QUEUED",
					code,
					safeMessage,
					availableAt,
					this.now().toISOString(),
				],
			);
		});
	}

	async createSchedule(
		actor: Principal,
		input: {
			organizationId: string;
			benchmarkVersionId: string;
			cadence: "HOURLY" | "DAILY" | "WEEKLY";
			nextRunAt: string;
		},
	): Promise<string> {
		await this.authorize(actor, input.organizationId, "BENCHMARK_RUN");
		const entitlements = await this.entitlements(input.organizationId);
		if (!entitlements.scheduled_runs)
			fail("AUTH_UNAVAILABLE", "Scheduled runs are not entitled.");
		const count = await this.database.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM schedules WHERE organization_id=$1 AND enabled",
			[input.organizationId],
		);
		if (Number(count.rows[0]?.count ?? 0) >= entitlements.max_schedules)
			fail("AUTH_UNAVAILABLE", "Schedule entitlement limit reached.");
		const id = randomUUID();
		await this.database.query(
			"INSERT INTO schedules(id,organization_id,benchmark_version_id,cadence,next_run_at) VALUES($1,$2,$3,$4,$5)",
			[
				id,
				input.organizationId,
				input.benchmarkVersionId,
				input.cadence,
				input.nextRunAt,
			],
		);
		return id;
	}

	async schedulerTick(limit = 100): Promise<number> {
		return this.database.transaction(async (client) => {
			const due = await client.query<{
				id: string;
				organization_id: string;
				benchmark_version_id: string;
				next_run_at: string;
				cadence: string;
				repository_id: string;
			}>(
				"SELECT s.id,s.organization_id,s.benchmark_version_id,s.next_run_at,s.cadence,b.repository_id FROM schedules s JOIN benchmark_versions bv ON bv.id=s.benchmark_version_id JOIN benchmarks b ON b.id=bv.benchmark_id WHERE s.enabled AND s.next_run_at<=$1 ORDER BY s.next_run_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT $2",
				[this.now().toISOString(), limit],
			);
			for (const schedule of due.rows) {
				const runId = randomUUID();
				const jobId = randomUUID();
				const inserted = await client.query(
					"INSERT INTO benchmark_runs(id,organization_id,repository_id,benchmark_version_id,state) VALUES($1,$2,$3,$4,'QUEUED') ON CONFLICT DO NOTHING RETURNING id",
					[
						runId,
						schedule.organization_id,
						schedule.repository_id,
						schedule.benchmark_version_id,
					],
				);
				if (!inserted.rowCount) continue;
				try {
					await client.query(
						"INSERT INTO schedule_occurrences(schedule_id,occurrence_at,benchmark_run_id) VALUES($1,$2,$3)",
						[schedule.id, schedule.next_run_at, runId],
					);
				} catch (error) {
					if ((error as { code?: string }).code === "23505") {
						await client.query("DELETE FROM benchmark_runs WHERE id=$1", [
							runId,
						]);
						continue;
					}
					throw error;
				}
				await client.query(
					"INSERT INTO jobs(id,organization_id,benchmark_run_id,type,payload,state,scheduled_at,available_at) VALUES($1,$2,$3,'BENCHMARK_RUN',$4,'QUEUED',$5,$5)",
					[
						jobId,
						schedule.organization_id,
						runId,
						{ run_id: runId, schedule_id: schedule.id },
						this.now().toISOString(),
					],
				);
				const interval =
					schedule.cadence === "HOURLY"
						? "1 hour"
						: schedule.cadence === "DAILY"
							? "1 day"
							: "1 week";
				await client.query(
					`UPDATE schedules SET last_run_at=next_run_at,next_run_at=next_run_at+interval '${interval}',updated_at=$2 WHERE id=$1`,
					[schedule.id, this.now().toISOString()],
				);
			}
			return due.rowCount ?? 0;
		});
	}

	async cancelRun(
		actor: Principal,
		organizationId: string,
		runId: string,
	): Promise<void> {
		await this.authorize(actor, organizationId, "BENCHMARK_RUN");
		await this.database.transaction(async (client) => {
			const result = await client.query(
				"UPDATE benchmark_runs SET state='CANCELLED',completed_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2 AND state IN ('QUEUED','RUNNING')",
				[runId, organizationId],
			);
			if (!result.rowCount) fail("CONFLICT", "Run cannot be cancelled.");
			await client.query(
				"UPDATE jobs SET state='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE benchmark_run_id=$1 AND state IN ('QUEUED','LEASED')",
				[runId],
			);
			await this.audit(
				client,
				organizationId,
				actor.type,
				actorId(actor),
				"run.cancelled",
				"benchmark_run",
				runId,
				{},
			);
		});
	}

	async recordUsage(
		runner: Extract<Principal, { type: "RUNNER" }>,
		input: {
			runId: string;
			attemptId?: string;
			type: string;
			provider?: string;
			model?: string;
			quantity: unknown;
			cost?: unknown;
			billingOwner?: "USER_BYOK" | "ORGANIZATION_BYOK" | "REPOARENA_SPONSORED";
		},
	): Promise<string> {
		const owned = await this.database.query(
			"SELECT 1 FROM benchmark_runs WHERE id=$1 AND organization_id=$2 AND runner_id=$3",
			[input.runId, runner.organizationId, runner.runnerId],
		);
		if (!owned.rowCount)
			fail("AUTH_UNAVAILABLE", "Runner does not own this run.");
		const id = randomUUID();
		const result = await this.database.query<{ id: string }>(
			"INSERT INTO usage_records(id,organization_id,benchmark_run_id,attempt_id,usage_type,provider,model,quantity,cost_snapshot,billing_owner) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(benchmark_run_id,attempt_id,usage_type) DO UPDATE SET quantity=usage_records.quantity RETURNING id",
			[
				id,
				runner.organizationId,
				input.runId,
				input.attemptId ?? null,
				input.type,
				input.provider ?? null,
				input.model ?? null,
				input.quantity,
				input.cost ?? null,
				input.billingOwner ?? "ORGANIZATION_BYOK",
			],
		);
		return result.rows[0]?.id ?? id;
	}

	async consumeRateLimit(
		bucketKey: string,
		limit: number,
		windowMs: number,
	): Promise<{ allowed: boolean; remaining: number }> {
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			!Number.isInteger(windowMs) ||
			windowMs < 1
		)
			fail("CONFIG_INVALID", "Rate limit policy is invalid.");
		const boundary = new Date(this.now().getTime() - windowMs).toISOString();
		return this.database.transaction(async (client) => {
			const result = await client.query<{ count: number }>(
				"INSERT INTO rate_limit_buckets(bucket_key,window_started_at,count) VALUES($1,$2,1) ON CONFLICT(bucket_key) DO UPDATE SET window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=$3 THEN $2 ELSE rate_limit_buckets.window_started_at END,count=CASE WHEN rate_limit_buckets.window_started_at<=$3 THEN 1 ELSE rate_limit_buckets.count+1 END,updated_at=$2 RETURNING count",
				[bucketKey, this.now().toISOString(), boundary],
			);
			const count = result.rows[0]?.count ?? limit + 1;
			return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
		});
	}

	async recordMetric(
		name: string,
		value: number,
		labels: Record<string, string> = {},
		organizationId?: string,
	): Promise<void> {
		if (!/^[a-z][a-z0-9_.-]{1,100}$/.test(name) || !Number.isFinite(value))
			fail("CONFIG_INVALID", "Metric is invalid.");
		await this.database.query(
			"INSERT INTO metric_events(id,organization_id,name,value,labels,recorded_at) VALUES($1,$2,$3,$4,$5,$6)",
			[randomUUID(), organizationId ?? null, name, value, labels, this.now()],
		);
	}

	async listRuns(
		actor: Principal,
		organizationId: string,
		cursor?: { createdAt: string; id: string },
		limit = 50,
	): Promise<{
		items: unknown[];
		next: { createdAt: string; id: string } | null;
	}> {
		await this.authorize(actor, organizationId, "REPOSITORY_READ");
		if (!Number.isInteger(limit) || limit < 1 || limit > 200)
			fail("CONFIG_INVALID", "Invalid page size.");
		const result = await this.database.query<{
			id: string;
			state: string;
			canonical_result: unknown;
			created_at: Date;
		}>(
			"SELECT id,state,canonical_result,created_at FROM benchmark_runs WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4",
			[
				organizationId,
				cursor?.createdAt ?? null,
				cursor?.id ?? null,
				limit + 1,
			],
		);
		const items = result.rows.slice(0, limit);
		const last = items.at(-1);
		return {
			items,
			next:
				result.rows.length > limit && last
					? { createdAt: last.created_at.toISOString(), id: last.id }
					: null,
		};
	}

	async staleRunner(runnerId: string, staleAfterMs: number): Promise<boolean> {
		const result = await this.database.query<{
			last_heartbeat_at: Date | null;
			state: string;
		}>("SELECT last_heartbeat_at,state FROM runners WHERE id=$1", [runnerId]);
		const row = result.rows[0];
		return (
			!row ||
			row.state !== "ACTIVE" ||
			!row.last_heartbeat_at ||
			this.now().getTime() - row.last_heartbeat_at.getTime() > staleAfterMs
		);
	}

	private async audit(
		client: { query(text: string, values?: unknown[]): Promise<unknown> },
		organizationId: string | null,
		actorType: string,
		actorId: string,
		action: string,
		targetType: string,
		targetId: string,
		metadata: unknown,
	) {
		await client.query(
			"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
			[
				randomUUID(),
				organizationId,
				actorType,
				actorId,
				action,
				targetType,
				targetId,
				metadata,
			],
		);
	}
}

export class ArtifactService {
	constructor(
		private readonly database: Database,
		private readonly storage: ObjectStorage,
		private readonly cloud: CloudService,
	) {}
	async allocate(
		runner: Extract<Principal, { type: "RUNNER" }>,
		jobId: string,
	): Promise<string> {
		const result = await this.database.query(
			"SELECT 1 FROM jobs WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND state='LEASED'",
			[jobId, runner.organizationId, runner.runnerId],
		);
		if (!result.rowCount)
			fail("AUTH_UNAVAILABLE", "Runner does not own this artifact job.");
		return objectKey(runner.organizationId);
	}
	async finalize(
		runner: Extract<Principal, { type: "RUNNER" }>,
		input: {
			jobId: string;
			attemptId?: string;
			key: string;
			logicalPath: string;
			sha256: string;
			size: number;
			mediaType?: string;
			visibility: "PUBLIC" | "PRIVATE";
		},
	): Promise<string> {
		const job = await this.database.query<{ benchmark_run_id: string }>(
			"SELECT benchmark_run_id FROM jobs WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND state='LEASED'",
			[input.jobId, runner.organizationId, runner.runnerId],
		);
		const runId =
			job.rows[0]?.benchmark_run_id ??
			fail("AUTH_UNAVAILABLE", "Runner does not own this artifact job.");
		if (!input.key.startsWith(`org/${runner.organizationId}/objects/`))
			fail("AUTH_UNAVAILABLE", "Artifact object tenant does not match runner.");
		const actual = await this.storage.head(input.key);
		if (
			!actual ||
			actual.size !== input.size ||
			actual.checksum !== input.sha256
		)
			fail("CONFIG_INVALID", "Artifact metadata does not match stored object.");
		const id = randomUUID();
		await this.database.query(
			"INSERT INTO artifacts(id,organization_id,benchmark_run_id,attempt_id,visibility,logical_path,object_key,sha256,size_bytes,media_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
			[
				id,
				runner.organizationId,
				runId,
				input.attemptId ?? null,
				input.visibility,
				input.logicalPath,
				input.key,
				input.sha256,
				input.size,
				input.mediaType ?? null,
			],
		);
		return id;
	}
	async signedRead(
		actor: Principal,
		organizationId: string,
		artifactId: string,
		expiresSeconds = 300,
	): Promise<string> {
		await this.cloud.authorize(actor, organizationId, "REPOSITORY_READ");
		const artifact = await this.database.query<{
			object_key: string;
			visibility: string;
		}>(
			"SELECT object_key,visibility FROM artifacts WHERE id=$1 AND organization_id=$2 AND retention_state='ACTIVE'",
			[artifactId, organizationId],
		);
		const row = artifact.rows[0] ?? fail("NOT_FOUND", "Artifact not found.");
		if (row.visibility === "EVALUATOR_PRIVATE")
			fail(
				"AUTH_UNAVAILABLE",
				"Evaluator-private artifacts require the private evaluator service.",
			);
		return this.storage.signedReadUrl(row.object_key, expiresSeconds);
	}
}
