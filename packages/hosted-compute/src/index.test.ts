import { expect, it, vi } from "vitest";
import {
	DeterministicHostedComputeProvider,
	HostedProviderError,
	HttpHostedComputeProvider,
} from "./index.js";

const request = {
	idempotencyKey: "lease",
	leaseId: "lease",
	resourceClass: {
		id: "SMALL" as const,
		version: 1,
		vcpu: 2,
		memoryMb: 4096,
		ephemeralDiskMb: 10240,
		maxWallTimeMs: 60_000,
		maxProcesses: 64,
		maxLogBytes: 100,
		maxArtifactBytes: 100,
		networkModes: ["NETWORK_DISABLED" as const],
		pricingVersion: "v1",
		rateMicrosPerMinute: 10,
	},
	maxWallTimeMs: 60_000,
	networkPolicy: "NETWORK_DISABLED" as const,
	labels: { managed_by: "repoarena", lease_id: "lease" },
	bootstrapToken: "SECRET_SENTINEL",
};

it("provisions idempotently and classifies deterministic failures", async () => {
	const provider = new DeterministicHostedComputeProvider();
	expect((await provider.provision(request)).id).toBe(
		(await provider.provision(request)).id,
	);
	provider.scenario = "CAPACITY";
	await expect(
		provider.provision({ ...request, leaseId: "other" }),
	).rejects.toMatchObject({
		code: "HOSTED_CAPACITY_UNAVAILABLE",
		retryable: true,
	});
});

it("forms authenticated, versioned provisioner requests without token assumptions", async () => {
	const fake = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) =>
			init?.method === "DELETE"
				? new Response(null, { status: 204 })
				: new Response(
						JSON.stringify({ id: "i", state: "READY", labels: {} }),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
		);
	const provider = new HttpHostedComputeProvider(
		"https://compute.invalid",
		"opaque_token_of_any_length",
		fake,
	);
	await provider.provision(request);
	expect(fake).toHaveBeenCalledWith(
		"https://compute.invalid/v1/resources",
		expect.objectContaining({
			method: "POST",
			headers: expect.objectContaining({
				authorization: "Bearer opaque_token_of_any_length",
				"idempotency-key": "lease",
			}),
		}),
	);
	await provider.terminate("i");
});

it("returns redacted typed HTTP failures", async () => {
	const provider = new HttpHostedComputeProvider(
		"https://compute.invalid",
		"SECRET",
		vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("secret echo", { status: 429 })),
	);
	await expect(provider.inspect("x")).rejects.toEqual(
		new HostedProviderError(
			"PROVIDER_QUOTA_EXCEEDED",
			"Hosted provider request failed (429).",
			true,
		),
	);
});
