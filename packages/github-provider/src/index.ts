import { createHmac, createSign, timingSafeEqual } from "node:crypto";

const encode = (value: string | object) =>
	Buffer.from(
		typeof value === "string" ? value : JSON.stringify(value),
	).toString("base64url");

export const createAppJwt = (
	appId: string,
	privateKey: string,
	now = new Date(),
): string => {
	if (!appId || !privateKey.includes("PRIVATE KEY"))
		throw new GitHubError(
			"CONFIGURATION",
			"GitHub App credentials are invalid.",
			false,
		);
	const issued = Math.floor(now.getTime() / 1_000) - 60;
	const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issued, exp: issued + 600, iss: appId })}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsigned);
	signer.end();
	return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
};

export const verifyWebhook = (
	body: Uint8Array,
	signature: string | undefined,
	secret: string,
): void => {
	if (!secret || !signature?.startsWith("sha256="))
		throw new GitHubError(
			"WEBHOOK_SIGNATURE",
			"Webhook signature is invalid.",
			false,
		);
	const supplied = Buffer.from(signature.slice(7), "hex");
	const expected = createHmac("sha256", secret).update(body).digest();
	if (
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected)
	)
		throw new GitHubError(
			"WEBHOOK_SIGNATURE",
			"Webhook signature is invalid.",
			false,
		);
};

export type GitHubErrorCode =
	| "AUTH"
	| "INSTALLATION_UNAVAILABLE"
	| "REPOSITORY_UNAVAILABLE"
	| "PERMISSION"
	| "RATE_LIMITED"
	| "SECONDARY_RATE_LIMITED"
	| "VALIDATION"
	| "TRANSIENT"
	| "NETWORK"
	| "CONFIGURATION"
	| "WEBHOOK_SIGNATURE";
export class GitHubError extends Error {
	constructor(
		readonly code: GitHubErrorCode,
		message: string,
		readonly retryable: boolean,
		readonly retryAfterMs?: number,
	) {
		super(message);
	}
}

type TokenRecord = { token: string; expiresAt: number };
export type GitHubRepository = Readonly<{
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	visibility?: string;
	default_branch: string;
	archived: boolean;
	clone_url: string;
	html_url: string;
	owner: { login: string };
}>;

const classify = (
	status: number,
	headers: Headers,
	message: string,
): GitHubError => {
	const retryAfter =
		Number(headers.get("retry-after") ?? 0) * 1_000 || undefined;
	if (status === 401)
		return new GitHubError("AUTH", "GitHub authentication failed.", false);
	if (status === 403 && retryAfter)
		return new GitHubError(
			"SECONDARY_RATE_LIMITED",
			"GitHub secondary rate limit was reached.",
			true,
			retryAfter,
		);
	if (status === 403 && headers.get("x-ratelimit-remaining") === "0") {
		const reset =
			Number(headers.get("x-ratelimit-reset") ?? 0) * 1_000 - Date.now();
		return new GitHubError(
			"RATE_LIMITED",
			"GitHub rate limit was reached.",
			true,
			Math.max(1_000, reset),
		);
	}
	if (status === 403)
		return new GitHubError(
			"PERMISSION",
			"GitHub permission was denied.",
			false,
		);
	if (status === 404)
		return new GitHubError(
			"REPOSITORY_UNAVAILABLE",
			"GitHub resource is unavailable.",
			false,
		);
	if (status === 422)
		return new GitHubError("VALIDATION", "GitHub rejected the request.", false);
	if (status >= 500)
		return new GitHubError(
			"TRANSIENT",
			"GitHub service is temporarily unavailable.",
			true,
		);
	return new GitHubError(
		"TRANSIENT",
		message.slice(0, 200) || "GitHub request failed.",
		status >= 500,
	);
};

export class GitHubProvider {
	private readonly tokens = new Map<string, TokenRecord>();
	private readonly pending = new Map<string, Promise<TokenRecord>>();
	constructor(
		private readonly options: {
			appId: string;
			privateKey: string;
			apiUrl?: string;
			fetch?: typeof fetch;
			now?: () => Date;
		},
	) {}
	private get apiUrl() {
		return this.options.apiUrl ?? "https://api.github.com";
	}
	private get fetcher() {
		return this.options.fetch ?? fetch;
	}
	private get now() {
		return this.options.now?.() ?? new Date();
	}
	invalidateInstallationToken(installationId: string) {
		this.tokens.delete(installationId);
	}
	async installationToken(installationId: string): Promise<string> {
		const cached = this.tokens.get(installationId);
		if (cached && cached.expiresAt - this.now.getTime() > 60_000)
			return cached.token;
		const inFlight = this.pending.get(installationId);
		if (inFlight) return (await inFlight).token;
		const request = this.acquireToken(installationId).finally(() =>
			this.pending.delete(installationId),
		);
		this.pending.set(installationId, request);
		const record = await request;
		this.tokens.set(installationId, record);
		return record.token;
	}
	private async acquireToken(installationId: string): Promise<TokenRecord> {
		let response: Response;
		try {
			response = await this.fetcher(
				`${this.apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
				{
					method: "POST",
					headers: this.headers(
						createAppJwt(this.options.appId, this.options.privateKey, this.now),
					),
				},
			);
		} catch {
			throw new GitHubError("NETWORK", "GitHub network request failed.", true);
		}
		if (!response.ok)
			throw classify(response.status, response.headers, await response.text());
		const body = (await response.json()) as {
			token?: unknown;
			expires_at?: unknown;
		};
		if (typeof body.token !== "string" || typeof body.expires_at !== "string")
			throw new GitHubError(
				"VALIDATION",
				"GitHub installation token response is invalid.",
				false,
			);
		const expiresAt = Date.parse(body.expires_at);
		if (!Number.isFinite(expiresAt))
			throw new GitHubError(
				"VALIDATION",
				"GitHub installation token expiry is invalid.",
				false,
			);
		return { token: body.token, expiresAt };
	}
	private headers(token: string) {
		return {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"user-agent": "RepoArena",
			"x-github-api-version": "2022-11-28",
		};
	}
	async request<T>(
		installationId: string,
		path: string,
		init: RequestInit = {},
		retryAuth = true,
	): Promise<T> {
		const token = await this.installationToken(installationId);
		let response: Response;
		try {
			response = await this.fetcher(new URL(path, this.apiUrl), {
				...init,
				headers: {
					...this.headers(token),
					"content-type": "application/json",
					...init.headers,
				},
			});
		} catch {
			throw new GitHubError("NETWORK", "GitHub network request failed.", true);
		}
		if (response.status === 401 && retryAuth) {
			this.invalidateInstallationToken(installationId);
			return this.request<T>(installationId, path, init, false);
		}
		if (!response.ok)
			throw classify(response.status, response.headers, await response.text());
		return response.status === 204
			? (undefined as T)
			: ((await response.json()) as T);
	}
	async listInstallationRepositories(
		installationId: string,
	): Promise<GitHubRepository[]> {
		const repositories: GitHubRepository[] = [];
		for (let page = 1; ; page++) {
			const result = await this.request<{ repositories: GitHubRepository[] }>(
				installationId,
				`/installation/repositories?per_page=100&page=${page}`,
			);
			repositories.push(...result.repositories);
			if (result.repositories.length < 100) return repositories;
		}
	}
	createCheckRun(
		installationId: string,
		owner: string,
		repo: string,
		input: unknown,
	) {
		return this.request<{ id: number }>(
			installationId,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
			{ method: "POST", body: JSON.stringify(input) },
		);
	}
	updateCheckRun(
		installationId: string,
		owner: string,
		repo: string,
		checkId: number,
		input: unknown,
	) {
		return this.request<unknown>(
			installationId,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkId}`,
			{ method: "PATCH", body: JSON.stringify(input) },
		);
	}
	async upsertPullRequestComment(
		installationId: string,
		owner: string,
		repo: string,
		pullNumber: number,
		marker: string,
		body: string,
	): Promise<number> {
		const comments = await this.request<Array<{ id: number; body?: string }>>(
			installationId,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments?per_page=100`,
		);
		const existing = comments.find((comment) => comment.body?.includes(marker));
		if (existing) {
			await this.request(
				installationId,
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existing.id}`,
				{
					method: "PATCH",
					body: JSON.stringify({ body: `${marker}\n${body}` }),
				},
			);
			return existing.id;
		}
		const created = await this.request<{ id: number }>(
			installationId,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`,
			{ method: "POST", body: JSON.stringify({ body: `${marker}\n${body}` }) },
		);
		return created.id;
	}
}
