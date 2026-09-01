import { createHmac, generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createAppJwt, GitHubProvider, verifyWebhook } from "./index.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
	.export({ type: "pkcs8", format: "pem" })
	.toString();

it("creates bounded GitHub App JWT claims and verifies raw webhook bytes", () => {
	const jwt = createAppJwt("123", privateKey, new Date("2026-09-01T00:00:00Z"));
	const payload = JSON.parse(
		Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString(),
	) as { iss: string; exp: number; iat: number };
	expect(payload).toMatchObject({ iss: "123" });
	expect(payload.exp - payload.iat).toBe(600);
	const body = Buffer.from('{"action":"created"}');
	const secret = "webhook-secret-sentinel";
	const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	expect(() => verifyWebhook(body, signature, secret)).not.toThrow();
	expect(() =>
		verifyWebhook(Buffer.from(`${body}x`), signature, secret),
	).toThrow("invalid");
	expect(() => verifyWebhook(body, "sha1=bad", secret)).toThrow("invalid");
});

it("caches opaque varying-length installation tokens without a request stampede", async () => {
	const token = "opaque-token_with-unexpected-format-and-length-".repeat(3);
	let observedHeaders: RequestInit["headers"];
	const fetcher = vi.fn(
		async (_input: string | URL | Request, init?: RequestInit) => {
			observedHeaders = init?.headers;
			return new Response(
				JSON.stringify({ token, expires_at: "2026-09-01T02:00:00Z" }),
				{ status: 201 },
			);
		},
	);
	const provider = new GitHubProvider({
		appId: "1",
		privateKey,
		fetch: fetcher as typeof fetch,
		now: () => new Date("2026-09-01T00:00:00Z"),
	});
	expect(
		await Promise.all([
			provider.installationToken("99"),
			provider.installationToken("99"),
		]),
	).toEqual([token, token]);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(observedHeaders).toMatchObject({
		"x-github-api-version": "2022-11-28",
	});
});

it("uses installation authentication for checks and classifies rate limits safely", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.includes("access_tokens"))
				return new Response(
					JSON.stringify({
						token: "short",
						expires_at: "2026-09-01T02:00:00Z",
					}),
					{ status: 201 },
				);
			if (url.includes("check-runs"))
				return new Response(JSON.stringify({ id: 44 }), { status: 201 });
			return new Response("limited", {
				status: 403,
				headers: { "retry-after": "10" },
			});
		},
	);
	const provider = new GitHubProvider({
		appId: "1",
		privateKey,
		fetch: fetcher as typeof fetch,
		now: () => new Date("2026-09-01T00:00:00Z"),
	});
	expect(
		await provider.createCheckRun("99", "owner", "repo", {
			name: "RepoArena",
			head_sha: "a".repeat(40),
		}),
	).toEqual({ id: 44 });
	const check = calls.find((call) => call.url.includes("check-runs"));
	expect(check?.init?.method).toBe("POST");
	expect(JSON.stringify(check)).not.toContain("PRIVATE KEY");
	await expect(provider.request("99", "/limited")).rejects.toMatchObject({
		code: "SECONDARY_RATE_LIMITED",
		retryable: true,
		retryAfterMs: 10_000,
	});
});

it("updates one managed pull-request comment instead of creating spam", async () => {
	const methods: string[] = [];
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("access_tokens"))
				return new Response(
					JSON.stringify({
						token: "token",
						expires_at: "2026-09-01T02:00:00Z",
					}),
					{ status: 201 },
				);
			methods.push(init?.method ?? "GET");
			if (url.endsWith("comments?per_page=100"))
				return new Response(
					JSON.stringify([{ id: 7, body: "<!-- repoarena --> old" }]),
				);
			return new Response(JSON.stringify({ id: 7 }));
		},
	);
	const provider = new GitHubProvider({
		appId: "1",
		privateKey,
		fetch: fetcher as typeof fetch,
		now: () => new Date("2026-09-01T00:00:00Z"),
	});
	expect(
		await provider.upsertPullRequestComment(
			"9",
			"o",
			"r",
			3,
			"<!-- repoarena -->",
			"new",
		),
	).toBe(7);
	expect(methods).toEqual(["GET", "PATCH"]);
});
