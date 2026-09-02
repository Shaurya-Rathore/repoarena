import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API_VERSION = "2025-08-27.basil";

export type BillingPlan = "PRO" | "TEAM";
export type BillingInterval = "MONTHLY" | "YEARLY";
export type ProviderSubscription = Readonly<{
	id: string;
	customerId: string;
	priceId: string;
	status: string;
	quantity: number;
	periodStart: Date | null;
	periodEnd: Date | null;
	trialEnd: Date | null;
	cancelAtPeriodEnd: boolean;
	cancelledAt: Date | null;
}>;
export interface BillingProvider {
	createCustomer(input: {
		organizationId: string;
		email?: string;
		idempotencyKey: string;
	}): Promise<{ id: string }>;
	createCheckout(input: {
		customerId: string;
		priceId: string;
		organizationId: string;
		successUrl: string;
		cancelUrl: string;
		idempotencyKey: string;
	}): Promise<{ id: string; url: string }>;
	createPortal(input: {
		customerId: string;
		returnUrl: string;
		idempotencyKey: string;
	}): Promise<{ id: string; url: string }>;
	retrieveSubscription(id: string): Promise<ProviderSubscription>;
	updateSubscription(input: {
		id: string;
		priceId?: string;
		cancelAtPeriodEnd?: boolean;
		idempotencyKey: string;
	}): Promise<ProviderSubscription>;
}

export class StripeProviderError extends Error {
	constructor(
		readonly code:
			| "AUTH"
			| "RATE_LIMITED"
			| "VALIDATION"
			| "TRANSIENT"
			| "NETWORK",
		message: string,
		readonly retryable: boolean,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "StripeProviderError";
	}
}

const subscription = (value: Record<string, unknown>): ProviderSubscription => {
	const item = ((
		value.items as {
			data?: Array<{ price?: { id?: string }; quantity?: number }>;
		}
	)?.data ?? [])[0];
	const timestamp = (input: unknown) =>
		typeof input === "number" ? new Date(input * 1_000) : null;
	return {
		id: String(value.id ?? ""),
		customerId: String(value.customer ?? ""),
		priceId: String(item?.price?.id ?? ""),
		status: String(value.status ?? ""),
		quantity: item?.quantity ?? 1,
		periodStart: timestamp(value.current_period_start),
		periodEnd: timestamp(value.current_period_end),
		trialEnd: timestamp(value.trial_end),
		cancelAtPeriodEnd: value.cancel_at_period_end === true,
		cancelledAt: timestamp(value.canceled_at),
	};
};

export class StripeProvider implements BillingProvider {
	constructor(
		private readonly secretKey: string,
		private readonly endpoint = "https://api.stripe.com",
		private readonly fetcher: typeof fetch = fetch,
	) {
		if (!secretKey) throw new Error("Stripe secret key is required.");
	}

	private async request(
		path: string,
		method: "GET" | "POST",
		body?: URLSearchParams,
		idempotencyKey?: string,
	): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await this.fetcher(new URL(path, this.endpoint), {
				method,
				headers: {
					authorization: `Bearer ${this.secretKey}`,
					"stripe-version": STRIPE_API_VERSION,
					...(body
						? { "content-type": "application/x-www-form-urlencoded" }
						: {}),
					...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
				},
				...(body ? { body } : {}),
			});
		} catch {
			throw new StripeProviderError("NETWORK", "Stripe request failed.", true);
		}
		const value = (await response.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!response.ok) {
			const code =
				response.status === 401
					? "AUTH"
					: response.status === 429
						? "RATE_LIMITED"
						: response.status >= 500
							? "TRANSIENT"
							: "VALIDATION";
			throw new StripeProviderError(
				code,
				`Stripe request failed (${response.status}).`,
				code === "RATE_LIMITED" || code === "TRANSIENT",
				response.headers.get("retry-after")
					? Number(response.headers.get("retry-after")) * 1_000
					: undefined,
			);
		}
		return value;
	}

	async createCustomer(
		input: Parameters<BillingProvider["createCustomer"]>[0],
	) {
		const body = new URLSearchParams({
			"metadata[repoarena_organization_id]": input.organizationId,
			...(input.email ? { email: input.email } : {}),
		});
		const value = await this.request(
			"/v1/customers",
			"POST",
			body,
			input.idempotencyKey,
		);
		return { id: String(value.id) };
	}

	async createCheckout(
		input: Parameters<BillingProvider["createCheckout"]>[0],
	) {
		const body = new URLSearchParams({
			mode: "subscription",
			customer: input.customerId,
			"line_items[0][price]": input.priceId,
			"line_items[0][quantity]": "1",
			client_reference_id: input.organizationId,
			"subscription_data[metadata][repoarena_organization_id]":
				input.organizationId,
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
		});
		const value = await this.request(
			"/v1/checkout/sessions",
			"POST",
			body,
			input.idempotencyKey,
		);
		return { id: String(value.id), url: String(value.url) };
	}

	async createPortal(input: Parameters<BillingProvider["createPortal"]>[0]) {
		const value = await this.request(
			"/v1/billing_portal/sessions",
			"POST",
			new URLSearchParams({
				customer: input.customerId,
				return_url: input.returnUrl,
			}),
			input.idempotencyKey,
		);
		return { id: String(value.id), url: String(value.url) };
	}

	async retrieveSubscription(id: string) {
		return subscription(
			await this.request(`/v1/subscriptions/${encodeURIComponent(id)}`, "GET"),
		);
	}

	async updateSubscription(
		input: Parameters<BillingProvider["updateSubscription"]>[0],
	) {
		const body = new URLSearchParams();
		if (input.priceId) body.set("items[0][price]", input.priceId);
		if (input.cancelAtPeriodEnd !== undefined)
			body.set("cancel_at_period_end", String(input.cancelAtPeriodEnd));
		return subscription(
			await this.request(
				`/v1/subscriptions/${encodeURIComponent(input.id)}`,
				"POST",
				body,
				input.idempotencyKey,
			),
		);
	}
}

export function verifyStripeWebhook(
	raw: Buffer,
	header: string,
	secret: string,
	now = new Date(),
	toleranceSeconds = 300,
): void {
	const values = Object.fromEntries(
		header.split(",").map((part) => {
			const [key, ...rest] = part.split("=");
			return [key, rest.join("=")];
		}),
	);
	const timestamp = Number(values.t);
	const signature = values.v1;
	if (
		!Number.isFinite(timestamp) ||
		!signature ||
		!/^[0-9a-f]{64}$/.test(signature)
	)
		throw new Error("Stripe webhook signature is malformed.");
	if (Math.abs(now.getTime() / 1_000 - timestamp) > toleranceSeconds)
		throw new Error("Stripe webhook signature is stale.");
	const expected = createHmac("sha256", secret)
		.update(`${timestamp}.`)
		.update(raw)
		.digest();
	const actual = Buffer.from(signature, "hex");
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		throw new Error("Stripe webhook signature is invalid.");
}
