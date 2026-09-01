import { randomBytes, randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { Database } from "@repoarena/cloud-db";
import {
	ArtifactService,
	CloudService,
	type Permission,
	type Principal,
} from "@repoarena/cloud-core";
import { RepoArenaError } from "@repoarena/core";
import type { ObjectStorage } from "@repoarena/object-storage";
import { z } from "zod";

export interface OAuthProvider {
	authorizationUrl(state: string): string;
	exchange(
		code: string,
	): Promise<{
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
const json = (
	response: ServerResponse,
	status: number,
	value: unknown,
	requestId: string,
) => {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
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
}) {
	const cloud = new CloudService(options.database, options.now);
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
				if (!options.oauth)
					throw new RepoArenaError("CONFIG_INVALID", "OAuth is unavailable.");
				const state = randomBytes(24).toString("base64url");
				oauthStates.set(state, Date.now() + 600_000);
				response.statusCode = 302;
				response.setHeader("location", options.oauth.authorizationUrl(state));
				response.end();
				return;
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
			const runs = path.match(/^\/api\/v1\/organizations\/([^/]+)\/runs$/);
			if (runs?.[1] && request.method === "GET") {
				const organizationId = uuid.parse(runs[1]);
				const cursor = url.searchParams.get("cursor");
				const decoded = cursor
					? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
							createdAt: string;
							id: string;
						})
					: undefined;
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
			const keys = path.match(/^\/api\/v1\/organizations\/([^/]+)\/api-keys$/);
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
			const runners = path.match(
				/^\/api\/v1\/organizations\/([^/]+)\/runners$/,
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
				const principal = await authenticate(request, true);
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
						data: await cloud.submitResult(
							principal,
							uuid.parse(result[1]),
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
