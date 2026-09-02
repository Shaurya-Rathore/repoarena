import { BillingService } from "../packages/billing/dist/index.js";
import { StripeProvider } from "../packages/billing-stripe/dist/index.js";
import { CloudService } from "../packages/cloud-core/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";

const subscriptionId = process.argv[2];
if (!process.env.DATABASE_URL || !process.env.STRIPE_SECRET_KEY)
	throw new Error("DATABASE_URL and STRIPE_SECRET_KEY are required.");
if (!subscriptionId?.startsWith("sub_"))
	throw new Error("Usage: pnpm billing:reconcile -- sub_...");

const database = createDatabase();
const provider = new StripeProvider(process.env.STRIPE_SECRET_KEY);
const billing = new BillingService(
	database,
	new CloudService(database),
	provider,
	{
		PRO: {
			MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY,
			YEARLY: process.env.STRIPE_PRICE_PRO_YEARLY,
		},
		TEAM: {
			MONTHLY: process.env.STRIPE_PRICE_TEAM_MONTHLY,
			YEARLY: process.env.STRIPE_PRICE_TEAM_YEARLY,
		},
	},
	process.env.STRIPE_WEBHOOK_SECRET ?? "operator-reconcile-no-webhook",
);
try {
	const result = await billing.reconcileSubscription(
		await provider.retrieveSubscription(subscriptionId),
	);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	await database.close();
}
