import { expect, it, vi } from "vitest";
import { CloudApiClient } from "./index.js";

it("maps versioned API responses and canonical errors", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { id: "ok" } }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: { code: "FORBIDDEN", message: "Denied.", request_id: "req" },
					}),
					{ status: 403 },
				),
			),
	);
	const client = new CloudApiClient("https://cloud.example/", "secret");
	expect(await client.request("/api/v1/resource")).toEqual({ id: "ok" });
	await expect(client.request("/api/v1/resource")).rejects.toMatchObject({
		code: "FORBIDDEN",
		requestId: "req",
		status: 403,
	});
	vi.unstubAllGlobals();
});
