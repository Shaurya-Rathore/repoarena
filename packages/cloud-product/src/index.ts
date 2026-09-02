import { randomBytes } from "node:crypto";
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { appPage, publicPage } from "./assets.js";

const escapeHtml = (value: unknown) =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
const boundedBody = async (request: IncomingMessage) => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const value = Buffer.from(chunk);
		size += value.length;
		if (size > 1_000_000) throw new Error("Request body is too large.");
		chunks.push(value);
	}
	return Buffer.concat(chunks);
};
const send = (
	response: ServerResponse,
	status: number,
	type: string,
	body: string,
) => {
	response.statusCode = status;
	response.setHeader("content-type", type);
	response.end(body);
};

export function createCloudProduct(options: {
	cloudOrigin: string;
	publicOrigin: string;
	fetch?: typeof fetch;
	analytics?: (event: { name: string; path: string }) => void;
}) {
	const fetcher = options.fetch ?? fetch;
	let server: Server | undefined;
	const cloud = async (path: string, request?: IncomingMessage) =>
		fetcher(new URL(path, options.cloudOrigin), {
			method: request?.method ?? "GET",
			headers: {
				...(request?.headers.cookie ? { cookie: request.headers.cookie } : {}),
				...(request?.headers.authorization
					? { authorization: request.headers.authorization }
					: {}),
				...(request?.headers["content-type"]
					? { "content-type": String(request.headers["content-type"]) }
					: {}),
				...(request?.headers["x-csrf-token"]
					? { "x-csrf-token": String(request.headers["x-csrf-token"]) }
					: {}),
				...(request?.headers["idempotency-key"]
					? { "idempotency-key": String(request.headers["idempotency-key"]) }
					: {}),
				...(request && !["GET", "HEAD"].includes(request.method ?? "GET")
					? { origin: options.publicOrigin }
					: {}),
			},
			...(request && !["GET", "HEAD"].includes(request.method ?? "GET")
				? { body: await boundedBody(request) }
				: {}),
			redirect: "manual",
		});
	const handler = async (
		request: IncomingMessage,
		response: ServerResponse,
	) => {
		const nonce = randomBytes(18).toString("base64url");
		response.setHeader(
			"content-security-policy",
			`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com`,
		);
		response.setHeader("referrer-policy", "strict-origin-when-cross-origin");
		response.setHeader("x-content-type-options", "nosniff");
		response.setHeader("x-frame-options", "DENY");
		response.setHeader(
			"permissions-policy",
			"camera=(), microphone=(), geolocation=()",
		);
		try {
			const url = new URL(request.url ?? "/", options.publicOrigin);
			options.analytics?.({ name: "page_view", path: url.pathname });
			if (
				url.pathname.startsWith("/cloud/") ||
				url.pathname.startsWith("/auth/")
			) {
				const target = url.pathname.startsWith("/cloud/")
					? url.pathname.slice(6)
					: url.pathname;
				const upstream = await cloud(`${target}${url.search}`, request);
				response.statusCode = upstream.status;
				for (const name of [
					"content-type",
					"cache-control",
					"location",
					"x-request-id",
				]) {
					const value = upstream.headers.get(name);
					if (value) response.setHeader(name, value);
				}
				const cookies = upstream.headers.getSetCookie();
				if (cookies.length) response.setHeader("set-cookie", cookies);
				return response.end(Buffer.from(await upstream.arrayBuffer()));
			}
			if (url.pathname === "/health/live")
				return send(response, 200, "application/json", '{"status":"ok"}\n');
			if (url.pathname === "/robots.txt")
				return send(
					response,
					200,
					"text/plain; charset=utf-8",
					"User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /cloud\nDisallow: /auth\n",
				);
			if (url.pathname === "/sitemap.xml") {
				const board = await cloud("/api/v1/public/leaderboard?limit=100");
				const value = board.ok
					? ((await board.json()) as {
							data?: { entries?: Array<{ public_id: string }> };
						})
					: {};
				const locations = [
					"/",
					"/leaderboard",
					"/methodology",
					...(value.data?.entries ?? []).map(
						(entry) => `/share/${entry.public_id}`,
					),
				];
				return send(
					response,
					200,
					"application/xml; charset=utf-8",
					`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((location) => `<url><loc>${escapeHtml(new URL(location, options.publicOrigin))}</loc></url>`).join("")}</urlset>`,
				);
			}
			if (url.pathname.startsWith("/repository/")) {
				const id = url.pathname.slice("/repository/".length);
				const upstream = await cloud(
					`/api/v1/public/repositories/${encodeURIComponent(id)}`,
				);
				if (!upstream.ok)
					return send(
						response,
						404,
						"text/html; charset=utf-8",
						publicPage(
							'<main class="hero"><h1>Repository unavailable</h1></main>',
							{
								title: "Repository unavailable · RepoArena",
								description: "This public repository profile is unavailable.",
								canonical: `${options.publicOrigin}${url.pathname}`,
							},
							nonce,
						),
					);
				const value = (await upstream.json()) as {
					data: { public_id: string };
				};
				response.statusCode = 302;
				response.setHeader(
					"location",
					`/share/${encodeURIComponent(value.data.public_id)}`,
				);
				return response.end();
			}
			if (url.pathname.startsWith("/badge/repository/")) {
				const id = url.pathname
					.slice("/badge/repository/".length)
					.replace(/\.svg$/, "");
				const upstream = await cloud(
					`/api/v1/public/repositories/${encodeURIComponent(id)}/badge.svg`,
				);
				response.statusCode = upstream.status;
				response.setHeader(
					"content-type",
					upstream.headers.get("content-type") ?? "image/svg+xml",
				);
				response.setHeader(
					"cache-control",
					upstream.headers.get("cache-control") ?? "public, max-age=300",
				);
				return response.end(Buffer.from(await upstream.arrayBuffer()));
			}
			if (url.pathname.startsWith("/badge/")) {
				const id = url.pathname.slice("/badge/".length).replace(/\.svg$/, "");
				const upstream = await cloud(
					`/api/v1/public/badges/${encodeURIComponent(id)}.svg`,
				);
				response.statusCode = upstream.status;
				response.setHeader(
					"content-type",
					upstream.headers.get("content-type") ?? "image/svg+xml",
				);
				response.setHeader(
					"cache-control",
					upstream.headers.get("cache-control") ?? "public, max-age=300",
				);
				return response.end(Buffer.from(await upstream.arrayBuffer()));
			}
			if (url.pathname.startsWith("/app")) {
				const auth = await cloud("/api/v1/organizations", request);
				if (auth.status === 401) {
					response.statusCode = 302;
					response.setHeader(
						"location",
						`/signin?next=${encodeURIComponent(url.pathname)}`,
					);
					return response.end();
				}
				if (!auth.ok)
					return send(
						response,
						auth.status,
						"text/html; charset=utf-8",
						publicPage(
							'<main class="hero"><h1>Unable to load workspace</h1><p>The authenticated API rejected this request.</p></main>',
							{
								title: "Workspace unavailable · RepoArena",
								description: "RepoArena workspace unavailable.",
								canonical: `${options.publicOrigin}/app`,
							},
							nonce,
						),
					);
				response.setHeader("cache-control", "private, no-store");
				return send(response, 200, "text/html; charset=utf-8", appPage(nonce));
			}
			if (url.pathname === "/signin") {
				const next = url.searchParams.get("next");
				const safeNext =
					next?.startsWith("/app") && !next.startsWith("//") ? next : "/app";
				return send(
					response,
					200,
					"text/html; charset=utf-8",
					publicPage(
						`<main class="hero"><div class="eyebrow">Secure workspace</div><h1>Sign in to RepoArena</h1><p>Authenticate with GitHub to access organizations, repositories, runners, schedules, and benchmark history.</p><div class="actions"><a class="button" href="/auth/login?next=${encodeURIComponent(safeNext)}">Continue with GitHub</a></div></main>`,
						{
							title: "Sign in · RepoArena",
							description: "Sign in to RepoArena Cloud with GitHub.",
							canonical: `${options.publicOrigin}/signin`,
						},
						nonce,
					),
				);
			}
			if (url.pathname === "/pricing")
				return send(
					response,
					200,
					"text/html; charset=utf-8",
					publicPage(
						'<main class="hero"><div class="eyebrow">RepoArena subscriptions</div><h1>Product capability, not model tokens.</h1><p>Community supports the local workflow. Pro adds private repositories, cloud history, schedules, and API access. Team adds collaboration and higher limits. Enterprise is a managed agreement.</p><section class="features"><article class="card"><h2>Community</h2><p>Local and public repository workflows.</p></article><article class="card"><h2>Pro</h2><p>Private repositories, schedules, API access, and expanded history.</p></article><article class="card"><h2>Team</h2><p>Team collaboration and higher runner, member, and schedule limits.</p></article><article class="card"><h2>Enterprise</h2><p>Contact the RepoArena team for contractual deployment requirements.</p></article></section><div class="alert"><strong>BYOK remains separate.</strong> Model-provider usage is paid directly to OpenAI, Anthropic, Google, or another provider through your own credentials.</div><div class="actions"><a class="button" href="/signin">Choose a plan</a></div></main>',
						{
							title: "RepoArena pricing",
							description:
								"RepoArena subscriptions and BYOK model-cost separation.",
							canonical: `${options.publicOrigin}/pricing`,
						},
						nonce,
					),
				);
			if (url.pathname === "/leaderboard") {
				const upstream = await cloud(
					`/api/v1/public/leaderboard?limit=${encodeURIComponent(url.searchParams.get("limit") ?? "50")}`,
				);
				const payload = upstream.ok
					? ((await upstream.json()) as {
							data: {
								entries: Array<{
									public_id: string;
									repository: { name: string };
									run: {
										statistics: {
											success_rate: number | null;
											pass_at_k: number | null;
											attempt_count: number;
											total_cost_micros: number | null;
											median_duration_ms: number | null;
										};
										agents: Array<{ id: string; model: string | null }>;
									};
									eligibility: string;
									methodology_version: string;
									published_at: string;
								}>;
							};
						})
					: { data: { entries: [] } };
				const rows = payload.data.entries
					.map(
						(entry) =>
							`<tr><td><a href="/share/${escapeHtml(entry.public_id)}">${escapeHtml(entry.run.agents.map((a) => `${a.id}/${a.model ?? "default"}`).join(", "))}</a></td><td>${entry.run.statistics.success_rate === null ? "unknown" : `${(entry.run.statistics.success_rate * 100).toFixed(1)}%`}</td><td>${escapeHtml(entry.run.statistics.pass_at_k ?? "unknown")}</td><td>${entry.run.statistics.attempt_count}</td><td>${entry.run.statistics.total_cost_micros === null ? "unknown" : `$${(entry.run.statistics.total_cost_micros / 1e6).toFixed(4)}`}</td><td>${escapeHtml(entry.eligibility)}</td><td>${escapeHtml(entry.methodology_version)}</td></tr>`,
					)
					.join("");
				return send(
					response,
					200,
					"text/html; charset=utf-8",
					publicPage(
						`<main class="hero"><div class="eyebrow">Published evidence</div><h1>Agent leaderboard</h1><p>Interpretable solve rate, pass@k, cost, duration, and sample counts. Eligibility requires complete canonical provenance and compatible methodology.</p>${rows ? `<table><thead><tr><th>Agent/model</th><th>Solve rate</th><th>Pass@k</th><th>Samples</th><th>BYOK cost</th><th>Eligibility</th><th>Methodology</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No eligible published benchmarks yet.</div>'}</main>`,
						{
							title: "Coding agent leaderboard · RepoArena",
							description:
								"Published repository-specific coding-agent benchmark evidence.",
							canonical: `${options.publicOrigin}/leaderboard`,
						},
						nonce,
					),
				);
			}
			if (url.pathname.startsWith("/share/")) {
				const id = url.pathname.slice(7);
				const upstream = await cloud(
					`/api/v1/public/runs/${encodeURIComponent(id)}`,
				);
				if (!upstream.ok)
					return send(
						response,
						404,
						"text/html; charset=utf-8",
						publicPage(
							'<main class="hero"><h1>Publication unavailable</h1><p>This result is unpublished or does not exist.</p></main>',
							{
								title: "Publication unavailable · RepoArena",
								description: "This RepoArena publication is unavailable.",
								canonical: `${options.publicOrigin}${url.pathname}`,
							},
							nonce,
						),
					);
				const p = (await upstream.json()) as {
					data: {
						public_id: string;
						repository_public_id: string;
						repository: { name: string; url: string | null };
						run: {
							statistics: {
								solved_count: number;
								attempt_count: number;
								success_rate: number | null;
								pass_at_k: number | null;
								total_cost_micros: number | null;
								median_duration_ms: number | null;
							};
							agents: Array<{ id: string; model: string | null }>;
							completed_at: string;
						};
						methodology_version: string;
					};
				};
				const value = p.data;
				const badgeUrl = `${options.publicOrigin}/badge/repository/${encodeURIComponent(value.repository_public_id)}.svg`;
				const markdown = `[![RepoArena](${badgeUrl})](${options.publicOrigin}/share/${encodeURIComponent(value.public_id)})`;
				return send(
					response,
					200,
					"text/html; charset=utf-8",
					publicPage(
						`<main class="hero"><div class="eyebrow">Verified public benchmark</div><h1>${escapeHtml(value.repository.name)}</h1><p>${escapeHtml(value.run.agents.map((agent) => `${agent.id} / ${agent.model ?? "default"}`).join(", "))}</p><div class="grid"><div class="card"><div class="metric">${value.run.statistics.solved_count}/${value.run.statistics.attempt_count}</div><span class="muted">Solved attempts</span></div><div class="card"><div class="metric">${value.run.statistics.success_rate === null ? "unknown" : `${(value.run.statistics.success_rate * 100).toFixed(1)}%`}</div><span class="muted">Solve rate</span></div><div class="card"><div class="metric">${escapeHtml(value.run.statistics.pass_at_k ?? "unknown")}</div><span class="muted">Pass@k</span></div><div class="card"><div class="metric">${value.run.statistics.total_cost_micros === null ? "unknown" : `$${(value.run.statistics.total_cost_micros / 1e6).toFixed(4)}`}</div><span class="muted">Provider cost via BYOK</span></div></div><h2>README badge</h2><img src="${escapeHtml(badgeUrl)}" alt="RepoArena benchmark badge"><pre>${escapeHtml(markdown)}</pre><p>Methodology: ${escapeHtml(value.methodology_version)} · Completed ${escapeHtml(value.run.completed_at)}</p>${value.repository.url ? `<a class="button secondary" href="${escapeHtml(value.repository.url)}" rel="noopener noreferrer">Repository</a>` : ""}</main>`,
						{
							title: `${escapeHtml(value.repository.name)} benchmark · RepoArena`,
							description:
								"Published RepoArena coding-agent benchmark with methodology and sample evidence.",
							canonical: `${options.publicOrigin}${url.pathname}`,
						},
						nonce,
					),
				);
			}
			if (url.pathname === "/methodology")
				return send(
					response,
					200,
					"text/html; charset=utf-8",
					publicPage(
						'<main class="hero"><div class="eyebrow">Transparent evaluation</div><h1>Repository behavior, not patch imitation.</h1><p>RepoArena reconstructs historical bugs, runs public checks, introduces hidden evaluation only after the agent terminates, and reports canonical correctness, pass@k, duration, usage, and immutable cost provenance.</p></main>',
						{
							title: "Methodology · RepoArena",
							description:
								"How RepoArena evaluates coding agents safely and reproducibly.",
							canonical: `${options.publicOrigin}/methodology`,
						},
						nonce,
					),
				);
			return send(
				response,
				200,
				"text/html; charset=utf-8",
				publicPage(
					'<main class="hero"><div class="eyebrow">CI for AI coding agents.</div><h1>Find the best coding agent for your repo.</h1><p>Benchmark agents on real historical bugs with hidden verification. Compare correctness, cost, duration, reliability, and code churn locally, in CI, or through RepoArena Cloud.</p><div class="actions"><a class="button" href="/signin">Benchmark your repository</a><a class="button secondary" href="/leaderboard">Explore leaderboard</a><a class="button secondary" href="https://github.com/Shaurya-Rathore/repoarena" rel="noopener noreferrer">Install local CLI</a></div><section class="features"><article class="card"><h2>Real repository behavior</h2><p>Canonical public and hidden checks decide correctness—not similarity to a reference patch.</p></article><article class="card"><h2>Agent comparison</h2><p>Compare pass@k, reliability, duration, BYOK cost, and failure modes on the same task set.</p></article><article class="card"><h2>GitHub-native CI</h2><p>App Checks and a bundled Action connect durable cloud runs to commits and pull requests.</p></article></section></main>',
					{
						title: "RepoArena · CI for AI coding agents",
						description:
							"Find the best coding agent for your repository using real historical bugs and hidden verification.",
						canonical: `${options.publicOrigin}/`,
					},
					nonce,
				),
			);
		} catch {
			return send(
				response,
				500,
				"text/html; charset=utf-8",
				publicPage(
					'<main class="hero"><h1>Something went wrong</h1><p>Try again or check service health. Internal details were not exposed.</p></main>',
					{
						title: "Error · RepoArena",
						description: "RepoArena request failed safely.",
						canonical: options.publicOrigin,
					},
					nonce,
				),
			);
		}
	};
	return {
		async start(host = "127.0.0.1", port = 3000) {
			server = createServer(
				(request, response) => void handler(request, response),
			);
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(port, host, resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Cloud product address unavailable.");
			return {
				url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
			};
		},
		async close() {
			if (server)
				await new Promise<void>((resolve, reject) =>
					server?.close((error) => (error ? reject(error) : resolve())),
				);
		},
	};
}
