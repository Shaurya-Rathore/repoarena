import { randomBytes, randomUUID } from "node:crypto";
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import type { BillingService } from "@repoarena/billing";
import {
	ArtifactService,
	CloudService,
	type Permission,
	type Principal,
} from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { RepoArenaError } from "@repoarena/core";
import type {
	GitHubActionsAuth,
	GitHubIntegration,
	TriggerPolicy,
} from "@repoarena/github-integration";
import type { ObjectStorage } from "@repoarena/object-storage";
import { PublishingService } from "@repoarena/public-publishing";
import { z } from "zod";

export const cloudApiContract = Object.freeze({
	openapi: "3.1.0",
	info: { title: "RepoArena Cloud API", version: "v1" },
	paths: {
		"/api/v1/organizations": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/repositories": {
			get: {},
			post: {},
		},
		"/api/v1/organizations/{organizationId}/tasks": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/benchmarks": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/runs": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/schedules": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/schedules/{scheduleId}": {
			put: {},
			delete: {},
		},
		"/api/v1/organizations/{organizationId}/runners": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/api-keys": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/audit-events": { get: {} },
		"/api/v1/organizations/{organizationId}/usage": { get: {} },
		"/api/v1/organizations/{organizationId}/billing": { get: {} },
		"/api/v1/organizations/{organizationId}/billing/checkout": { post: {} },
		"/api/v1/organizations/{organizationId}/billing/portal": { post: {} },
		"/api/v1/organizations/{organizationId}/billing/subscription": { put: {} },
		"/api/v1/billing/stripe/webhooks": { post: {} },
		"/api/v1/organizations/{organizationId}/readiness": { get: {}, post: {} },
		"/api/v1/organizations/{organizationId}/optimizations": {
			get: {},
			post: {},
		},
		"/api/v1/runner/jobs/claim": { post: {} },
		"/api/v1/runner/jobs/{jobId}/result": { post: {} },
		"/api/v1/github/webhooks": { post: {} },
		"/api/v1/github/actions/oidc/exchange": { post: {} },
		"/api/v1/github/actions/runs/{runId}/result": { post: {} },
		"/api/v1/organizations/{organizationId}/github/installations": {
			get: {},
			post: {},
		},
		"/api/v1/organizations/{organizationId}/repositories/{repositoryId}/github-policy":
			{
				put: {},
			},
		"/api/v1/organizations/{organizationId}/repositories/{repositoryId}/github-oidc-trusts":
			{
				post: {},
			},
		"/api/v1/organizations/{organizationId}/runs/{runId}/publish": { post: {} },
		"/api/v1/organizations/{organizationId}/publications/{publicId}": {
			delete: {},
		},
		"/api/v1/public/runs/{publicId}": { get: {} },
		"/api/v1/public/leaderboard": { get: {} },
		"/api/v1/public/badges/{publicId}.svg": { get: {} },
		"/api/v1/public/repositories/{repositoryPublicId}": { get: {} },
		"/api/v1/public/repositories/{repositoryPublicId}/badge.svg": { get: {} },
	},
});

export interface OAuthProvider {
	authorizationUrl(state: string): string;
	exchange(code: string): Promise<{
		provider: string;
		subject: string;
		displayName: string;
		email?: string;
	}>;
}
export class GitHubOAuthProvider implements OAuthProvider {
	constructor(
		private readonly clientId: string,
		private readonly clientSecret: string,
		private readonly callbackUrl: string,
	) {}
	authorizationUrl(state: string) {
		const value = new URL("https://github.com/login/oauth/authorize");
		value.searchParams.set("client_id", this.clientId);
		value.searchParams.set("redirect_uri", this.callbackUrl);
		value.searchParams.set("state", state);
		value.searchParams.set("scope", "read:user user:email");
		return value.toString();
	}
	async exchange(code: string) {
		const tokenResponse = await fetch(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					code,
					redirect_uri: this.callbackUrl,
				}),
			},
		);
		const token = (await tokenResponse.json()) as { access_token?: string };
		if (!token.access_token) throw new Error("OAuth token exchange failed");
		const profileResponse = await fetch("https://api.github.com/user", {
			headers: {
				authorization: `Bearer ${token.access_token}`,
				accept: "application/vnd.github+json",
				"user-agent": "RepoArena",
			},
		});
		const profile = (await profileResponse.json()) as {
			id?: number;
			login?: string;
			name?: string;
			email?: string;
		};
		if (!profile.id || !profile.login)
			throw new Error("OAuth profile lookup failed");
		return {
			provider: "github",
			subject: String(profile.id),
			displayName: profile.name ?? profile.login,
			...(profile.email ? { email: profile.email } : {}),
		};
	}
}

const uuid = z.string().uuid();
const bodySchemas = {
	organization: z
		.object({
			slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
			display_name: z.string().min(1).max(200),
		})
		.strict(),
	repository: z
		.object({
			provider: z.string().min(1).max(40),
			external_id: z.string().max(200).optional(),
			owner: z.string().min(1).max(200),
			name: z.string().min(1).max(200),
			default_branch: z.string().min(1).max(200),
			visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
		})
		.strict(),
	run: z
		.object({
			repository_id: uuid,
			benchmark_version_id: uuid,
			budget: z
				.object({
					max_attempts: z.number().int().positive().max(10_000).optional(),
					max_cost_micros: z.number().int().positive().optional(),
					max_runtime_ms: z.number().int().positive().optional(),
				})
				.strict()
				.default({}),
		})
		.strict(),
	runner: z
		.object({
			name: z.string().min(1).max(100),
			capabilities: z.record(z.unknown()),
			software_version: z.string().min(1).max(100),
		})
		.strict(),
	apiKey: z
		.object({
			name: z.string().min(1).max(100),
			scopes: z.array(
				z.enum([
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
			),
			expires_at: z.string().datetime().optional(),
		})
		.strict(),
	task: z
		.object({
			repository_id: uuid,
			task_key: z.string().min(1).max(200),
			title: z.string().min(1).max(500),
			public_task: z.unknown(),
			validation_state: z.string().min(1).max(100),
		})
		.strict(),
	benchmark: z
		.object({
			repository_id: uuid,
			name: z.string().min(1).max(200),
			configuration: z.unknown(),
			task_version_ids: z.array(uuid).min(1).max(10_000),
		})
		.strict(),
	membership: z
		.object({
			user_id: uuid,
			role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
			state: z.enum(["ACTIVE", "REVOKED"]).default("ACTIVE"),
		})
		.strict(),
	schedule: z
		.object({
			benchmark_version_id: uuid,
			cadence: z.enum(["HOURLY", "DAILY", "WEEKLY"]),
			next_run_at: z.string().datetime(),
		})
		.strict(),
	scheduleUpdate: z
		.object({
			enabled: z.boolean(),
			next_run_at: z.string().datetime().optional(),
		})
		.strict(),
	readiness: z
		.object({
			repository_id: uuid,
			report: z
				.object({
					schema: z.literal("repoarena.readiness/v1"),
					id: uuid,
					score: z.number().int().min(0).max(100),
					status: z.enum(["READY", "NEEDS_ATTENTION", "BLOCKED"]),
					dimensions: z.array(z.unknown()),
					findings: z.array(z.unknown()),
				})
				.passthrough(),
		})
		.strict(),
	optimization: z
		.object({
			repository_id: uuid,
			result: z
				.object({
					schema: z.literal("repoarena.optimization-run/v1"),
					id: uuid,
					status: z.enum([
						"COMPLETED",
						"CANCELLED",
						"BUDGET_EXHAUSTED",
						"NO_VALID_CANDIDATES",
					]),
					trials: z.array(z.unknown()),
					pareto_candidate_ids: z.array(z.string()),
					recommendation: z.unknown().nullable(),
				})
				.passthrough(),
		})
		.strict(),
	githubInstallation: z
		.object({
			id: z.number().int().positive(),
			account: z.object({
				id: z.number().int().positive(),
				login: z.string().min(1),
				type: z.enum(["User", "Organization", "Enterprise", "Bot"]),
			}),
			permissions: z.record(z.string()),
			repository_selection: z.enum(["all", "selected"]),
		})
		.strict(),
	githubPolicy: z
		.object({
			benchmark_version_id: uuid,
			policy: z
				.object({
					pushDefaultBranch: z.boolean(),
					pullRequests: z.boolean(),
					includeDrafts: z.boolean(),
					forkPolicy: z.enum(["SKIP", "UNPRIVILEGED"]),
					branches: z.array(z.string().min(1).max(200)).max(100).optional(),
					paths: z.array(z.string().min(1).max(500)).max(200).optional(),
					budget: z
						.object({
							max_attempts: z.number().int().min(1).max(100),
							max_cost_micros: z.number().int().positive().optional(),
							max_runtime_ms: z.number().int().positive().optional(),
						})
						.strict(),
				})
				.strict(),
		})
		.strict(),
	githubOidcTrust: z
		.object({
			github_repository_id: z.string().regex(/^\d+$/),
			audience: z.string().min(1).max(200),
			allowed_refs: z.array(z.string().min(1).max(500)).max(100),
			workflow_pattern: z.string().min(1).max(500).optional(),
		})
		.strict(),
	oidcExchange: z
		.object({
			token: z.string().min(20).max(20_000),
			audience: z.string().min(1).max(200),
		})
		.strict(),
	publish: z
		.object({
			confirm_private: z.boolean().optional(),
			methodology_version: z.string().min(1).max(100).optional(),
		})
		.strict(),
	billingCheckout: z
		.object({
			plan: z.enum(["PRO", "TEAM"]),
			interval: z.enum(["MONTHLY", "YEARLY"]),
		})
		.strict(),
	billingSubscription: z
		.object({
			plan: z.enum(["PRO", "TEAM"]).optional(),
			interval: z.enum(["MONTHLY", "YEARLY"]).optional(),
			cancel_at_period_end: z.boolean().optional(),
		})
		.strict(),
	result: z.object({ result: z.unknown() }).strict(),
};
const parseCookies = (request: IncomingMessage) =>
	Object.fromEntries(
		(request.headers.cookie ?? "")
			.split(";")
			.map((part) => part.trim().split("="))
			.filter((parts): parts is [string, string] => parts.length === 2),
	);
const readBody = async (request: IncomingMessage) => {
	let body = "";
	for await (const chunk of request) {
		body += String(chunk);
		if (body.length > 1_000_000)
			throw new RepoArenaError("CONFIG_INVALID", "Request body is too large.");
	}
	try {
		return JSON.parse(body || "null") as unknown;
	} catch {
		throw new RepoArenaError("CONFIG_INVALID", "Malformed JSON.");
	}
};
const readRawBody = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > 1_000_000)
			throw new RepoArenaError("CONFIG_INVALID", "Request body is too large.");
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
};
const decodeCursor = (value: string | null) => {
	if (!value) return undefined;
	try {
		return z
			.object({ createdAt: z.string().datetime(), id: uuid })
			.strict()
			.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
	} catch {
		throw new RepoArenaError("CONFIG_INVALID", "Cursor is invalid.");
	}
};
const json = (
	response: ServerResponse,
	status: number,
	value: unknown,
	requestId: string,
) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	if (!response.hasHeader("cache-control"))
		response.setHeader("cache-control", "no-store");
	response.setHeader("x-request-id", requestId);
	response.end(`${JSON.stringify(value)}\n`);
};

export function createCloudApi(options: {
	database: Database;
	storage: ObjectStorage;
	oauth?: OAuthProvider;
	publicOrigin: string;
	now?: () => Date;
	logger?: (event: Readonly<Record<string, unknown>>) => void;
	github?: GitHubIntegration;
	githubActions?: GitHubActionsAuth;
	billing?: BillingService;
}) {
	const cloud = new CloudService(options.database, options.now);
	const publishing = new PublishingService(
		options.database,
		cloud,
		options.now,
	);
	const artifacts = new ArtifactService(
		options.database,
		options.storage,
		cloud,
	);
	const oauthStates = new Map<string, number>();
	const authenticate = async (
		request: IncomingMessage,
		mutation = false,
	): Promise<Principal> => {
		const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
		if (bearer?.startsWith("rak_")) return cloud.authenticateApiKey(bearer);
		if (bearer?.startsWith("rar_")) return cloud.authenticateRunner(bearer);
		const session = parseCookies(request).repoarena_session;
		if (!session)
			throw new RepoArenaError("AUTH_UNAVAILABLE", "Authentication required.");
		if (
			mutation &&
			(request.headers.origin !== options.publicOrigin ||
				typeof request.headers["x-csrf-token"] !== "string")
		)
			throw new RepoArenaError(
				"FORBIDDEN",
				"Origin or CSRF validation failed.",
			);
		return cloud.authenticateSession(
			session,
			mutation ? (request.headers["x-csrf-token"] as string) : undefined,
		);
	};
	const server = createServer(async (request, response) => {
		const requestId =
			request.headers["x-request-id"]?.toString().slice(0, 100) || randomUUID();
		const started = performance.now();
		response.setHeader("x-content-type-options", "nosniff");
		try {
			const url = new URL(request.url ?? "/", options.publicOrigin);
			const path = url.pathname;
			if (request.method === "GET" && path === "/health/live")
				return json(response, 200, { status: "ok" }, requestId);
			if (request.method === "GET" && path === "/api/v1/openapi.json")
				return json(response, 200, cloudApiContract, requestId);
			if (request.method === "GET" && path.startsWith("/api/v1/public/")) {
				const rate = await cloud.consumeRateLimit(
					`public:${request.socket.remoteAddress ?? "unknown"}`,
					120,
					60_000,
				);
				response.setHeader("x-ratelimit-remaining", String(rate.remaining));
				if (!rate.allowed)
					throw new RepoArenaError(
						"RATE_LIMITED",
						"Public request limit exceeded.",
					);
			}
			if (request.method === "GET" && path === "/api/v1/public/leaderboard") {
				response.setHeader(
					"cache-control",
					"public, max-age=60, stale-while-revalidate=300",
				);
				return json(
					response,
					200,
					{
						data: await publishing.leaderboard(
							Number(url.searchParams.get("limit") ?? 50),
						),
					},
					requestId,
				);
			}
			const publicRun = path.match(
				/^\/api\/v1\/public\/runs\/(rap_[A-Za-z0-9_-]+)$/,
			);
			if (request.method === "GET" && publicRun?.[1]) {
				response.setHeader(
					"cache-control",
					"public, max-age=60, stale-while-revalidate=300",
				);
				return json(
					response,
					200,
					{ data: await publishing.getPublic(publicRun[1]) },
					requestId,
				);
			}
			const publicBadge = path.match(
				/^\/api\/v1\/public\/badges\/(rap_[A-Za-z0-9_-]+)\.svg$/,
			);
			if (request.method === "GET" && publicBadge?.[1]) {
				response.statusCode = 200;
				response.setHeader("content-type", "image/svg+xml; charset=utf-8");
				response.setHeader(
					"cache-control",
					"public, max-age=300, stale-while-revalidate=3600",
				);
				response.setHeader("x-request-id", requestId);
				return response.end(await publishing.badge(publicBadge[1]));
			}
			const publicRepository = path.match(
				/^\/api\/v1\/public\/repositories\/(rar_[A-Za-z0-9_-]+)$/,
			);
			if (request.method === "GET" && publicRepository?.[1]) {
				response.setHeader(
					"cache-control",
					"public, max-age=60, stale-while-revalidate=300",
				);
				return json(
					response,
					200,
					{ data: await publishing.latestRepository(publicRepository[1]) },
					requestId,
				);
			}
			const repositoryBadge = path.match(
				/^\/api\/v1\/public\/repositories\/(rar_[A-Za-z0-9_-]+)\/badge\.svg$/,
			);
			if (request.method === "GET" && repositoryBadge?.[1]) {
				response.statusCode = 200;
				response.setHeader("content-type", "image/svg+xml; charset=utf-8");
				response.setHeader(
					"cache-control",
					"public, max-age=300, stale-while-revalidate=3600",
				);
				return response.end(
					await publishing.repositoryBadge(repositoryBadge[1]),
				);
			}
			if (
				request.method === "POST" &&
				path === "/api/v1/billing/stripe/webhooks"
			) {
				if (!options.billing)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing integration is unavailable.",
					);
				if (
					!(request.headers["content-type"] ?? "")
						.toString()
						.startsWith("application/json")
				)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing webhook content type is invalid.",
					);
				const signature = request.headers["stripe-signature"];
				if (typeof signature !== "string")
					throw new RepoArenaError(
						"FORBIDDEN",
						"Billing webhook signature is required.",
					);
				const result = await options.billing.ingest(
					await readRawBody(request),
					signature,
				);
				return json(
					response,
					result.duplicate ? 200 : 202,
					{ data: result },
					requestId,
				);
			}
			if (request.method === "POST" && path === "/api/v1/github/webhooks") {
				if (!options.github)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub integration is unavailable.",
					);
				if (
					!(request.headers["content-type"] ?? "")
						.toString()
						.startsWith("application/json")
				)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub webhook content type is invalid.",
					);
				const result = await options.github.ingest(await readRawBody(request), {
					...(typeof request.headers["x-hub-signature-256"] === "string"
						? { signature: request.headers["x-hub-signature-256"] }
						: {}),
					...(typeof request.headers["x-github-event"] === "string"
						? { event: request.headers["x-github-event"] }
						: {}),
					...(typeof request.headers["x-github-delivery"] === "string"
						? { delivery: request.headers["x-github-delivery"] }
						: {}),
				});
				return json(
					response,
					result.duplicate ? 200 : 202,
					{ data: result },
					requestId,
				);
			}
			if (
				request.method === "POST" &&
				path === "/api/v1/github/actions/oidc/exchange"
			) {
				if (!options.githubActions)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub Actions OIDC is unavailable.",
					);
				const body = bodySchemas.oidcExchange.parse(await readBody(request));
				return json(
					response,
					200,
					{
						data: await options.githubActions.exchange(
							body.token,
							body.audience,
						),
					},
					requestId,
				);
			}
			if (request.method === "GET" && path === "/health/ready") {
				const database = await options.database
					.query("SELECT 1")
					.then(() => "ok")
					.catch(() => "unavailable");
				const migrations = await options.database
					.query<{ count: string }>(
						"SELECT count(*)::text AS count FROM schema_migrations",
					)
					.then((value) => Number(value.rows[0]?.count ?? 0))
					.catch(() => 0);
				return json(
					response,
					database === "ok" && migrations > 0 ? 200 : 503,
					{
						status: database === "ok" && migrations > 0 ? "ready" : "not_ready",
						dependencies: {
							database,
							migrations,
							object_storage: "configured",
						},
					},
					requestId,
				);
			}
			if (request.method === "GET" && path === "/auth/login") {
				if (
					!(
						await cloud.consumeRateLimit(
							`auth:${request.socket.remoteAddress}`,
							20,
							60_000,
						)
					).allowed
				)
					throw new RepoArenaError(
						"RATE_LIMITED",
						"Too many authentication requests.",
					);
				if (!options.oauth)
					throw new RepoArenaError("CONFIG_INVALID", "OAuth is unavailable.");
				const state = randomBytes(24).toString("base64url");
				oauthStates.set(state, Date.now() + 600_000);
				response.statusCode = 302;
				response.setHeader("location", options.oauth.authorizationUrl(state));
				response.end();
				return;
			}
			if (request.method === "POST" && path === "/api/v1/logout") {
				await authenticate(request, true);
				const session = parseCookies(request).repoarena_session;
				if (session) await cloud.revokeSession(session);
				response.setHeader(
					"set-cookie",
					"repoarena_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
				);
				return json(response, 200, { data: { revoked: true } }, requestId);
			}
			if (request.method === "GET" && path === "/auth/callback") {
				if (!options.oauth)
					throw new RepoArenaError("CONFIG_INVALID", "OAuth is unavailable.");
				const state = url.searchParams.get("state") ?? "";
				const expiry = oauthStates.get(state);
				oauthStates.delete(state);
				if (!expiry || expiry < Date.now())
					throw new RepoArenaError("FORBIDDEN", "OAuth state is invalid.");
				const profile = await options.oauth.exchange(
					url.searchParams.get("code") ?? "",
				);
				const userId = await cloud.createUser(profile);
				const session = await cloud.createSession(userId);
				response.setHeader("set-cookie", [
					`repoarena_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Secure`,
					`repoarena_csrf=${session.csrf}; Path=/; SameSite=Lax; Secure`,
				]);
				return json(
					response,
					200,
					{ data: { user_id: userId, expires_at: session.expiresAt } },
					requestId,
				);
			}
			if (!path.startsWith("/api/v1/"))
				return json(
					response,
					404,
					{
						error: {
							code: "NOT_FOUND",
							message: "Route not found.",
							request_id: requestId,
						},
					},
					requestId,
				);
			if (request.method === "GET" && path === "/api/v1/organizations") {
				const principal = await authenticate(request);
				if (principal.type !== "USER")
					throw new RepoArenaError("FORBIDDEN", "User session required.");
				return json(
					response,
					200,
					{ data: await cloud.listOrganizations(principal.userId) },
					requestId,
				);
			}
			if (request.method === "POST" && path === "/api/v1/organizations") {
				const principal = await authenticate(request, true);
				if (principal.type !== "USER")
					throw new RepoArenaError("FORBIDDEN", "User session required.");
				const body = bodySchemas.organization.parse(await readBody(request));
				const id = await cloud.createOrganization(
					principal.userId,
					body.slug,
					body.display_name,
				);
				return json(response, 201, { data: { id } }, requestId);
			}
			const repositories = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/repositories$/,
			);
			if (repositories?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listRepositories(
							await authenticate(request),
							uuid.parse(repositories[1]),
						),
					},
					requestId,
				);
			if (repositories?.[1] && request.method === "POST") {
				const principal = await authenticate(request, true);
				const organizationId = uuid.parse(repositories[1]);
				const body = bodySchemas.repository.parse(await readBody(request));
				const id = await cloud.createRepository(principal, {
					organizationId,
					provider: body.provider,
					...(body.external_id ? { externalId: body.external_id } : {}),
					owner: body.owner,
					name: body.name,
					defaultBranch: body.default_branch,
					visibility: body.visibility,
				});
				return json(response, 201, { data: { id } }, requestId);
			}
			const githubInstallation = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/github\/installations$/,
			);
			if (githubInstallation?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listGitHubInstallations(
							await authenticate(request),
							uuid.parse(githubInstallation[1]),
						),
					},
					requestId,
				);
			if (githubInstallation?.[1] && request.method === "POST") {
				if (!options.github)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub integration is unavailable.",
					);
				const body = bodySchemas.githubInstallation.parse(
					await readBody(request),
				);
				return json(
					response,
					201,
					{
						data: {
							id: await options.github.linkInstallation(
								await authenticate(request, true),
								uuid.parse(githubInstallation[1]),
								body,
							),
						},
					},
					requestId,
				);
			}
			const githubPolicy = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/repositories\/([^/]+)\/github-policy$/,
			);
			if (githubPolicy?.[1] && githubPolicy[2] && request.method === "PUT") {
				if (!options.github)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub integration is unavailable.",
					);
				const body = bodySchemas.githubPolicy.parse(await readBody(request));
				return json(
					response,
					200,
					{
						data: {
							id: await options.github.setTriggerPolicy(
								await authenticate(request, true),
								{
									organizationId: uuid.parse(githubPolicy[1]),
									repositoryId: uuid.parse(githubPolicy[2]),
									benchmarkVersionId: body.benchmark_version_id,
									policy: body.policy as TriggerPolicy,
								},
							),
						},
					},
					requestId,
				);
			}
			const githubTrust = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/repositories\/([^/]+)\/github-oidc-trusts$/,
			);
			if (githubTrust?.[1] && githubTrust[2] && request.method === "POST") {
				if (!options.githubActions)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub Actions OIDC is unavailable.",
					);
				const body = bodySchemas.githubOidcTrust.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: {
							id: await options.githubActions.createTrust(
								await authenticate(request, true),
								{
									organizationId: uuid.parse(githubTrust[1]),
									repositoryId: uuid.parse(githubTrust[2]),
									githubRepositoryId: body.github_repository_id,
									audience: body.audience,
									allowedRefs: body.allowed_refs,
									...(body.workflow_pattern
										? { workflowPattern: body.workflow_pattern }
										: {}),
								},
							),
						},
					},
					requestId,
				);
			}
			const memberships = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/memberships$/,
			);
			const billing = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/billing$/,
			);
			if (billing?.[1] && request.method === "GET") {
				if (!options.billing)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing integration is unavailable.",
					);
				return json(
					response,
					200,
					{
						data: await options.billing.getBilling(
							await authenticate(request),
							uuid.parse(billing[1]),
						),
					},
					requestId,
				);
			}
			const billingCheckout = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/billing\/checkout$/,
			);
			if (billingCheckout?.[1] && request.method === "POST") {
				if (!options.billing)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing integration is unavailable.",
					);
				const body = bodySchemas.billingCheckout.parse(await readBody(request));
				const operation = request.headers["idempotency-key"];
				if (typeof operation !== "string" || !operation)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Idempotency-Key is required.",
					);
				return json(
					response,
					201,
					{
						data: await options.billing.checkout(
							await authenticate(request, true),
							{
								organizationId: uuid.parse(billingCheckout[1]),
								plan: body.plan,
								interval: body.interval,
								successUrl: `${options.publicOrigin}/app#billing/success`,
								cancelUrl: `${options.publicOrigin}/app#billing/cancel`,
								idempotencyKey: operation.slice(0, 200),
							},
						),
					},
					requestId,
				);
			}
			const billingPortal = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/billing\/portal$/,
			);
			if (billingPortal?.[1] && request.method === "POST") {
				if (!options.billing)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing integration is unavailable.",
					);
				return json(
					response,
					201,
					{
						data: await options.billing.portal(
							await authenticate(request, true),
							uuid.parse(billingPortal[1]),
							`${options.publicOrigin}/app#billing`,
						),
					},
					requestId,
				);
			}
			const billingSubscription = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/billing\/subscription$/,
			);
			if (billingSubscription?.[1] && request.method === "PUT") {
				if (!options.billing)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Billing integration is unavailable.",
					);
				const body = bodySchemas.billingSubscription.parse(
					await readBody(request),
				);
				const operation = request.headers["idempotency-key"];
				if (typeof operation !== "string" || !operation)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Idempotency-Key is required.",
					);
				return json(
					response,
					200,
					{
						data: await options.billing.changeSubscription(
							await authenticate(request, true),
							uuid.parse(billingSubscription[1]),
							{
								...(body.plan ? { plan: body.plan } : {}),
								...(body.interval ? { interval: body.interval } : {}),
								...(body.cancel_at_period_end === undefined
									? {}
									: { cancelAtPeriodEnd: body.cancel_at_period_end }),
								idempotencyKey: operation.slice(0, 200),
							},
						),
					},
					requestId,
				);
			}
			const publishRun = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/runs\/([^/]+)\/publish$/,
			);
			if (publishRun?.[1] && publishRun[2] && request.method === "POST") {
				const body = bodySchemas.publish.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await publishing.publish(await authenticate(request, true), {
							organizationId: uuid.parse(publishRun[1]),
							runId: uuid.parse(publishRun[2]),
							...(body.confirm_private === undefined
								? {}
								: { confirmPrivate: body.confirm_private }),
							...(body.methodology_version
								? { methodologyVersion: body.methodology_version }
								: {}),
						}),
					},
					requestId,
				);
			}
			const unpublish = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/publications\/(rap_[A-Za-z0-9_-]+)$/,
			);
			if (unpublish?.[1] && unpublish[2] && request.method === "DELETE") {
				await publishing.unpublish(
					await authenticate(request, true),
					uuid.parse(unpublish[1]),
					unpublish[2],
				);
				return json(response, 200, { data: { unpublished: true } }, requestId);
			}
			if (memberships?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listMemberships(
							await authenticate(request),
							uuid.parse(memberships[1]),
						),
					},
					requestId,
				);
			if (memberships?.[1] && request.method === "PUT") {
				const body = bodySchemas.membership.parse(await readBody(request));
				await cloud.setMembership(
					await authenticate(request, true),
					uuid.parse(memberships[1]),
					body.user_id,
					body.role,
					body.state,
				);
				return json(response, 200, { data: { updated: true } }, requestId);
			}
			const tasks = path.match(/^\/api\/v1\/organizations\/([^/]+)\/tasks$/);
			const readiness = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/readiness$/,
			);
			if (readiness?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listReadiness(
							await authenticate(request),
							uuid.parse(readiness[1]),
							url.searchParams.get("repository_id")
								? uuid.parse(url.searchParams.get("repository_id"))
								: undefined,
						),
					},
					requestId,
				);
			if (readiness?.[1] && request.method === "POST") {
				const body = bodySchemas.readiness.parse(await readBody(request));
				await cloud.saveReadiness(await authenticate(request, true), {
					organizationId: uuid.parse(readiness[1]),
					repositoryId: body.repository_id,
					report: body.report,
				});
				return json(response, 201, { data: { id: body.report.id } }, requestId);
			}
			const optimizations = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/optimizations$/,
			);
			if (optimizations?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listOptimizations(
							await authenticate(request),
							uuid.parse(optimizations[1]),
							url.searchParams.get("repository_id")
								? uuid.parse(url.searchParams.get("repository_id"))
								: undefined,
						),
					},
					requestId,
				);
			if (optimizations?.[1] && request.method === "POST") {
				const body = bodySchemas.optimization.parse(await readBody(request));
				await cloud.saveOptimization(await authenticate(request, true), {
					organizationId: uuid.parse(optimizations[1]),
					repositoryId: body.repository_id,
					result: body.result,
				});
				return json(response, 201, { data: { id: body.result.id } }, requestId);
			}
			if (tasks?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listTasks(
							await authenticate(request),
							uuid.parse(tasks[1]),
						),
					},
					requestId,
				);
			if (tasks?.[1] && request.method === "POST") {
				const body = bodySchemas.task.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await cloud.createTaskVersion(
							await authenticate(request, true),
							{
								organizationId: uuid.parse(tasks[1]),
								repositoryId: body.repository_id,
								taskKey: body.task_key,
								title: body.title,
								publicTask: body.public_task,
								validationState: body.validation_state,
							},
						),
					},
					requestId,
				);
			}
			const task = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/tasks\/([^/]+)$/,
			);
			if (task?.[1] && task[2] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.getPublicTask(
							await authenticate(request),
							uuid.parse(task[1]),
							uuid.parse(task[2]),
						),
					},
					requestId,
				);
			const benchmarks = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/benchmarks$/,
			);
			if (benchmarks?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listBenchmarks(
							await authenticate(request),
							uuid.parse(benchmarks[1]),
						),
					},
					requestId,
				);
			if (benchmarks?.[1] && request.method === "POST") {
				const body = bodySchemas.benchmark.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await cloud.createBenchmark(
							await authenticate(request, true),
							{
								organizationId: uuid.parse(benchmarks[1]),
								repositoryId: body.repository_id,
								name: body.name,
								configuration: body.configuration,
								taskVersionIds: body.task_version_ids,
							},
						),
					},
					requestId,
				);
			}
			const schedules = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/schedules$/,
			);
			if (schedules?.[1] && request.method === "POST") {
				const body = bodySchemas.schedule.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: {
							id: await cloud.createSchedule(
								await authenticate(request, true),
								{
									organizationId: uuid.parse(schedules[1]),
									benchmarkVersionId: body.benchmark_version_id,
									cadence: body.cadence,
									nextRunAt: body.next_run_at,
								},
							),
						},
					},
					requestId,
				);
			}
			if (schedules?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listSchedules(
							await authenticate(request),
							uuid.parse(schedules[1]),
						),
					},
					requestId,
				);
			const schedule = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/schedules\/([^/]+)$/,
			);
			if (schedule?.[1] && schedule[2] && request.method === "PUT") {
				const body = bodySchemas.scheduleUpdate.parse(await readBody(request));
				await cloud.setSchedule(
					await authenticate(request, true),
					uuid.parse(schedule[1]),
					uuid.parse(schedule[2]),
					{
						enabled: body.enabled,
						...(body.next_run_at ? { nextRunAt: body.next_run_at } : {}),
					},
				);
				return json(response, 200, { data: { updated: true } }, requestId);
			}
			if (schedule?.[1] && schedule[2] && request.method === "DELETE") {
				await cloud.deleteSchedule(
					await authenticate(request, true),
					uuid.parse(schedule[1]),
					uuid.parse(schedule[2]),
				);
				return json(response, 200, { data: { deleted: true } }, requestId);
			}
			const runs = path.match(/^\/api\/v1\/organizations\/([^/]+)\/runs$/);
			if (runs?.[1] && request.method === "GET") {
				const organizationId = uuid.parse(runs[1]);
				const decoded = decodeCursor(url.searchParams.get("cursor"));
				const result = await cloud.listRuns(
					await authenticate(request),
					organizationId,
					decoded,
					Number(url.searchParams.get("limit") ?? 50),
				);
				return json(
					response,
					200,
					{
						data: {
							...result,
							next_cursor: result.next
								? Buffer.from(JSON.stringify(result.next)).toString("base64url")
								: null,
						},
					},
					requestId,
				);
			}
			if (runs?.[1] && request.method === "POST") {
				const principal = await authenticate(request, true);
				const organizationId = uuid.parse(runs[1]);
				const key = request.headers["idempotency-key"]?.toString();
				if (!key || key.length > 200)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"Idempotency-Key is required.",
					);
				const body = bodySchemas.run.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await cloud.createRun(principal, {
							organizationId,
							repositoryId: body.repository_id,
							benchmarkVersionId: body.benchmark_version_id,
							idempotencyKey: key,
							budget: body.budget,
						}),
					},
					requestId,
				);
			}
			const run = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/runs\/([^/]+)$/,
			);
			if (run?.[1] && run[2] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.getRun(
							await authenticate(request),
							uuid.parse(run[1]),
							uuid.parse(run[2]),
						),
					},
					requestId,
				);
			if (run?.[1] && run[2] && request.method === "DELETE") {
				await cloud.cancelRun(
					await authenticate(request, true),
					uuid.parse(run[1]),
					uuid.parse(run[2]),
				);
				return json(response, 200, { data: { cancelled: true } }, requestId);
			}
			const keys = path.match(/^\/api\/v1\/organizations\/([^/]+)\/api-keys$/);
			if (keys?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listApiKeys(
							await authenticate(request),
							uuid.parse(keys[1]),
						),
					},
					requestId,
				);
			if (keys?.[1] && request.method === "POST") {
				const principal = await authenticate(request, true);
				if (principal.type !== "USER")
					throw new RepoArenaError("FORBIDDEN", "User session required.");
				const body = bodySchemas.apiKey.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await cloud.createApiKey(
							principal,
							uuid.parse(keys[1]),
							principal.userId,
							body.name,
							body.scopes as Permission[],
							body.expires_at,
						),
					},
					requestId,
				);
			}
			const revokeKey = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/api-keys\/([^/]+)$/,
			);
			if (revokeKey?.[1] && revokeKey[2] && request.method === "DELETE") {
				await cloud.revokeApiKey(
					await authenticate(request, true),
					uuid.parse(revokeKey[1]),
					uuid.parse(revokeKey[2]),
				);
				return json(response, 200, { data: { revoked: true } }, requestId);
			}
			const runners = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/runners$/,
			);
			if (runners?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listRunners(
							await authenticate(request),
							uuid.parse(runners[1]),
						),
					},
					requestId,
				);
			if (runners?.[1] && request.method === "POST") {
				const principal = await authenticate(request, true);
				const body = bodySchemas.runner.parse(await readBody(request));
				return json(
					response,
					201,
					{
						data: await cloud.registerRunner(
							principal,
							uuid.parse(runners[1]),
							body.name,
							body.capabilities,
							body.software_version,
						),
					},
					requestId,
				);
			}
			const revokeRunner = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/runners\/([^/]+)$/,
			);
			if (revokeRunner?.[1] && revokeRunner[2] && request.method === "DELETE") {
				await cloud.revokeRunner(
					await authenticate(request, true),
					uuid.parse(revokeRunner[1]),
					uuid.parse(revokeRunner[2]),
				);
				return json(response, 200, { data: { revoked: true } }, requestId);
			}
			const auditEvents = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/audit-events$/,
			);
			if (auditEvents?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listAuditEvents(
							await authenticate(request),
							uuid.parse(auditEvents[1]),
							Number(url.searchParams.get("limit") ?? 50),
						),
					},
					requestId,
				);
			const usage = path.match(/^\/api\/v1\/organizations\/([^/]+)\/usage$/);
			if (usage?.[1] && request.method === "GET")
				return json(
					response,
					200,
					{
						data: await cloud.listUsage(
							await authenticate(request),
							uuid.parse(usage[1]),
						),
					},
					requestId,
				);
			if (request.method === "POST" && path === "/api/v1/runner/heartbeat") {
				const principal = await authenticate(request, true);
				if (principal.type !== "RUNNER")
					throw new RepoArenaError(
						"FORBIDDEN",
						"Runner authentication required.",
					);
				await cloud.heartbeat(
					principal,
					((await readBody(request)) as { capabilities?: unknown })
						.capabilities,
				);
				return json(response, 200, { data: { accepted: true } }, requestId);
			}
			if (request.method === "POST" && path === "/api/v1/runner/jobs/claim") {
				const principal = await authenticate(request, true);
				if (principal.type !== "RUNNER")
					throw new RepoArenaError(
						"FORBIDDEN",
						"Runner authentication required.",
					);
				return json(
					response,
					200,
					{ data: await cloud.claimJob(principal) },
					requestId,
				);
			}
			const result = path.match(/^\/api\/v1\/runner\/jobs\/([^/]+)\/result$/);
			if (result?.[1] && request.method === "POST") {
				const jobId = uuid.parse(result[1]);
				const bearer =
					request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
				const principal = bearer?.startsWith("raj_")
					? await cloud.authenticateJobCredential(bearer, jobId, "result:write")
					: await authenticate(request, true);
				if (principal.type !== "RUNNER")
					throw new RepoArenaError(
						"FORBIDDEN",
						"Runner authentication required.",
					);
				const body = bodySchemas.result.parse(await readBody(request));
				return json(
					response,
					200,
					{
						data: await cloud.submitResult(principal, jobId, body.result),
					},
					requestId,
				);
			}
			const actionResult = path.match(
				/^\/api\/v1\/github\/actions\/runs\/([^/]+)\/result$/,
			);
			if (actionResult?.[1] && request.method === "POST") {
				if (!options.githubActions)
					throw new RepoArenaError(
						"CONFIG_INVALID",
						"GitHub Actions publication is unavailable.",
					);
				const bearer =
					request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
				if (!bearer)
					throw new RepoArenaError(
						"AUTH_UNAVAILABLE",
						"GitHub Action credential is required.",
					);
				const body = bodySchemas.result.parse(await readBody(request));
				return json(
					response,
					200,
					{
						data: await options.githubActions.submitResult(
							bearer,
							uuid.parse(actionResult[1]),
							body.result,
						),
					},
					requestId,
				);
			}
			const artifact = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/artifacts\/([^/]+)\/read$/,
			);
			if (artifact?.[1] && artifact[2] && request.method === "POST")
				return json(
					response,
					200,
					{
						data: {
							url: await artifacts.signedRead(
								await authenticate(request, true),
								uuid.parse(artifact[1]),
								uuid.parse(artifact[2]),
							),
						},
					},
					requestId,
				);
			return json(
				response,
				404,
				{
					error: {
						code: "NOT_FOUND",
						message: "Route not found.",
						request_id: requestId,
					},
				},
				requestId,
			);
		} catch (error) {
			const code =
				error instanceof RepoArenaError
					? error.code
					: error instanceof z.ZodError
						? "VALIDATION"
						: "INTERNAL";
			const status =
				code === "AUTH_UNAVAILABLE"
					? 401
					: code === "FORBIDDEN"
						? 403
						: code === "NOT_FOUND"
							? 404
							: code === "CONFLICT"
								? 409
								: code === "RATE_LIMITED"
									? 429
									: code === "VALIDATION" || code === "CONFIG_INVALID"
										? 400
										: 500;
			json(
				response,
				status,
				{
					error: {
						code,
						message:
							status === 500
								? "Internal server error."
								: error instanceof RepoArenaError
									? error.message
									: "Request validation failed.",
						request_id: requestId,
					},
				},
				requestId,
			);
		} finally {
			const duration = performance.now() - started;
			options.logger?.({
				request_id: requestId,
				operation: `${request.method ?? "UNKNOWN"} ${(request.url ?? "/").split("?")[0]}`,
				duration_ms: duration,
				status: response.statusCode,
				outcome: response.statusCode < 400 ? "success" : "failure",
			});
			await cloud
				.recordMetric("http.request.duration_ms", duration, {
					method: request.method ?? "UNKNOWN",
					status: String(response.statusCode),
				})
				.catch(() => undefined);
			if (!Number.isFinite(duration)) response.destroy();
		}
	});
	return {
		server,
		start: (host = "127.0.0.1", port = 8080) =>
			new Promise<{ url: string }>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					const address = server.address();
					if (!address || typeof address === "string")
						return reject(new Error("API address unavailable"));
					resolve({ url: `http://${host}:${address.port}` });
				});
			}),
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
