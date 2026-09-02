import { StripeProvider } from "../packages/billing-stripe/dist/index.js";

if (process.env.REPOARENA_REAL_STRIPE_TESTS !== "1")
	throw new Error(
		"Set REPOARENA_REAL_STRIPE_TESTS=1 for the opt-in test-mode smoke.",
	);
if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"))
	throw new Error("Only an explicit Stripe test-mode secret key is accepted.");
if (!process.env.STRIPE_TEST_SUBSCRIPTION_ID?.startsWith("sub_"))
	throw new Error(
		"STRIPE_TEST_SUBSCRIPTION_ID must identify the dedicated test subscription.",
	);

const subscription = await new StripeProvider(
	process.env.STRIPE_SECRET_KEY,
).retrieveSubscription(process.env.STRIPE_TEST_SUBSCRIPTION_ID);
process.stdout.write(
	`${JSON.stringify({ id: subscription.id, status: subscription.status, customer: subscription.customerId })}\n`,
);
