import { readFile } from "node:fs/promises";
import { BillingService } from "../packages/billing/dist/index.js";
import { StripeProvider } from "../packages/billing-stripe/dist/index.js";
import { CloudService } from "../packages/cloud-core/dist/index.js";
import { createDatabase } from "../packages/cloud-db/dist/index.js";

if (!process.env.DATABASE_URL) {
	const local = await readFile(
		new URL("../.env.local", import.meta.url),
		"utf8",
	);
	process.env.DATABASE_URL = local.match(/^DATABASE_URL=(.+)$/m)?.[1];
}
for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
	if (!process.env[name]) throw new Error(`${name} is required.`);

const database = createDatabase();
const billing = new BillingService(
	database,
	new CloudService(database),
	new StripeProvider(process.env.STRIPE_SECRET_KEY),
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
	process.env.STRIPE_WEBHOOK_SECRET,
);
let stopping = false;
process.once("SIGINT", () => {
	stopping = true;
});
process.once("SIGTERM", () => {
	stopping = true;
});
try {
	do {
		const result = await billing.processQueued();
		if (process.env.REPOARENA_BILLING_WEBHOOK_ONCE === "1") break;
		if (result.processed === 0 && result.failed === 0)
			await new Promise((resolve) => setTimeout(resolve, 1_000));
	} while (!stopping);
} finally {
	await database.close();
}
