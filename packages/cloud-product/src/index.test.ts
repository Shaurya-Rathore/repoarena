import { afterEach, describe, expect, it } from "vitest";
import { createCloudProduct } from "./index.js";

const publication = {
	public_id: "rap_public",
	repository_public_id: "rar_00000000000000000000",
	repository: {
		name: '<script>alert("repo")</script>',
		url: "https://github.com/acme/repo",
	},
	run: {
		statistics: {
			solved_count: 1,
			attempt_count: 2,
			success_rate: 0.5,
			pass_at_k: 0.5,
			total_cost_micros: 2500,
			median_duration_ms: 10,
		},
		agents: [{ id: "codex", model: "safe" }],
		completed_at: "2026-01-01T00:00:00.000Z",
	},
	methodology_version: "repoarena-public/v1",
};

describe("cloud product server", () => {
	const products: Array<ReturnType<typeof createCloudProduct>> = [];
	afterEach(async () => {
		await Promise.all(products.splice(0).map((product) => product.close()));
	});
	const start = async (authenticated = false) => {
		const product = createCloudProduct({
			cloudOrigin: "http://cloud.invalid",
			publicOrigin: "http://127.0.0.1",
			fetch: async (input) => {
				const path = new URL(String(input)).pathname;
				if (path === "/api/v1/organizations")
					return new Response(
						authenticated ? JSON.stringify({ data: [] }) : "",
						{
							status: authenticated ? 200 : 401,
							headers: { "content-type": "application/json" },
						},
					);
				if (path === "/api/v1/public/runs/rap_public")
					return Response.json({ data: publication });
				if (path === "/api/v1/public/repositories/rar_00000000000000000000")
					return Response.json({ data: publication });
				if (
					path ===
					"/api/v1/public/repositories/rar_00000000000000000000/badge.svg"
				)
					return new Response('<svg role="img"></svg>', {
						headers: { "content-type": "image/svg+xml" },
					});
				if (path === "/api/v1/public/leaderboard")
					return Response.json({
						data: {
							entries: [
								{
									...publication,
									eligibility: "ELIGIBLE",
									published_at: "2026-01-01T00:00:00.000Z",
								},
							],
						},
					});
				if (path === "/api/v1/public/badges/rap_public.svg")
					return new Response('<svg role="img"></svg>', {
						headers: {
							"content-type": "image/svg+xml",
							"cache-control": "public, max-age=300",
						},
					});
				return new Response("not found", { status: 404 });
			},
		});
		products.push(product);
		return (await product.start("127.0.0.1", 0)).url;
	};

	it("serves secure public surfaces and escapes publication data", async () => {
		const origin = await start();
		const home = await fetch(origin);
		expect(await home.text()).toContain("CI for AI coding agents");
		expect(home.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		const share = await fetch(`${origin}/share/rap_public`);
		const html = await share.text();
		expect(html).toContain(
			"&lt;script&gt;alert(&quot;repo&quot;)&lt;/script&gt;",
		);
		expect(html).not.toContain('<script>alert("repo")</script>');
		expect(
			(await fetch(`${origin}/badge/rap_public.svg`)).headers.get(
				"cache-control",
			),
		).toContain("max-age=300");
		expect(await (await fetch(`${origin}/robots.txt`)).text()).toContain(
			"Disallow: /app",
		);
		expect(await (await fetch(`${origin}/sitemap.xml`)).text()).toContain(
			"/share/rap_public",
		);
	});

	it("redirects unauthenticated app requests without accepting an open redirect", async () => {
		const origin = await start();
		const app = await fetch(`${origin}/app/runs`, { redirect: "manual" });
		expect(app.status).toBe(302);
		expect(app.headers.get("location")).toBe("/signin?next=%2Fapp%2Fruns");
		const signIn = await (
			await fetch(`${origin}/signin?next=https://evil.example`)
		).text();
		expect(signIn).toContain("next=%2Fapp");
		expect(signIn).not.toContain("evil.example");
	});

	it("marks authenticated application responses private and non-indexable", async () => {
		const origin = await start(true);
		const response = await fetch(`${origin}/app`);
		const html = await response.text();
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(html).toContain('name="robots" content="noindex,nofollow"');
		expect(html).toContain("Repositories");
	});

	it("does not reuse authenticated organization checks across sessions", async () => {
		const seen: string[] = [];
		const product = createCloudProduct({
			cloudOrigin: "http://cloud.invalid",
			publicOrigin: "http://127.0.0.1",
			fetch: async (_input, init) => {
				seen.push(String((init?.headers as Record<string, string>).cookie));
				return Response.json({ data: [] });
			},
		});
		products.push(product);
		const origin = (await product.start("127.0.0.1", 0)).url;
		await fetch(`${origin}/app`, {
			headers: { cookie: "repoarena_session=org-a" },
		});
		await fetch(`${origin}/app`, {
			headers: { cookie: "repoarena_session=org-b" },
		});
		expect(seen).toEqual([
			"repoarena_session=org-a",
			"repoarena_session=org-b",
		]);
	});
});
