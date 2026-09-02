import { randomUUID } from "node:crypto";
import type {
	BillingInterval,
	BillingPlan,
	BillingProvider,
	ProviderSubscription,
} from "@repoarena/billing-stripe";
import { verifyStripeWebhook } from "@repoarena/billing-stripe";
import type { CloudService, Principal } from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { RepoArenaError } from "@repoarena/core";

export type BillingStatus =
	| "TRIALING"
	| "ACTIVE"
	| "PAST_DUE"
	| "INCOMPLETE"
	| "INCOMPLETE_EXPIRED"
	| "PAUSED"
	| "UNPAID"
	| "CANCELLED";

export type PriceCatalog = Readonly<
	Record<BillingPlan, Readonly<Partial<Record<BillingInterval, string>>>>
>;

export const canonicalBillingStatus = (status: string): BillingStatus => {
	const normalized = status.toUpperCase();
	if (normalized === "CANCELED") return "CANCELLED";
	if (
		[
			"TRIALING",
			"ACTIVE",
			"PAST_DUE",
			"INCOMPLETE",
			"INCOMPLETE_EXPIRED",
			"PAUSED",
			"UNPAID",
			"CANCELLED",
		].includes(normalized)
	)
		return normalized as BillingStatus;
	throw new RepoArenaError("CONFIG_INVALID", "Unsupported billing status.");
};

export const entitledPlan = (
	plan: BillingPlan,
	status: BillingStatus,
): BillingPlan | "COMMUNITY" =>
	["TRIALING", "ACTIVE", "PAST_DUE"].includes(status) ? plan : "COMMUNITY";

type StripeEvent = {
	id: string;
	type: string;
	created: number;
	data: { object: Record<string, unknown> };
};

const safeEvent = (event: StripeEvent) => {
	const object = event.data.object;
	const allowed = [
		"id",
		"customer",
		"subscription",
		"status",
		"created",
		"current_period_start",
		"current_period_end",
		"trial_end",
		"cancel_at_period_end",
		"canceled_at",
		"amount_paid",
		"amount_due",
		"currency",
		"hosted_invoice_url",
		"period_start",
		"period_end",
	];
	return Object.fromEntries(
		allowed.flatMap((key) => (key in object ? [[key, object[key]]] : [])),
	);
};

export class BillingService {
	constructor(
		private readonly database: Database,
		private readonly cloud: CloudService,
		private readonly provider: BillingProvider,
		private readonly prices: PriceCatalog,
		private readonly webhookSecret: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	private price(plan: BillingPlan, interval: BillingInterval): string {
		const value = this.prices[plan]?.[interval];
		if (!value)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Billing price is not configured.",
			);
		return value;
	}

	async checkout(
		actor: Principal,
		input: {
			organizationId: string;
			plan: BillingPlan;
			interval: BillingInterval;
			successUrl: string;
			cancelUrl: string;
			idempotencyKey: string;
		},
	) {
		await this.cloud.authorize(actor, input.organizationId, "BILLING_MANAGE");
		if (actor.type !== "USER")
			throw new RepoArenaError("FORBIDDEN", "Owner session required.");
		const existing = await this.database.query<{
			provider_session_id: string;
			checkout_url: string;
		}>(
			"SELECT provider_session_id,checkout_url FROM billing_checkout_operations WHERE organization_id=$1 AND idempotency_key=$2",
			[input.organizationId, input.idempotencyKey],
		);
		if (existing.rows[0])
			return {
				id: existing.rows[0].provider_session_id,
				url: existing.rows[0].checkout_url,
				replay: true,
			};
		const customer = await this.database.transaction(async (client) => {
			await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
				input.organizationId,
			]);
			const found = await client.query<{
				id: string;
				provider_customer_id: string;
			}>(
				"SELECT id,provider_customer_id FROM billing_customers WHERE organization_id=$1",
				[input.organizationId],
			);
			if (found.rows[0]) return found.rows[0];
			const created = await this.provider.createCustomer({
				organizationId: input.organizationId,
				idempotencyKey: `customer-${input.organizationId}`,
			});
			const id = randomUUID();
			await client.query(
				"INSERT INTO billing_customers(id,organization_id,provider,provider_customer_id) VALUES($1,$2,'STRIPE',$3)",
				[id, input.organizationId, created.id],
			);
			return { id, provider_customer_id: created.id };
		});
		const session = await this.provider.createCheckout({
			customerId: customer.provider_customer_id,
			priceId: this.price(input.plan, input.interval),
			organizationId: input.organizationId,
			successUrl: input.successUrl,
			cancelUrl: input.cancelUrl,
			idempotencyKey: `checkout-${input.organizationId}-${input.idempotencyKey}`,
		});
		await this.database.transaction(async (client) => {
			await client.query(
				"INSERT INTO billing_checkout_operations(id,organization_id,idempotency_key,plan_id,billing_interval,provider_session_id,checkout_url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,idempotency_key) DO NOTHING",
				[
					randomUUID(),
					input.organizationId,
					input.idempotencyKey,
					input.plan,
					input.interval,
					session.id,
					session.url,
				],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'USER',$3,'billing.checkout_initiated','organization',$2,$4)",
				[
					randomUUID(),
					input.organizationId,
					actor.userId,
					{ plan: input.plan, interval: input.interval },
				],
			);
		});
		return { ...session, replay: false };
	}

	async portal(actor: Principal, organizationId: string, returnUrl: string) {
		await this.cloud.authorize(actor, organizationId, "BILLING_MANAGE");
		if (actor.type !== "USER")
			throw new RepoArenaError("FORBIDDEN", "Owner session required.");
		const customer = await this.database.query<{
			provider_customer_id: string;
		}>(
			"SELECT provider_customer_id FROM billing_customers WHERE organization_id=$1",
			[organizationId],
		);
		if (!customer.rows[0])
			throw new RepoArenaError("NOT_FOUND", "Billing customer is unavailable.");
		const session = await this.provider.createPortal({
			customerId: customer.rows[0].provider_customer_id,
			returnUrl,
			idempotencyKey: `portal-${organizationId}-${randomUUID()}`,
		});
		await this.database.query(
			"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'USER',$3,'billing.portal_opened','organization',$2,'{}')",
			[randomUUID(), organizationId, actor.userId],
		);
		return session;
	}

	async ingest(raw: Buffer, signature: string) {
		try {
			verifyStripeWebhook(raw, signature, this.webhookSecret, this.now());
		} catch {
			throw new RepoArenaError(
				"FORBIDDEN",
				"Billing webhook signature is invalid.",
			);
		}
		let event: StripeEvent;
		try {
			event = JSON.parse(raw.toString("utf8")) as StripeEvent;
		} catch {
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Billing webhook JSON is invalid.",
			);
		}
		if (
			!event.id ||
			!event.type ||
			!Number.isFinite(event.created) ||
			!event.data?.object
		)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Billing webhook event is invalid.",
			);
		const inserted = await this.database.transaction(async (client) => {
			const result = await client.query<{ id: string }>(
				"INSERT INTO billing_webhook_events(id,provider_event_id,event_type,provider_created_at,state,provider_customer_id,provider_subscription_id,safe_payload) VALUES($1,$2,$3,$4,'QUEUED',$5,$6,$7) ON CONFLICT(provider_event_id) DO NOTHING RETURNING id",
				[
					randomUUID(),
					event.id,
					event.type,
					new Date(event.created * 1_000),
					String(event.data.object.customer ?? event.data.object.id ?? "") ||
						null,
					String(
						event.data.object.subscription ??
							(event.type.startsWith("customer.subscription")
								? event.data.object.id
								: ""),
					) || null,
					safeEvent(event),
				],
			);
			if (!result.rows[0]) return false;
			await client.query(
				"INSERT INTO jobs(id,organization_id,type,payload,state,max_attempts) SELECT $1,organization_id,'BILLING_WEBHOOK',$2,'QUEUED',8 FROM billing_customers WHERE provider_customer_id=$3",
				[
					randomUUID(),
					{ provider_event_id: event.id },
					String(event.data.object.customer ?? ""),
				],
			);
			return true;
		});
		return { eventId: event.id, duplicate: !inserted };
	}

	async processEvent(providerEventId: string) {
		const claimed = await this.database.query<{
			attempts: number;
			event_type: string;
			provider_created_at: Date;
			provider_customer_id: string | null;
			provider_subscription_id: string | null;
			safe_payload: Record<string, unknown>;
		}>(
			"UPDATE billing_webhook_events SET state='PROCESSING',attempts=attempts+1,updated_at=now() WHERE provider_event_id=$1 AND state IN ('QUEUED','FAILED') RETURNING attempts,event_type,provider_created_at,provider_customer_id,provider_subscription_id,safe_payload",
			[providerEventId],
		);
		const event = claimed.rows[0];
		if (!event) return { processed: false };
		const supported =
			event.event_type.startsWith("customer.subscription.") ||
			event.event_type.startsWith("invoice.") ||
			event.event_type === "checkout.session.completed";
		if (!supported) {
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE billing_webhook_events SET state='IGNORED',processed_at=now() WHERE provider_event_id=$1",
					[providerEventId],
				);
				await client.query(
					"UPDATE jobs SET state='SUCCEEDED',completed_at=now(),updated_at=now() WHERE type='BILLING_WEBHOOK' AND payload->>'provider_event_id'=$1 AND state NOT IN ('SUCCEEDED','CANCELLED')",
					[providerEventId],
				);
			});
			return { processed: true, ignored: true };
		}
		try {
			const subscriptionId = event.provider_subscription_id;
			if (subscriptionId) {
				const current =
					await this.provider.retrieveSubscription(subscriptionId);
				await this.reconcileSubscription(
					current,
					providerEventId,
					event.provider_created_at,
				);
			}
			if (event.event_type.startsWith("invoice."))
				await this.persistInvoice(event.safe_payload);
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE billing_webhook_events SET state='PROCESSED',processed_at=now(),failure_code=NULL,updated_at=now() WHERE provider_event_id=$1",
					[providerEventId],
				);
				await client.query(
					"UPDATE jobs SET state='SUCCEEDED',completed_at=now(),updated_at=now() WHERE type='BILLING_WEBHOOK' AND payload->>'provider_event_id'=$1 AND state NOT IN ('SUCCEEDED','CANCELLED')",
					[providerEventId],
				);
			});
			return { processed: true, ignored: false };
		} catch (error) {
			const terminal = event.attempts >= 8;
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE billing_webhook_events SET state=$2,failure_code='BILLING_RECONCILIATION_FAILED',updated_at=now() WHERE provider_event_id=$1",
					[providerEventId, terminal ? "DEAD_LETTER" : "FAILED"],
				);
				await client.query(
					"UPDATE jobs SET state=$2,attempt_count=attempt_count+1,available_at=CASE WHEN $2='QUEUED' THEN now()+(least(300,attempt_count*attempt_count)::text||' seconds')::interval ELSE available_at END,final_error_code=$3,final_error_message=$4,completed_at=CASE WHEN $2='DEAD_LETTER' THEN now() ELSE completed_at END,updated_at=now() WHERE type='BILLING_WEBHOOK' AND payload->>'provider_event_id'=$1 AND state NOT IN ('SUCCEEDED','CANCELLED')",
					[
						providerEventId,
						terminal ? "DEAD_LETTER" : "QUEUED",
						"BILLING_RECONCILIATION_FAILED",
						"Billing provider reconciliation failed.",
					],
				);
			});
			throw error;
		}
	}

	async processQueued(
		limit = 25,
	): Promise<{ processed: number; failed: number }> {
		const queued = await this.database.query<{ provider_event_id: string }>(
			"SELECT e.provider_event_id FROM billing_webhook_events e JOIN jobs j ON j.type='BILLING_WEBHOOK' AND j.payload->>'provider_event_id'=e.provider_event_id WHERE e.state IN ('QUEUED','FAILED') AND j.state='QUEUED' AND j.available_at<=now() ORDER BY j.priority DESC,j.created_at,j.id LIMIT $1",
			[limit],
		);
		let processed = 0;
		let failed = 0;
		for (const event of queued.rows) {
			try {
				const result = await this.processEvent(event.provider_event_id);
				if (result.processed) processed++;
			} catch {
				failed++;
			}
		}
		return { processed, failed };
	}

	private async persistInvoice(payload: Record<string, unknown>) {
		const invoiceId = String(payload.id ?? "");
		const customerId = String(payload.customer ?? "");
		const currency = String(payload.currency ?? "").toLowerCase();
		if (!invoiceId || !customerId || !/^[a-z]{3}$/.test(currency))
			throw new RepoArenaError("CONFIG_INVALID", "Invoice payload is invalid.");
		const total = Number(payload.amount_paid ?? payload.amount_due ?? 0);
		if (!Number.isSafeInteger(total) || total < 0)
			throw new RepoArenaError("CONFIG_INVALID", "Invoice total is invalid.");
		const timestamp = (value: unknown) =>
			typeof value === "number" && Number.isFinite(value)
				? new Date(value * 1_000)
				: null;
		const hosted =
			typeof payload.hosted_invoice_url === "string" &&
			payload.hosted_invoice_url.startsWith("https://")
				? payload.hosted_invoice_url
				: null;
		await this.database.query(
			"INSERT INTO billing_invoices(id,organization_id,billing_subscription_id,provider_invoice_id,status,total_minor,currency,period_start,period_end,hosted_invoice_url) SELECT $1,c.organization_id,s.id,$2,$3,$4,$5,$6,$7,$8 FROM billing_customers c LEFT JOIN billing_subscriptions s ON s.organization_id=c.organization_id WHERE c.provider_customer_id=$9 ON CONFLICT(provider_invoice_id) DO UPDATE SET status=excluded.status,total_minor=excluded.total_minor,currency=excluded.currency,period_start=excluded.period_start,period_end=excluded.period_end,hosted_invoice_url=excluded.hosted_invoice_url,updated_at=now()",
			[
				randomUUID(),
				invoiceId,
				String(payload.status ?? "unknown"),
				total,
				currency,
				timestamp(payload.period_start),
				timestamp(payload.period_end),
				hosted,
				customerId,
			],
		);
	}

	private mapping(priceId: string): {
		plan: BillingPlan;
		interval: BillingInterval;
	} {
		for (const plan of ["PRO", "TEAM"] as const)
			for (const interval of ["MONTHLY", "YEARLY"] as const)
				if (this.prices[plan]?.[interval] === priceId)
					return { plan, interval };
		throw new RepoArenaError(
			"CONFIG_INVALID",
			"Stripe price is not mapped to a RepoArena plan.",
		);
	}

	async reconcileSubscription(
		value: ProviderSubscription,
		eventId = `reconcile-${randomUUID()}`,
		eventCreated = this.now(),
	) {
		const mapping = this.mapping(value.priceId);
		const status = canonicalBillingStatus(value.status);
		return this.database.transaction(async (client) => {
			const customer = await client.query<{
				id: string;
				organization_id: string;
			}>(
				"SELECT id,organization_id FROM billing_customers WHERE provider_customer_id=$1 FOR UPDATE",
				[value.customerId],
			);
			const row = customer.rows[0];
			if (!row)
				throw new RepoArenaError(
					"NOT_FOUND",
					"Billing customer is not linked.",
				);
			const prior = await client.query<{
				provider_event_created_at: Date;
				status: string;
				plan_id: string;
			}>(
				"SELECT provider_event_created_at,status,plan_id FROM billing_subscriptions WHERE organization_id=$1",
				[row.organization_id],
			);
			if (
				prior.rows[0] &&
				prior.rows[0].provider_event_created_at > eventCreated
			)
				return { stale: true, organizationId: row.organization_id };
			const subscription = await client.query<{ id: string }>(
				"INSERT INTO billing_subscriptions(id,organization_id,billing_customer_id,provider,provider_subscription_id,plan_id,provider_price_id,billing_interval,provider_status,status,quantity,current_period_start,current_period_end,trial_end,cancel_at_period_end,cancelled_at,provider_event_created_at,last_provider_event_id) VALUES($1,$2,$3,'STRIPE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(organization_id) DO UPDATE SET provider_subscription_id=excluded.provider_subscription_id,plan_id=excluded.plan_id,provider_price_id=excluded.provider_price_id,billing_interval=excluded.billing_interval,provider_status=excluded.provider_status,status=excluded.status,quantity=excluded.quantity,current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,trial_end=excluded.trial_end,cancel_at_period_end=excluded.cancel_at_period_end,cancelled_at=excluded.cancelled_at,provider_event_created_at=excluded.provider_event_created_at,last_provider_event_id=excluded.last_provider_event_id,updated_at=now() RETURNING id",
				[
					randomUUID(),
					row.organization_id,
					row.id,
					value.id,
					mapping.plan,
					value.priceId,
					mapping.interval,
					value.status,
					status,
					value.quantity,
					value.periodStart,
					value.periodEnd,
					value.trialEnd,
					value.cancelAtPeriodEnd,
					value.cancelledAt,
					eventCreated,
					eventId,
				],
			);
			const subscriptionId = subscription.rows[0]?.id;
			if (!subscriptionId)
				throw new RepoArenaError(
					"INFRASTRUCTURE_FAILED",
					"Subscription persistence failed.",
				);
			const effective = entitledPlan(mapping.plan, status);
			await client.query(
				"UPDATE organizations SET plan_id=$2,updated_at=now() WHERE id=$1",
				[row.organization_id, effective],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'SYSTEM',$2,'billing.subscription_reconciled','subscription',$3,$4)",
				[
					randomUUID(),
					row.organization_id,
					subscriptionId,
					{ plan: mapping.plan, status, effective_plan: effective },
				],
			);
			return {
				stale: false,
				organizationId: row.organization_id,
				plan: effective,
				status,
			};
		});
	}

	async changeSubscription(
		actor: Principal,
		organizationId: string,
		input: {
			plan?: BillingPlan;
			interval?: BillingInterval;
			cancelAtPeriodEnd?: boolean;
			idempotencyKey: string;
		},
	) {
		await this.cloud.authorize(actor, organizationId, "BILLING_MANAGE");
		const existing = await this.database.query<{
			provider_subscription_id: string;
			plan_id: BillingPlan;
			billing_interval: BillingInterval;
		}>(
			"SELECT provider_subscription_id,plan_id,billing_interval FROM billing_subscriptions WHERE organization_id=$1",
			[organizationId],
		);
		const row = existing.rows[0];
		if (!row)
			throw new RepoArenaError("NOT_FOUND", "Subscription is unavailable.");
		const updated = await this.provider.updateSubscription({
			id: row.provider_subscription_id,
			...(input.plan || input.interval
				? {
						priceId: this.price(
							input.plan ?? row.plan_id,
							input.interval ?? row.billing_interval,
						),
					}
				: {}),
			...(input.cancelAtPeriodEnd === undefined
				? {}
				: { cancelAtPeriodEnd: input.cancelAtPeriodEnd }),
			idempotencyKey: `subscription-${organizationId}-${input.idempotencyKey}`,
		});
		return this.reconcileSubscription(updated);
	}

	async getBilling(
		actor: Principal,
		organizationId: string,
	): Promise<{
		plan: string;
		subscription: Record<string, unknown> | null;
		invoices: Record<string, unknown>[];
	}> {
		await this.cloud.authorize(actor, organizationId, "BILLING_MANAGE");
		const organization = await this.database.query<{ plan_id: string }>(
			"SELECT plan_id FROM organizations WHERE id=$1",
			[organizationId],
		);
		const subscription = await this.database.query(
			"SELECT plan_id,billing_interval,status,current_period_end,trial_end,cancel_at_period_end,quantity FROM billing_subscriptions WHERE organization_id=$1",
			[organizationId],
		);
		const invoices = await this.database.query(
			"SELECT provider_invoice_id,status,total_minor,currency,period_start,period_end,hosted_invoice_url,created_at FROM billing_invoices WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50",
			[organizationId],
		);
		return {
			plan: organization.rows[0]?.plan_id ?? "COMMUNITY",
			subscription: (subscription.rows[0] as Record<string, unknown>) ?? null,
			invoices: invoices.rows as Record<string, unknown>[],
		};
	}
}
