import { randomUUID } from "node:crypto";
import type { CloudService, Principal } from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { contentHash, RepoArenaError } from "@repoarena/core";
import {
	GitHubError,
	verifyWebhook,
	type GitHubRepository,
} from "@repoarena/github-provider";
import { z } from "zod";
export * from "./oidc.js";

export type TriggerPolicy = Readonly<{
	pushDefaultBranch: boolean;
	pullRequests: boolean;
	includeDrafts: boolean;
	forkPolicy: "SKIP" | "UNPRIVILEGED";
	branches?: readonly string[];
	paths?: readonly string[];
	budget: {
		max_attempts: number;
		max_cost_micros?: number;
		max_runtime_ms?: number;
	};
}>;
export type TriggerDecision = Readonly<{
	run: boolean;
	reason: string;
	privileged: boolean;
}>;

const matchGlob = (value: string, pattern: string) => {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\0")
		.replaceAll("*", "[^/]*")
		.replaceAll("\0", ".*");
	return new RegExp(`^${escaped}$`).test(value);
};
export const evaluateTrigger = (input: {
	event: "push" | "pull_request";
	policy: TriggerPolicy;
	ref: string;
	defaultBranch: string;
	draft?: boolean;
	fork?: boolean;
	changedPaths?: readonly string[];
	changedPathsComplete?: boolean;
}): TriggerDecision => {
	if (
		input.policy.budget.max_attempts < 1 ||
		input.policy.budget.max_attempts > 100
	)
		return { run: false, reason: "INVALID_BUDGET", privileged: false };
	if (input.event === "push" && !input.policy.pushDefaultBranch)
		return { run: false, reason: "PUSH_DISABLED", privileged: false };
	if (
		input.event === "push" &&
		input.ref !== `refs/heads/${input.defaultBranch}`
	)
		return { run: false, reason: "NON_DEFAULT_BRANCH", privileged: false };
	if (input.event === "pull_request" && !input.policy.pullRequests)
		return { run: false, reason: "PULL_REQUEST_DISABLED", privileged: false };
	if (input.draft && !input.policy.includeDrafts)
		return { run: false, reason: "DRAFT", privileged: false };
	if (input.fork && input.policy.forkPolicy === "SKIP")
		return { run: false, reason: "FORK_RESTRICTED", privileged: false };
	if (
		input.policy.branches?.length &&
		!input.policy.branches.some((pattern) =>
			matchGlob(input.ref.replace(/^refs\/heads\//, ""), pattern),
		)
	)
		return { run: false, reason: "BRANCH_FILTERED", privileged: false };
	if (
		input.policy.paths?.length &&
		input.changedPathsComplete === true &&
		!(input.changedPaths ?? []).some((path) =>
			input.policy.paths?.some((pattern) => matchGlob(path, pattern)),
		)
	)
		return { run: false, reason: "PATH_FILTERED", privileged: false };
	return {
		run: true,
		reason:
			input.changedPathsComplete === false
				? "PATH_EVIDENCE_INCOMPLETE_RUN_SAFELY"
				: "MATCHED",
		privileged: !input.fork,
	};
};

export const checkConclusion = (result: {
	state?: string;
	statistics?: { solved?: number; task_count?: number };
	failure_code?: string;
}) => {
	if (result.state === "CANCELLED") return "cancelled" as const;
	if (result.state === "TIMED_OUT") return "timed_out" as const;
	if (result.state === "INFRASTRUCTURE_FAILURE") return "neutral" as const;
	return result.statistics?.task_count !== undefined &&
		result.statistics.solved === result.statistics.task_count
		? ("success" as const)
		: ("failure" as const);
};

type Provider = {
	listInstallationRepositories(id: string): Promise<GitHubRepository[]>;
	createCheckRun(
		id: string,
		owner: string,
		repo: string,
		input: unknown,
	): Promise<{ id: number }>;
	updateCheckRun(
		id: string,
		owner: string,
		repo: string,
		checkId: number,
		input: unknown,
	): Promise<unknown>;
	upsertPullRequestComment(
		id: string,
		owner: string,
		repo: string,
		pull: number,
		marker: string,
		body: string,
	): Promise<number>;
	invalidateInstallationToken(id: string): void;
};

const deliveryId = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const installationSchema = z.object({
	id: z.number().int().positive(),
	account: z.object({
		id: z.number().int().positive(),
		login: z.string().min(1),
		type: z.enum(["User", "Organization", "Enterprise", "Bot"]),
	}),
	permissions: z.record(z.string()).default({}),
	repository_selection: z.enum(["all", "selected"]),
	suspended_at: z.string().nullable().optional(),
});
const repositorySchema = z.object({
	id: z.number().int().positive(),
	name: z.string(),
	full_name: z.string(),
	private: z.boolean(),
	visibility: z.string().optional(),
	default_branch: z.string(),
	archived: z.boolean(),
	clone_url: z.string().url(),
	html_url: z.string().url(),
	owner: z.object({ login: z.string() }),
});

export class GitHubIntegration {
	constructor(
		private readonly database: Database,
		private readonly cloud: CloudService,
		private readonly provider: Provider,
		private readonly webhookSecret: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	async linkInstallation(
		actor: Principal,
		organizationId: string,
		installation: z.infer<typeof installationSchema>,
	): Promise<string> {
		await this.cloud.authorize(actor, organizationId, "ORG_MANAGE");
		const parsed = installationSchema.parse(installation);
		const id = randomUUID();
		try {
			await this.database.transaction(async (client) => {
				await client.query(
					"INSERT INTO github_installations(id,organization_id,github_installation_id,github_account_id,account_login,account_type,permissions,repository_selection,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')",
					[
						id,
						organizationId,
						String(parsed.id),
						String(parsed.account.id),
						parsed.account.login,
						parsed.account.type,
						parsed.permissions,
						parsed.repository_selection,
					],
				);
				await client.query(
					"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'github.installation_linked','github_installation',$5,$6)",
					[
						randomUUID(),
						organizationId,
						actor.type,
						actor.type === "USER" ? actor.userId : null,
						id,
						{ github_installation_id: String(parsed.id) },
					],
				);
			});
		} catch (error) {
			if ((error as { code?: string }).code === "23505")
				throw new RepoArenaError(
					"CONFLICT",
					"GitHub installation is already linked.",
				);
			throw error;
		}
		return id;
	}

	async setTriggerPolicy(
		actor: Principal,
		input: {
			organizationId: string;
			repositoryId: string;
			benchmarkVersionId: string;
			policy: TriggerPolicy;
		},
	): Promise<string> {
		await this.cloud.authorize(
			actor,
			input.organizationId,
			"REPOSITORY_MANAGE",
		);
		if (
			!evaluateTrigger({
				event: "push",
				policy: input.policy,
				ref: "refs/heads/main",
				defaultBranch: "main",
			}).run &&
			input.policy.budget.max_attempts > 100
		)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"GitHub trigger budget is invalid.",
			);
		const id = randomUUID();
		const userId =
			actor.type === "USER"
				? actor.userId
				: (() => {
						throw new RepoArenaError(
							"FORBIDDEN",
							"User authorization required.",
						);
					})();
		await this.database.query(
			"INSERT INTO github_trigger_policies(id,organization_id,repository_id,benchmark_version_id,policy,created_by_user_id) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM repositories WHERE id=$3 AND organization_id=$2) ON CONFLICT(repository_id,benchmark_version_id) DO UPDATE SET policy=excluded.policy,enabled=true,updated_at=now()",
			[
				id,
				input.organizationId,
				input.repositoryId,
				input.benchmarkVersionId,
				input.policy,
				userId,
			],
		);
		return id;
	}

	async ingest(
		rawBody: Uint8Array,
		headers: { signature?: string; event?: string; delivery?: string },
	): Promise<{ deliveryId: string; duplicate: boolean }> {
		if (rawBody.byteLength > 1_000_000)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"GitHub webhook body is too large.",
			);
		try {
			verifyWebhook(rawBody, headers.signature, this.webhookSecret);
		} catch {
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub webhook signature is invalid.",
			);
		}
		const event = z
			.enum([
				"installation",
				"installation_repositories",
				"push",
				"pull_request",
			])
			.parse(headers.event);
		const delivery = deliveryId.parse(headers.delivery);
		let payload: unknown;
		try {
			payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
		} catch {
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"GitHub webhook JSON is invalid.",
			);
		}
		const basic = z
			.object({
				action: z.string().optional(),
				installation: z.object({ id: z.number().int().positive() }).optional(),
			})
			.passthrough()
			.parse(payload);
		const hash = contentHash(payload);
		return this.database.transaction(async (client) => {
			const existing = await client.query<{ id: string; payload_hash: string }>(
				"SELECT id,payload_hash FROM github_webhook_deliveries WHERE delivery_id=$1 FOR UPDATE",
				[delivery],
			);
			if (existing.rows[0]) {
				if (existing.rows[0].payload_hash !== hash)
					throw new RepoArenaError(
						"CONFLICT",
						"GitHub delivery payload conflicts with its recorded hash.",
					);
				return { deliveryId: existing.rows[0].id, duplicate: true };
			}
			const installation = basic.installation
				? await client.query<{ organization_id: string }>(
						"SELECT organization_id FROM github_installations WHERE github_installation_id=$1",
						[String(basic.installation.id)],
					)
				: { rows: [] };
			const id = randomUUID();
			const organizationId = installation.rows[0]?.organization_id ?? null;
			await client.query(
				"INSERT INTO github_webhook_deliveries(id,delivery_id,event_type,action,github_installation_id,organization_id,payload,payload_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
				[
					id,
					delivery,
					event,
					basic.action ?? null,
					basic.installation ? String(basic.installation.id) : null,
					organizationId,
					payload,
					hash,
					organizationId ? "QUEUED" : "IGNORED",
				],
			);
			if (organizationId)
				await client.query(
					"INSERT INTO jobs(id,organization_id,type,payload,state,requirements,scheduled_at,available_at) VALUES($1,$2,'GITHUB_WEBHOOK',$3,'QUEUED',$4,$5,$5)",
					[
						randomUUID(),
						organizationId,
						{ delivery_id: id },
						{ control_plane: "github" },
						this.now(),
					],
				);
			return { deliveryId: id, duplicate: false };
		});
	}

	async syncInstallation(installationId: string): Promise<number> {
		const installation = await this.database.query<{
			id: string;
			organization_id: string;
			github_installation_id: string;
			state: string;
		}>(
			"SELECT id,organization_id,github_installation_id,state FROM github_installations WHERE id=$1",
			[installationId],
		);
		const row = installation.rows[0];
		if (!row || !["PENDING", "ACTIVE"].includes(row.state))
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub installation is unavailable.",
			);
		const repositories = await this.provider.listInstallationRepositories(
			row.github_installation_id,
		);
		const entitlements = await this.cloud.entitlements(row.organization_id);
		const eligible = repositories.filter(
			(repository) => !repository.private || entitlements.private_repositories,
		);
		await this.database.transaction(async (client) => {
			for (const repository of eligible)
				await this.upsertRepository(client, row, repository);
			await client.query(
				"UPDATE repositories SET state='ARCHIVED',updated_at=$2 WHERE github_installation_id=$1 AND external_id <> ALL($3::text[])",
				[row.id, this.now(), eligible.map((repo) => String(repo.id))],
			);
			await client.query(
				"UPDATE github_installations SET state='ACTIVE',installed_at=coalesce(installed_at,$2),updated_at=$2 WHERE id=$1",
				[row.id, this.now()],
			);
		});
		return eligible.length;
	}

	private async upsertRepository(
		client: { query(text: string, values?: unknown[]): Promise<unknown> },
		installation: { id: string; organization_id: string },
		repository: GitHubRepository,
	) {
		await client.query(
			"INSERT INTO repositories(id,organization_id,provider,external_id,owner_name,repository_name,default_branch,visibility,installation_id,github_installation_id,full_name,clone_url,html_url,state) VALUES($1,$2,'github',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(provider,external_id) WHERE provider='github' DO UPDATE SET owner_name=excluded.owner_name,repository_name=excluded.repository_name,default_branch=excluded.default_branch,visibility=excluded.visibility,installation_id=excluded.installation_id,github_installation_id=excluded.github_installation_id,full_name=excluded.full_name,clone_url=excluded.clone_url,html_url=excluded.html_url,state=excluded.state,updated_at=now()",
			[
				randomUUID(),
				installation.organization_id,
				String(repository.id),
				repository.owner.login,
				repository.name,
				repository.default_branch,
				repository.private
					? "PRIVATE"
					: repository.visibility === "internal"
						? "INTERNAL"
						: "PUBLIC",
				installation.id,
				installation.id,
				repository.full_name,
				repository.clone_url,
				repository.html_url,
				repository.archived ? "ARCHIVED" : "ACTIVE",
			],
		);
	}

	async processDelivery(
		id: string,
	): Promise<{ state: "PROCESSED" | "IGNORED"; runId?: string }> {
		const claimed = await this.database.query<{
			event_type: string;
			action: string | null;
			payload: unknown;
			organization_id: string | null;
			github_installation_id: string | null;
		}>(
			"UPDATE github_webhook_deliveries SET state='PROCESSING',updated_at=$2 WHERE id=$1 AND state IN ('QUEUED','FAILED') RETURNING event_type,action,payload,organization_id,github_installation_id",
			[id, this.now()],
		);
		const delivery = claimed.rows[0];
		if (!delivery)
			throw new RepoArenaError(
				"CONFLICT",
				"GitHub delivery is not processable.",
			);
		try {
			const result = await this.handleDelivery(id, delivery);
			await this.finishDelivery(id, result.state);
			return result;
		} catch (error) {
			const code =
				error instanceof GitHubError
					? error.code
					: error instanceof RepoArenaError
						? error.code
						: "GITHUB_PROCESSING_FAILED";
			const message =
				error instanceof Error
					? error.message.slice(0, 500)
					: "GitHub processing failed.";
			const retryable = error instanceof GitHubError && error.retryable;
			const availableAt = new Date(
				this.now().getTime() +
					Math.min(
						error instanceof GitHubError
							? (error.retryAfterMs ?? 60_000)
							: 60_000,
						3_600_000,
					),
			);
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE github_webhook_deliveries SET state='FAILED',failure_code=$2,failure_message=$3,updated_at=$4 WHERE id=$1",
					[id, code, message, this.now()],
				);
				await client.query(
					"UPDATE jobs SET attempt_count=attempt_count+1,state=CASE WHEN $2 AND attempt_count+1<max_attempts THEN 'QUEUED' ELSE 'DEAD_LETTER' END,available_at=CASE WHEN $2 THEN $3::timestamptz ELSE available_at END,final_error_code=$4,final_error_message=$5,completed_at=CASE WHEN $2 AND attempt_count+1<max_attempts THEN NULL ELSE $6::timestamptz END,updated_at=$6::timestamptz WHERE type='GITHUB_WEBHOOK' AND payload->>'delivery_id'=$1 AND state='QUEUED'",
					[id, retryable, availableAt, code, message, this.now()],
				);
			});
			throw error;
		}
	}

	async processQueued(
		limit = 25,
	): Promise<{ processed: number; failed: number }> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"GitHub delivery batch size is invalid.",
			);
		const jobs = await this.database.query<{ delivery_id: string }>(
			"SELECT payload->>'delivery_id' AS delivery_id FROM jobs WHERE type='GITHUB_WEBHOOK' AND state='QUEUED' AND available_at<=$1 ORDER BY priority DESC,created_at,id LIMIT $2",
			[this.now(), limit],
		);
		let processed = 0;
		let failed = 0;
		for (const job of jobs.rows) {
			try {
				await this.processDelivery(job.delivery_id);
				processed++;
			} catch {
				failed++;
			}
		}
		return { processed, failed };
	}

	private async handleDelivery(
		id: string,
		delivery: {
			event_type: string;
			action: string | null;
			payload: unknown;
			organization_id: string | null;
			github_installation_id: string | null;
		},
	): Promise<{ state: "PROCESSED" | "IGNORED"; runId?: string }> {
		if (delivery.event_type === "installation")
			return this.handleInstallation(delivery);
		if (delivery.event_type === "installation_repositories") {
			const installation = await this.installationByExternal(
				delivery.github_installation_id,
			);
			await this.syncInstallation(installation.id);
			return { state: "PROCESSED" };
		}
		if (!delivery.organization_id || !delivery.github_installation_id)
			return { state: "IGNORED" };
		return this.handleTrigger(id, delivery);
	}

	private async handleInstallation(delivery: {
		action: string | null;
		payload: unknown;
		github_installation_id: string | null;
	}): Promise<{ state: "PROCESSED" | "IGNORED" }> {
		const installation = await this.installationByExternal(
			delivery.github_installation_id,
		);
		if (delivery.action === "deleted") {
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE github_installations SET state='UNINSTALLED',uninstalled_at=$2,updated_at=$2 WHERE id=$1",
					[installation.id, this.now()],
				);
				await client.query(
					"UPDATE repositories SET state='ARCHIVED',updated_at=$2 WHERE github_installation_id=$1",
					[installation.id, this.now()],
				);
				await client.query(
					"INSERT INTO audit_events(id,organization_id,actor_type,action,target_type,target_id,metadata) VALUES($1,$2,'SYSTEM','github.installation_removed','github_installation',$3,$4)",
					[randomUUID(), installation.organization_id, installation.id, {}],
				);
			});
			this.provider.invalidateInstallationToken(
				installation.github_installation_id,
			);
			return { state: "PROCESSED" };
		}
		if (delivery.action === "suspend" || delivery.action === "unsuspend") {
			await this.database.query(
				"UPDATE github_installations SET state=$2,suspended_at=$3,updated_at=$4 WHERE id=$1",
				[
					installation.id,
					delivery.action === "suspend" ? "SUSPENDED" : "ACTIVE",
					delivery.action === "suspend" ? this.now() : null,
					this.now(),
				],
			);
			if (delivery.action === "suspend")
				this.provider.invalidateInstallationToken(
					installation.github_installation_id,
				);
			return { state: "PROCESSED" };
		}
		await this.syncInstallation(installation.id);
		return { state: "PROCESSED" };
	}

	private async handleTrigger(
		deliveryIdValue: string,
		delivery: {
			event_type: string;
			payload: unknown;
			organization_id: string | null;
			github_installation_id: string | null;
		},
	): Promise<{ state: "PROCESSED" | "IGNORED"; runId?: string }> {
		const parsed = z
			.object({
				repository: repositorySchema,
				ref: z.string().optional(),
				before: z.string().optional(),
				after: sha.optional(),
				head_commit: z.unknown().optional(),
				pull_request: z
					.object({
						number: z.number().int().positive(),
						draft: z.boolean(),
						head: z.object({
							sha,
							repo: z.object({ id: z.number().int().positive() }),
						}),
						base: z.object({
							sha,
							repo: z.object({ id: z.number().int().positive() }),
						}),
					})
					.optional(),
			})
			.passthrough()
			.parse(delivery.payload);
		const repository = await this.database.query<{
			id: string;
			organization_id: string;
			default_branch: string;
			owner_name: string;
			repository_name: string;
			state: string;
			github_installation_id: string;
		}>(
			"SELECT id,organization_id,default_branch,owner_name,repository_name,state,github_installation_id FROM repositories WHERE provider='github' AND external_id=$1 AND organization_id=$2",
			[String(parsed.repository.id), delivery.organization_id],
		);
		const repo = repository.rows[0];
		if (!repo || repo.state !== "ACTIVE") return { state: "IGNORED" };
		const policyRow = await this.database.query<{
			benchmark_version_id: string;
			policy: TriggerPolicy;
		}>(
			"SELECT benchmark_version_id,policy FROM github_trigger_policies WHERE repository_id=$1 AND enabled ORDER BY created_at LIMIT 1",
			[repo.id],
		);
		const configured = policyRow.rows[0];
		if (!configured) return { state: "IGNORED" };
		const pr = parsed.pull_request;
		const event = delivery.event_type === "push" ? "push" : "pull_request";
		const decision = evaluateTrigger({
			event,
			policy: configured.policy,
			ref: parsed.ref ?? `refs/heads/${repo.default_branch}`,
			defaultBranch: repo.default_branch,
			...(pr
				? { draft: pr.draft, fork: pr.head.repo.id !== pr.base.repo.id }
				: {}),
			changedPathsComplete: false,
		});
		if (!decision.run) return { state: "IGNORED" };
		const headSha = pr?.head.sha ?? parsed.after;
		if (!headSha) return { state: "IGNORED" };
		const principal: Principal = {
			type: "SYSTEM",
			organizationId: repo.organization_id,
			actorId: repo.github_installation_id,
			integration: "GITHUB",
		};
		const run = await this.cloud.createRun(principal, {
			organizationId: repo.organization_id,
			repositoryId: repo.id,
			benchmarkVersionId: configured.benchmark_version_id,
			idempotencyKey: `github:${deliveryIdValue}`,
			budget: configured.policy.budget,
		});
		const provenance = {
			provider: "github",
			delivery_id: deliveryIdValue,
			event,
			ref: parsed.ref ?? null,
			head_sha: headSha,
			base_sha: pr?.base.sha ?? parsed.before ?? null,
			pull_request_number: pr?.number ?? null,
			privileged: decision.privileged,
		};
		await this.database.query(
			"UPDATE benchmark_runs SET trigger_provenance=$2 WHERE id=$1",
			[run.runId, provenance],
		);
		await this.database.query(
			"INSERT INTO audit_events(id,organization_id,actor_type,action,target_type,target_id,metadata) VALUES($1,$2,'SYSTEM','github.run_triggered','benchmark_run',$3,$4)",
			[
				randomUUID(),
				repo.organization_id,
				run.runId,
				{ delivery_id: deliveryIdValue, event, head_sha: headSha },
			],
		);
		const installation = await this.installationByExternal(
			delivery.github_installation_id,
		);
		const check = await this.provider.createCheckRun(
			installation.github_installation_id,
			repo.owner_name,
			repo.repository_name,
			{
				name: "RepoArena",
				head_sha: headSha,
				status: "queued",
				external_id: run.runId,
				output: {
					title: "RepoArena benchmark queued",
					summary: "The benchmark is waiting for a compatible runner.",
				},
			},
		);
		await this.database.query(
			"INSERT INTO github_check_runs(id,organization_id,repository_id,benchmark_run_id,github_check_run_id,head_sha,status,pull_request_number) VALUES($1,$2,$3,$4,$5,$6,'queued',$7)",
			[
				randomUUID(),
				repo.organization_id,
				repo.id,
				run.runId,
				String(check.id),
				headSha,
				pr?.number ?? null,
			],
		);
		return { state: "PROCESSED", runId: run.runId };
	}

	async publishRun(runId: string): Promise<void> {
		const result = await this.database.query<{
			canonical_result: {
				state?: string;
				statistics?: { solved?: number; task_count?: number };
				failure_code?: string;
			};
			github_check_run_id: string;
			head_sha: string;
			pull_request_number: number | null;
			github_installation_id: string;
			owner_name: string;
			repository_name: string;
			repository_id: string;
			organization_id: string;
		}>(
			"SELECT br.canonical_result,gcr.github_check_run_id,gcr.head_sha,gcr.pull_request_number,r.github_installation_id,r.owner_name,r.repository_name,r.id AS repository_id,r.organization_id FROM benchmark_runs br JOIN github_check_runs gcr ON gcr.benchmark_run_id=br.id JOIN repositories r ON r.id=gcr.repository_id WHERE br.id=$1 AND br.state='COMPLETED'",
			[runId],
		);
		const row = result.rows[0];
		if (!row?.canonical_result)
			throw new RepoArenaError(
				"CONFLICT",
				"Completed GitHub run result is unavailable.",
			);
		const installation = await this.database.query<{
			github_installation_id: string;
		}>(
			"SELECT github_installation_id FROM github_installations WHERE id=$1 AND state='ACTIVE'",
			[row.github_installation_id],
		);
		const external = installation.rows[0]?.github_installation_id;
		if (!external)
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub installation is unavailable.",
			);
		const stats = row.canonical_result.statistics ?? {};
		const conclusion = checkConclusion(row.canonical_result);
		const summary = `Tasks: ${stats.task_count ?? "unknown"}\n\nSolved: ${stats.solved ?? "unknown"}\n\nConclusion: ${conclusion}`;
		await this.provider.updateCheckRun(
			external,
			row.owner_name,
			row.repository_name,
			Number(row.github_check_run_id),
			{
				status: "completed",
				conclusion,
				completed_at: this.now().toISOString(),
				output: { title: `RepoArena: ${conclusion}`, summary },
			},
		);
		await this.database.query(
			"UPDATE github_check_runs SET status='completed',conclusion=$2,updated_at=$3 WHERE benchmark_run_id=$1",
			[runId, conclusion, this.now()],
		);
		if (row.pull_request_number) {
			const marker = "<!-- repoarena-benchmark -->";
			const commentId = await this.provider.upsertPullRequestComment(
				external,
				row.owner_name,
				row.repository_name,
				row.pull_request_number,
				marker,
				summary,
			);
			await this.database.query(
				"INSERT INTO github_managed_comments(id,organization_id,repository_id,pull_request_number,github_comment_id,marker) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(repository_id,pull_request_number,marker) DO UPDATE SET github_comment_id=excluded.github_comment_id,updated_at=now()",
				[
					randomUUID(),
					row.organization_id,
					row.repository_id,
					row.pull_request_number,
					String(commentId),
					marker,
				],
			);
		}
	}

	async markRunStarted(runId: string): Promise<void> {
		const result = await this.database.query<{
			github_check_run_id: string;
			github_installation_id: string;
			owner_name: string;
			repository_name: string;
		}>(
			"SELECT gcr.github_check_run_id,r.github_installation_id,r.owner_name,r.repository_name FROM github_check_runs gcr JOIN repositories r ON r.id=gcr.repository_id WHERE gcr.benchmark_run_id=$1 AND gcr.status='queued'",
			[runId],
		);
		const row = result.rows[0];
		if (!row) return;
		const installation = await this.database.query<{
			github_installation_id: string;
		}>(
			"SELECT github_installation_id FROM github_installations WHERE id=$1 AND state='ACTIVE'",
			[row.github_installation_id],
		);
		const external = installation.rows[0]?.github_installation_id;
		if (!external)
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub installation is unavailable.",
			);
		await this.provider.updateCheckRun(
			external,
			row.owner_name,
			row.repository_name,
			Number(row.github_check_run_id),
			{ status: "in_progress", started_at: this.now().toISOString() },
		);
		await this.database.query(
			"UPDATE github_check_runs SET status='in_progress',updated_at=$2 WHERE benchmark_run_id=$1 AND status='queued'",
			[runId, this.now()],
		);
	}

	private async finishDelivery(id: string, state: "PROCESSED" | "IGNORED") {
		await this.database.transaction(async (client) => {
			await client.query(
				"UPDATE github_webhook_deliveries SET state=$2,processed_at=$3,updated_at=$3 WHERE id=$1",
				[id, state, this.now()],
			);
			await client.query(
				"UPDATE jobs SET state='SUCCEEDED',completed_at=$2,updated_at=$2 WHERE type='GITHUB_WEBHOOK' AND payload->>'delivery_id'=$1 AND state='QUEUED'",
				[id, this.now()],
			);
		});
	}

	private async installationByExternal(value: string | null) {
		if (!value)
			throw new RepoArenaError(
				"NOT_FOUND",
				"GitHub installation is unavailable.",
			);
		const result = await this.database.query<{
			id: string;
			organization_id: string;
			github_installation_id: string;
			state: string;
		}>(
			"SELECT id,organization_id,github_installation_id,state FROM github_installations WHERE github_installation_id=$1",
			[value],
		);
		return (
			result.rows[0] ??
			(() => {
				throw new RepoArenaError(
					"NOT_FOUND",
					"GitHub installation is unavailable.",
				);
			})()
		);
	}
}
