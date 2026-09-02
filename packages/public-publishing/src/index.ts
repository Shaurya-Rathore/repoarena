import { randomBytes, randomUUID } from "node:crypto";
import type { CloudService, Principal } from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { contentHash, RepoArenaError } from "@repoarena/core";
import { z } from "zod";

const statisticsSchema = z
	.object({
		task_count: z.number().int().nonnegative(),
		attempt_count: z.number().int().nonnegative(),
		solved_count: z.number().int().nonnegative(),
		success_rate: z.number().min(0).max(1).nullable(),
		pass_at_k: z.number().min(0).max(1).nullable(),
		median_duration_ms: z.number().nonnegative().nullable(),
		total_cost_micros: z.number().nonnegative().nullable(),
	})
	.passthrough();
const publicResultSchema = z
	.object({
		schema: z.string().optional(),
		state: z.string(),
		statistics: statisticsSchema,
		agents: z
			.array(
				z
					.object({ id: z.string(), model: z.string().nullable().optional() })
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();
const repositoryProjectionSchema = z
	.object({
		name: z.string(),
		url: z.string().url().nullable(),
		visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
	})
	.strict();
const runProjectionSchema = z
	.object({
		id: z.string().uuid(),
		state: z.string(),
		statistics: statisticsSchema,
		agents: z.array(
			z.object({ id: z.string(), model: z.string().nullable() }).strict(),
		),
		completed_at: z.string().datetime(),
		provenance: z
			.object({
				benchmark_version_id: z.string().uuid(),
				configuration_hash: z.string(),
				task_set_hash: z.string(),
			})
			.strict(),
	})
	.strict();

export type PublicRunProjection = Readonly<{
	public_id: string;
	repository: {
		name: string;
		url: string | null;
		visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
	};
	run: {
		id: string;
		state: string;
		statistics: z.infer<typeof statisticsSchema>;
		agents: readonly { id: string; model: string | null }[];
		completed_at: string;
		provenance: {
			benchmark_version_id: string;
			configuration_hash: string;
			task_set_hash: string;
		};
	};
	methodology_version: string;
	published_at: string;
}>;

const storedProjection = (row: {
	public_id: string;
	repository_projection: unknown;
	run_projection: unknown;
	methodology_version: string;
	published_at: Date;
}): PublicRunProjection => ({
	public_id: row.public_id,
	repository: repositoryProjectionSchema.parse(row.repository_projection),
	run: runProjectionSchema.parse(row.run_projection),
	methodology_version: row.methodology_version,
	published_at: row.published_at.toISOString(),
});

export type LeaderboardEligibility =
	| "ELIGIBLE"
	| "INSUFFICIENT_SAMPLE"
	| "INCOMPARABLE_TASK_SET"
	| "PRIVATE_RESULT"
	| "INVALID_PROVENANCE"
	| "OUTDATED_METHODOLOGY"
	| "INFRASTRUCTURE_INVALID";
export const eligibility = (
	projection: PublicRunProjection,
	currentMethodology = "repoarena.methodology/v1",
): LeaderboardEligibility => {
	if (projection.repository.visibility !== "PUBLIC") return "PRIVATE_RESULT";
	if (projection.methodology_version !== currentMethodology)
		return "OUTDATED_METHODOLOGY";
	if (projection.run.state !== "COMPLETED") return "INFRASTRUCTURE_INVALID";
	if (
		projection.run.statistics.task_count < 1 ||
		projection.run.statistics.attempt_count < 2
	)
		return "INSUFFICIENT_SAMPLE";
	if (!projection.run.agents.length) return "INVALID_PROVENANCE";
	return "ELIGIBLE";
};

export class PublishingService {
	constructor(
		private readonly database: Database,
		private readonly cloud: CloudService,
		private readonly now = () => new Date(),
	) {}

	async publish(
		actor: Principal,
		input: {
			organizationId: string;
			runId: string;
			confirmPrivate?: boolean;
			methodologyVersion?: string;
		},
	): Promise<PublicRunProjection> {
		await this.cloud.authorize(
			actor,
			input.organizationId,
			"REPOSITORY_MANAGE",
		);
		if (actor.type !== "USER" && actor.type !== "API_KEY")
			throw new RepoArenaError(
				"FORBIDDEN",
				"User or scoped API-key authorization is required to publish.",
			);
		return this.database.transaction(async (client) => {
			const result = await client.query<{
				repository_id: string;
				repository_name: string;
				html_url: string | null;
				visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
				canonical_result: unknown;
				completed_at: Date;
				benchmark_version_id: string;
				config_hash: string;
				task_hashes: string[];
			}>(
				"SELECT br.repository_id,r.repository_name,r.html_url,r.visibility,br.canonical_result,br.completed_at,br.benchmark_version_id,bv.config_hash,ARRAY(SELECT tv.content_hash FROM benchmark_version_tasks bvt JOIN task_versions tv ON tv.id=bvt.task_version_id WHERE bvt.benchmark_version_id=br.benchmark_version_id ORDER BY bvt.ordinal) AS task_hashes FROM benchmark_runs br JOIN repositories r ON r.id=br.repository_id JOIN benchmark_versions bv ON bv.id=br.benchmark_version_id WHERE br.id=$1 AND br.organization_id=$2 AND br.state='COMPLETED' FOR UPDATE OF br",
				[input.runId, input.organizationId],
			);
			const run = result.rows[0];
			if (!run?.canonical_result || !run.completed_at)
				throw new RepoArenaError(
					"NOT_FOUND",
					"Completed benchmark run is unavailable.",
				);
			if (run.visibility !== "PUBLIC" && !input.confirmPrivate)
				throw new RepoArenaError(
					"FORBIDDEN",
					"Publishing a private repository requires explicit confirmation.",
				);
			publicResultSchema.parse(run.canonical_result);
			const publicId = `rap_${randomBytes(18).toString("base64url")}`;
			const publishedAt = this.now();
			const methodologyVersion =
				input.methodologyVersion ?? "repoarena.methodology/v1";
			const repositoryProjection = {
				name:
					run.visibility === "PUBLIC"
						? run.repository_name
						: "Private repository",
				url: run.visibility === "PUBLIC" ? run.html_url : null,
				visibility: run.visibility,
			};
			const parsed = publicResultSchema.parse(run.canonical_result);
			const runProjection = {
				id: input.runId,
				state: parsed.state,
				statistics: statisticsSchema.parse(parsed.statistics),
				agents: (parsed.agents ?? []).map((agent) => ({
					id: agent.id,
					model: agent.model ?? null,
				})),
				completed_at: run.completed_at.toISOString(),
				provenance: {
					benchmark_version_id: run.benchmark_version_id,
					configuration_hash: run.config_hash,
					task_set_hash: contentHash(run.task_hashes),
				},
			};
			const existing = await client.query<{ public_id: string }>(
				"SELECT public_id FROM public_run_publications WHERE benchmark_run_id=$1",
				[input.runId],
			);
			const effectiveId = existing.rows[0]?.public_id ?? publicId;
			const publisherId = actor.type === "USER" ? actor.userId : actor.apiKeyId;
			await client.query(
				"INSERT INTO public_run_publications(id,public_id,organization_id,repository_id,benchmark_run_id,state,repository_projection,run_projection,methodology_version,publisher_type,publisher_id,private_repository_confirmed,published_at) VALUES($1,$2,$3,$4,$5,'PUBLISHED',$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(benchmark_run_id) DO UPDATE SET state='PUBLISHED',repository_projection=excluded.repository_projection,run_projection=excluded.run_projection,methodology_version=excluded.methodology_version,publisher_type=excluded.publisher_type,publisher_id=excluded.publisher_id,private_repository_confirmed=excluded.private_repository_confirmed,published_at=excluded.published_at,unpublished_at=NULL,updated_at=now()",
				[
					randomUUID(),
					effectiveId,
					input.organizationId,
					run.repository_id,
					input.runId,
					repositoryProjection,
					runProjection,
					methodologyVersion,
					actor.type,
					publisherId,
					Boolean(input.confirmPrivate),
					publishedAt,
				],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'run.published','benchmark_run',$5,$6)",
				[
					randomUUID(),
					input.organizationId,
					actor.type,
					publisherId,
					input.runId,
					{ public_id: effectiveId },
				],
			);
			return {
				public_id: effectiveId,
				repository: repositoryProjection,
				run: runProjection,
				methodology_version: methodologyVersion,
				published_at: publishedAt.toISOString(),
			};
		});
	}

	async unpublish(
		actor: Principal,
		organizationId: string,
		publicId: string,
	): Promise<void> {
		await this.cloud.authorize(actor, organizationId, "REPOSITORY_MANAGE");
		const changed = await this.database.query(
			"UPDATE public_run_publications SET state='UNPUBLISHED',unpublished_at=$3,updated_at=$3 WHERE public_id=$1 AND organization_id=$2 AND state='PUBLISHED'",
			[publicId, organizationId, this.now()],
		);
		if (!changed.rowCount)
			throw new RepoArenaError("NOT_FOUND", "Published run is unavailable.");
	}

	async getPublic(publicId: string): Promise<PublicRunProjection> {
		const result = await this.database.query<{
			public_id: string;
			repository_projection: unknown;
			run_projection: unknown;
			published_at: Date;
			methodology_version: string;
		}>(
			"SELECT public_id,repository_projection,run_projection,published_at,methodology_version FROM public_run_publications WHERE public_id=$1 AND state='PUBLISHED'",
			[publicId],
		);
		const row = result.rows[0];
		if (!row)
			throw new RepoArenaError("NOT_FOUND", "Published run is unavailable.");
		return storedProjection(row);
	}

	async leaderboard(limit = 50): Promise<{
		entries: readonly (PublicRunProjection & {
			eligibility: LeaderboardEligibility;
		})[];
	}> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Leaderboard limit is invalid.",
			);
		const rows = await this.database.query<{
			public_id: string;
			repository_projection: unknown;
			run_projection: unknown;
			published_at: Date;
			methodology_version: string;
		}>(
			"SELECT public_id,repository_projection,run_projection,published_at,methodology_version FROM public_run_publications WHERE state='PUBLISHED' ORDER BY published_at DESC,public_id LIMIT $1",
			[limit],
		);
		let entries = rows.rows.map((row) => {
			const projection = storedProjection(row);
			return { ...projection, eligibility: eligibility(projection) };
		});
		const comparableTaskSets = new Set(
			entries
				.filter((entry) => entry.eligibility === "ELIGIBLE")
				.map((entry) => entry.run.provenance.task_set_hash),
		);
		if (comparableTaskSets.size > 1)
			entries = entries.map((entry) =>
				entry.eligibility === "ELIGIBLE"
					? { ...entry, eligibility: "INCOMPARABLE_TASK_SET" as const }
					: entry,
			);
		entries = entries.sort(
			(a, b) =>
				(b.run.statistics.success_rate ?? -1) -
					(a.run.statistics.success_rate ?? -1) ||
				a.public_id.localeCompare(b.public_id),
		);
		return { entries };
	}

	async badge(publicId: string): Promise<string> {
		const projection = await this.getPublic(publicId);
		const rate = projection.run.statistics.success_rate;
		const message =
			rate === null ? "unknown" : `${Math.round(rate * 100)}% solved`;
		const escape = (value: string) =>
			value
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll('"', "&quot;");
		return `<svg xmlns="http://www.w3.org/2000/svg" width="162" height="20" role="img" aria-label="RepoArena: ${escape(message)}"><title>RepoArena: ${escape(message)}</title><rect width="162" height="20" rx="3" fill="#14231f"/><text x="8" y="14" fill="#eef9f3" font-family="Verdana,sans-serif" font-size="11">RepoArena · ${escape(message)}</text></svg>`;
	}
}
