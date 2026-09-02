import { createHmac, randomUUID } from "node:crypto";
import type {
	BillingProvider,
	ProviderSubscription,
} from "@repoarena/billing-stripe";
import { CloudService, type Principal } from "@repoarena/cloud-core";
import {
	createDatabase,
	migrate,
	resetTestDatabase,
} from "@repoarena/cloud-db";
import { beforeAll, expect, it } from "vitest";
import { BillingService, type PriceCatalog } from "./index.js";

const source = new URL(process.env.DATABASE_URL ?? "");
source.pathname = "/repoarena_test";
const testUrl = source.toString();
const database = createDatabase({ connectionString: testUrl, max: 16 });
const cloud = new CloudService(database);
const now = new Date("2026-09-03T12:00:00Z");
const webhookSecret = "whsec_billing_security_sentinel";
const prices: PriceCatalog = {
	PRO: { MONTHLY: "price_pro_month", YEARLY: "price_pro_year" },
	TEAM: { MONTHLY: "price_team_month", YEARLY: "price_team_year" },
};

class FakeBillingProvider implements BillingProvider {
	customers = 0;
	checkouts = 0;
	checkoutByKey = new Map<string, { id: string; url: string }>();
	subscriptions = new Map<string, ProviderSubscription>();
	failRetrievals = 0;
	async createCustomer() {
		this.customers++;
		return { id: `cus_${this.customers}` };
	}
	async createCheckout(input: { idempotencyKey: string }) {
		const replay = this.checkoutByKey.get(input.idempotencyKey);
		if (replay) return replay;
		this.checkouts++;
		const session = {
			id: `cs_${this.checkouts}`,
			url: `https://checkout.test/${this.checkouts}`,
		};
		this.checkoutByKey.set(input.idempotencyKey, session);
		return session;
	}
	async createPortal() {
		return { id: "bps_1", url: "https://portal.test/session" };
	}
	async retrieveSubscription(id: string) {
		if (this.failRetrievals-- > 0)
			throw new Error("transient provider failure");
		const value = this.subscriptions.get(id);
		if (!value) throw new Error("subscription missing");
		return value;
	}
	async updateSubscription(input: {
		id: string;
		priceId?: string;
		cancelAtPeriodEnd?: boolean;
	}) {
		const prior = await this.retrieveSubscription(input.id);
		const value = {
			...prior,
			...(input.priceId ? { priceId: input.priceId } : {}),
			...(input.cancelAtPeriodEnd === undefined
				? {}
				: { cancelAtPeriodEnd: input.cancelAtPeriodEnd }),
		};
		this.subscriptions.set(input.id, value);
		return value;
	}
}

const signed = (event: unknown) => {
	const raw = Buffer.from(JSON.stringify(event));
	const timestamp = Math.floor(now.getTime() / 1_000);
	return {
		raw,
		signature: `t=${timestamp},v1=${createHmac("sha256", webhookSecret).update(`${timestamp}.`).update(raw).digest("hex")}`,
	};
};

beforeAll(async () => {
	await resetTestDatabase(database, testUrl);
	await migrate(database);
});

it("connects checkout, verified webhooks, reconciliation, plan changes, grace, cancellation and RBAC", async () => {
	const provider = new FakeBillingProvider();
	const billing = new BillingService(
		database,
		cloud,
		provider,
		prices,
		webhookSecret,
		() => now,
	);
	const ownerId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Owner",
	});
	const owner: Principal = { type: "USER", userId: ownerId };
	const organizationId = await cloud.createOrganization(
		ownerId,
		`billing-${randomUUID().slice(0, 8)}`,
		"Billing Org",
	);
	const memberId = await cloud.createUser({
		provider: "mock",
		subject: randomUUID(),
		displayName: "Member",
	});
	await database.query(
		"INSERT INTO memberships(organization_id,user_id,role,state) VALUES($1,$2,'MEMBER','ACTIVE')",
		[organizationId, memberId],
	);
	const checkoutInput = {
		organizationId,
		plan: "PRO" as const,
		interval: "MONTHLY" as const,
		successUrl: "https://app.test/billing/success",
		cancelUrl: "https://app.test/billing/cancel",
		idempotencyKey: "purchase-1",
	};
	const [first, replay] = await Promise.all([
		billing.checkout(owner, checkoutInput),
		billing.checkout(owner, checkoutInput),
	]);
	expect(first.url).toContain("checkout.test");
	expect(replay.url).toContain("checkout.test");
	expect(provider.customers).toBe(1);
	expect(provider.checkouts).toBe(1);
	await expect(
		billing.checkout(
			{ type: "USER", userId: memberId },
			{ ...checkoutInput, idempotencyKey: "forged" },
		),
	).rejects.toThrow("Permission denied");
	expect((await cloud.entitlements(organizationId)).private_repositories).toBe(
		false,
	);

	const base: ProviderSubscription = {
		id: "sub_1",
		customerId: "cus_1",
		priceId: "price_pro_month",
		status: "active",
		quantity: 1,
		periodStart: new Date("2026-09-01T00:00:00Z"),
		periodEnd: new Date("2026-10-01T00:00:00Z"),
		trialEnd: null,
		cancelAtPeriodEnd: false,
		cancelledAt: null,
	};
	provider.subscriptions.set(base.id, base);
	const event = {
		id: "evt_active",
		type: "customer.subscription.updated",
		created: Math.floor(now.getTime() / 1_000),
		data: {
			object: {
				id: base.id,
				customer: base.customerId,
				status: "active",
				payment_method: "pm_secret_card_fixture",
			},
		},
	};
	const request = signed(event);
	expect(await billing.ingest(request.raw, request.signature)).toEqual({
		eventId: "evt_active",
		duplicate: false,
	});
	expect(await billing.ingest(request.raw, request.signature)).toEqual({
		eventId: "evt_active",
		duplicate: true,
	});
	await billing.processEvent("evt_active");
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	expect((await cloud.entitlements(organizationId)).private_repositories).toBe(
		true,
	);

	provider.subscriptions.set(base.id, { ...base, priceId: "price_team_month" });
	await billing.changeSubscription(owner, organizationId, {
		plan: "TEAM",
		idempotencyKey: "upgrade",
	});
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("TEAM");
	await billing.changeSubscription(owner, organizationId, {
		plan: "PRO",
		idempotencyKey: "downgrade",
	});
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	await billing.changeSubscription(owner, organizationId, {
		cancelAtPeriodEnd: true,
		idempotencyKey: "cancel-at-end",
	});
	expect(
		(await billing.getBilling(owner, organizationId)).subscription,
	).toMatchObject({ cancel_at_period_end: true, status: "ACTIVE" });
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	provider.subscriptions.set(base.id, { ...base, status: "past_due" });
	await billing.reconcileSubscription(
		await provider.retrieveSubscription(base.id),
		"evt_past_due",
		new Date(now.getTime() + 1_000),
	);
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	provider.subscriptions.set(base.id, {
		...base,
		status: "canceled",
		cancelledAt: now,
	});
	await billing.reconcileSubscription(
		await provider.retrieveSubscription(base.id),
		"evt_cancelled",
		new Date(now.getTime() + 2_000),
	);
	expect((await billing.getBilling(owner, organizationId)).plan).toBe(
		"COMMUNITY",
	);
	expect((await cloud.entitlements(organizationId)).private_repositories).toBe(
		false,
	);

	provider.subscriptions.set(base.id, { ...base, status: "past_due" });
	const failedInvoice = {
		id: "evt_invoice_failed",
		type: "invoice.payment_failed",
		created: Math.floor(now.getTime() / 1_000) + 3,
		data: {
			object: {
				id: "in_1",
				customer: base.customerId,
				subscription: base.id,
				status: "open",
				amount_due: 2900,
				currency: "usd",
				hosted_invoice_url: "https://invoice.test/in_1",
			},
		},
	};
	const invoiceRequest = signed(failedInvoice);
	await billing.ingest(invoiceRequest.raw, invoiceRequest.signature);
	provider.failRetrievals = 1;
	await expect(billing.processEvent(failedInvoice.id)).rejects.toThrow(
		"transient provider failure",
	);
	expect(
		(
			await database.query(
				"SELECT state,attempts,failure_code FROM billing_webhook_events WHERE provider_event_id=$1",
				[failedInvoice.id],
			)
		).rows[0],
	).toEqual({
		state: "FAILED",
		attempts: 1,
		failure_code: "BILLING_RECONCILIATION_FAILED",
	});
	await billing.processEvent(failedInvoice.id);
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	expect(
		(await billing.getBilling(owner, organizationId)).invoices[0],
	).toMatchObject({
		provider_invoice_id: "in_1",
		status: "open",
		total_minor: "2900",
		currency: "usd",
	});
	provider.subscriptions.set(base.id, base);
	const paidInvoice = {
		...failedInvoice,
		id: "evt_invoice_paid",
		type: "invoice.paid",
		created: Math.floor(now.getTime() / 1_000) + 4,
		data: {
			object: {
				...failedInvoice.data.object,
				status: "paid",
				amount_paid: 2900,
			},
		},
	};
	const paidRequest = signed(paidInvoice);
	await billing.ingest(paidRequest.raw, paidRequest.signature);
	await billing.processEvent(paidInvoice.id);
	expect((await billing.getBilling(owner, organizationId)).plan).toBe("PRO");
	expect(
		(await billing.getBilling(owner, organizationId)).invoices[0],
	).toMatchObject({ status: "paid" });

	provider.subscriptions.set(base.id, base);
	const stale = await billing.reconcileSubscription(
		base,
		"evt_stale",
		new Date(now.getTime() - 5_000),
	);
	expect(stale.stale).toBe(true);
	const portal = await billing.portal(
		owner,
		organizationId,
		"https://app.test/billing",
	);
	expect(portal.url).toBe("https://portal.test/session");
	await expect(
		billing.portal(
			{ type: "USER", userId: memberId },
			organizationId,
			"https://app.test",
		),
	).rejects.toThrow("Permission denied");

	const stored = JSON.stringify({
		events: (
			await database.query(
				"SELECT provider_event_id,event_type,state,safe_payload FROM billing_webhook_events",
			)
		).rows,
		audit: (
			await database.query(
				"SELECT action,metadata FROM audit_events WHERE organization_id=$1",
				[organizationId],
			)
		).rows,
	});
	for (const forbidden of [
		webhookSecret,
		"pm_secret_card_fixture",
		"sk_test_secret",
		"provider-model-secret",
	])
		expect(stored).not.toContain(forbidden);
	expect(
		(
			await database.query(
				"SELECT count(*)::int AS count FROM billing_subscriptions WHERE organization_id=$1",
				[organizationId],
			)
		).rows[0],
	).toEqual({ count: 1 });
});
