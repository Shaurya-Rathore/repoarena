import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	assertPublicResult,
	type CloudService,
	type Principal,
} from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { contentHash, RepoArenaError } from "@repoarena/core";
import {
	createRemoteJWKSet,
	decodeJwt,
	jwtVerify,
	type JWTPayload,
} from "jose";

export type OidcClaims = JWTPayload &
	Readonly<{
		repository_id?: string;
		repository?: string;
		ref?: string;
		job_workflow_ref?: string;
	}>;
export interface OidcVerifier {
	verify(token: string, audience: string): Promise<OidcClaims>;
}
export class GitHubOidcVerifier implements OidcVerifier {
	private readonly keys;
	constructor(
		jwksUrl = new URL(
			"https://token.actions.githubusercontent.com/.well-known/jwks",
		),
		private readonly now = () => new Date(),
	) {
		this.keys = createRemoteJWKSet(jwksUrl);
	}
	async verify(tokenValue: string, audience: string): Promise<OidcClaims> {
		const verified = await jwtVerify(tokenValue, this.keys, {
			issuer: "https://token.actions.githubusercontent.com",
			audience,
			currentDate: this.now(),
			clockTolerance: 30,
		});
		return verified.payload as OidcClaims;
	}
}

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const match = (value: string, pattern: string) => {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\0")
		.replaceAll("*", "[^/]*")
		.replaceAll("\0", ".*");
	return new RegExp(`^${escaped}$`).test(value);
};

export class GitHubActionsAuth {
	constructor(
		private readonly database: Database,
		private readonly cloud: CloudService,
		private readonly verifier: OidcVerifier,
		private readonly now: () => Date = () => new Date(),
	) {}
	async createTrust(
		actor: Principal,
		input: {
			organizationId: string;
			repositoryId: string;
			githubRepositoryId: string;
			audience: string;
			allowedRefs: readonly string[];
			workflowPattern?: string;
		},
	): Promise<string> {
		await this.cloud.authorize(actor, input.organizationId, "ORG_MANAGE");
		const ownership = await this.database.query(
			"SELECT 1 FROM repositories WHERE id=$1 AND organization_id=$2 AND provider='github' AND external_id=$3",
			[input.repositoryId, input.organizationId, input.githubRepositoryId],
		);
		if (!ownership.rowCount)
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub OIDC repository identity is unavailable.",
			);
		if (actor.type !== "USER")
			throw new RepoArenaError("FORBIDDEN", "User authorization required.");
		const id = randomUUID();
		await this.database.query(
			"INSERT INTO github_oidc_trusts(id,organization_id,repository_id,github_repository_id,audience,allowed_refs,workflow_pattern,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,github_repository_id,audience) DO UPDATE SET allowed_refs=excluded.allowed_refs,workflow_pattern=excluded.workflow_pattern,enabled=true,updated_at=now()",
			[
				id,
				input.organizationId,
				input.repositoryId,
				input.githubRepositoryId,
				input.audience,
				input.allowedRefs,
				input.workflowPattern ?? null,
				actor.userId,
			],
		);
		return id;
	}
	async exchange(
		tokenValue: string,
		audience: string,
	): Promise<{
		token: string;
		expiresAt: string;
		organizationId: string;
		repositoryId: string;
	}> {
		let untrusted: OidcClaims;
		try {
			untrusted = decodeJwt(tokenValue) as OidcClaims;
		} catch {
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions OIDC token is invalid.",
			);
		}
		if (typeof untrusted.repository_id !== "string")
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions repository identity is missing.",
			);
		const trust = await this.database.query<{
			id: string;
			organization_id: string;
			repository_id: string;
			issuer: string;
			allowed_refs: string[];
			workflow_pattern: string | null;
		}>(
			"SELECT id,organization_id,repository_id,issuer,allowed_refs,workflow_pattern FROM github_oidc_trusts WHERE github_repository_id=$1 AND audience=$2 AND enabled",
			[untrusted.repository_id, audience],
		);
		const row = trust.rows[0];
		if (!row)
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions trust is unavailable.",
			);
		let claims: OidcClaims;
		try {
			claims = await this.verifier.verify(tokenValue, audience);
		} catch {
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions OIDC verification failed.",
			);
		}
		if (
			claims.iss !== row.issuer ||
			claims.repository_id !== untrusted.repository_id ||
			typeof claims.jti !== "string" ||
			typeof claims.exp !== "number" ||
			typeof claims.iat !== "number"
		)
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions OIDC claims are invalid.",
			);
		const expiresAtSeconds = claims.exp;
		const nowSeconds = Math.floor(this.now().getTime() / 1_000);
		if (
			claims.exp <= nowSeconds ||
			claims.iat > nowSeconds + 30 ||
			nowSeconds - claims.iat > 600
		)
			throw new RepoArenaError(
				"AUTH_UNAVAILABLE",
				"GitHub Actions OIDC token is expired or stale.",
			);
		if (
			row.allowed_refs.length &&
			(typeof claims.ref !== "string" ||
				!row.allowed_refs.some((pattern) => match(claims.ref ?? "", pattern)))
		)
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub Actions ref is not trusted.",
			);
		if (
			row.workflow_pattern &&
			(typeof claims.job_workflow_ref !== "string" ||
				!match(claims.job_workflow_ref, row.workflow_pattern))
		)
			throw new RepoArenaError(
				"FORBIDDEN",
				"GitHub Actions workflow is not trusted.",
			);
		const plaintext = `raa_${randomBytes(32).toString("base64url")}`;
		const expiresAt = new Date(
			Math.min(expiresAtSeconds * 1_000, this.now().getTime() + 15 * 60_000),
		).toISOString();
		await this.database.transaction(async (client) => {
			try {
				await client.query(
					"INSERT INTO github_oidc_replays(issuer,token_id,expires_at) VALUES($1,$2,$3)",
					[row.issuer, claims.jti, new Date(expiresAtSeconds * 1_000)],
				);
			} catch (error) {
				if ((error as { code?: string }).code === "23505")
					throw new RepoArenaError(
						"CONFLICT",
						"GitHub Actions OIDC token was already used.",
					);
				throw error;
			}
			await client.query(
				"INSERT INTO github_action_credentials(id,organization_id,repository_id,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
				[
					randomUUID(),
					row.organization_id,
					row.repository_id,
					digest(plaintext),
					["run:write"],
					expiresAt,
				],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,action,target_type,target_id,metadata) VALUES($1,$2,'SYSTEM','github.action_credential_issued','repository',$3,$4)",
				[
					randomUUID(),
					row.organization_id,
					row.repository_id,
					{ oidc_trust_id: row.id, ref: claims.ref ?? null },
				],
			);
		});
		return {
			token: plaintext,
			expiresAt,
			organizationId: row.organization_id,
			repositoryId: row.repository_id,
		};
	}
	async submitResult(
		tokenValue: string,
		runId: string,
		result: unknown,
	): Promise<{ replay: boolean }> {
		assertPublicResult(result);
		const resultHash = contentHash(result);
		return this.database.transaction(async (client) => {
			const credential = await client.query<{
				organization_id: string;
				repository_id: string;
			}>(
				"SELECT organization_id,repository_id FROM github_action_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>$2 AND 'run:write'=ANY(scopes)",
				[digest(tokenValue), this.now()],
			);
			const auth = credential.rows[0];
			if (!auth)
				throw new RepoArenaError(
					"AUTH_UNAVAILABLE",
					"GitHub Action credential is invalid.",
				);
			const run = await client.query<{
				state: string;
				result_hash: string | null;
			}>(
				"SELECT state,result_hash FROM benchmark_runs WHERE id=$1 AND organization_id=$2 AND repository_id=$3 FOR UPDATE",
				[runId, auth.organization_id, auth.repository_id],
			);
			const row = run.rows[0];
			if (!row)
				throw new RepoArenaError(
					"FORBIDDEN",
					"GitHub Action run is unavailable.",
				);
			if (row.state === "COMPLETED") {
				if (row.result_hash !== resultHash)
					throw new RepoArenaError(
						"CONFLICT",
						"GitHub Action result replay conflicts.",
					);
				return { replay: true };
			}
			if (!["QUEUED", "RUNNING"].includes(row.state))
				throw new RepoArenaError(
					"CONFLICT",
					"GitHub Action run cannot accept a result.",
				);
			await client.query(
				"UPDATE benchmark_runs SET state='COMPLETED',canonical_result=$2,result_hash=$3,completed_at=$4,updated_at=$4 WHERE id=$1",
				[runId, result, resultHash, this.now()],
			);
			await client.query(
				"UPDATE jobs SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,completed_at=$2,updated_at=$2 WHERE benchmark_run_id=$1 AND state IN ('QUEUED','LEASED')",
				[runId, this.now()],
			);
			return { replay: false };
		});
	}
}
