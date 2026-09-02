import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	STRIPE_API_VERSION,
	StripeProvider,
	verifyStripeWebhook,
} from "./index.js";

it("forms versioned idempotent Stripe requests without assuming token format", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					id: "cs_test",
					url: "https://checkout.stripe.test/session",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	);
	const secret = "sk_test_variable_length_secret_value";
	const stripe = new StripeProvider(
		secret,
		"https://stripe.test",
		fetcher as typeof fetch,
	);
	await stripe.createCheckout({
		customerId: "cus_safe",
		priceId: "price_server_selected",
		organizationId: "00000000-0000-4000-8000-000000000001",
		successUrl: "https://app.test/billing/success",
		cancelUrl: "https://app.test/billing/cancel",
		idempotencyKey: "checkout-safe",
	});
	const call = calls[0];
	expect(call?.url).toBe("https://stripe.test/v1/checkout/sessions");
	expect(new Headers(call?.init?.headers).get("stripe-version")).toBe(
		STRIPE_API_VERSION,
	);
	expect(new Headers(call?.init?.headers).get("idempotency-key")).toBe(
		"checkout-safe",
	);
	expect(new Headers(call?.init?.headers).get("authorization")).toBe(
		`Bearer ${secret}`,
	);
	expect(String(call?.init?.body)).toContain("price_server_selected");
});

it("classifies rate limits and verifies the exact raw webhook body", async () => {
	const stripe = new StripeProvider(
		"sk_test_secret",
		"https://stripe.test",
		async () =>
			new Response('{"error":{}}', {
				status: 429,
				headers: { "retry-after": "2" },
			}),
	);
	await expect(
		stripe.createCustomer({ organizationId: "org", idempotencyKey: "key" }),
	).rejects.toMatchObject({
		code: "RATE_LIMITED",
		retryable: true,
		retryAfterMs: 2_000,
	});
	const now = new Date("2026-09-03T00:00:00Z");
	const raw = Buffer.from('{"id":"evt_1", "type":"invoice.paid"}');
	const timestamp = Math.floor(now.getTime() / 1_000);
	const secret = "whsec_fixture";
	const signature = createHmac("sha256", secret)
		.update(`${timestamp}.`)
		.update(raw)
		.digest("hex");
	const header = `t=${timestamp},v1=${signature}`;
	expect(() => verifyStripeWebhook(raw, header, secret, now)).not.toThrow();
	expect(() =>
		verifyStripeWebhook(
			Buffer.from(JSON.stringify(JSON.parse(raw.toString()))),
			header,
			secret,
			now,
		),
	).toThrow("invalid");
});

it("forms customer, portal, retrieval and subscription update contracts", async () => {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const stripe = new StripeProvider(
		"sk_test_contract",
		"https://stripe.test",
		async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/customers")) return Response.json({ id: "cus_1" });
			if (url.endsWith("/billing_portal/sessions"))
				return Response.json({ id: "bps_1", url: "https://billing.test" });
			return Response.json({
				id: "sub_variable-format",
				customer: "cus_1",
				status: "active",
				items: { data: [{ price: { id: "price_team" }, quantity: 3 }] },
			});
		},
	);
	await stripe.createCustomer({
		organizationId: "org_opaque",
		idempotencyKey: "customer-idempotency",
	});
	await stripe.createPortal({
		customerId: "cus_1",
		returnUrl: "https://app.test/billing",
		idempotencyKey: "portal-idempotency",
	});
	expect(
		(await stripe.retrieveSubscription("sub_variable-format")).quantity,
	).toBe(3);
	await stripe.updateSubscription({
		id: "sub_variable-format",
		priceId: "price_team",
		cancelAtPeriodEnd: true,
		idempotencyKey: "subscription-idempotency",
	});
	expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
		"/v1/customers",
		"/v1/billing_portal/sessions",
		"/v1/subscriptions/sub_variable-format",
		"/v1/subscriptions/sub_variable-format",
	]);
	expect(String(calls[3]?.init?.body)).toContain("cancel_at_period_end=true");
	expect(new Headers(calls[3]?.init?.headers).get("idempotency-key")).toBe(
		"subscription-idempotency",
	);
});
