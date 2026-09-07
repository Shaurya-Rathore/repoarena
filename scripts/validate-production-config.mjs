const env = process.env;
const required = (name) => {
	const value = env[name];
	if (!value)
		throw new Error(`Missing required production configuration: ${name}`);
	return value;
};
const url = (name, protocols) => {
	const value = new URL(required(name));
	if (!protocols.includes(value.protocol))
		throw new Error(`${name} uses an unsupported protocol`);
	return value;
};

url("DATABASE_URL", ["postgres:", "postgresql:"]);
url("REPOARENA_CLOUD_ORIGIN", ["https:"]);
url("CLOUD_API_ORIGIN", ["https:"]);
url("CLOUD_PRODUCT_ORIGIN", ["https:"]);
if (env.DATABASE_SSL !== "require")
	throw new Error("Production requires DATABASE_SSL=require");
if (env.REPOARENA_GITHUB_ENABLED === "true") {
	for (const name of [
		"GITHUB_CLIENT_ID",
		"GITHUB_CLIENT_SECRET",
		"GITHUB_APP_ID",
		"GITHUB_APP_PRIVATE_KEY",
		"GITHUB_WEBHOOK_SECRET",
	])
		required(name);
}
if (env.REPOARENA_BILLING_ENABLED === "true") {
	for (const name of [
		"STRIPE_SECRET_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"STRIPE_PRICE_PRO_MONTHLY",
		"STRIPE_PRICE_PRO_YEARLY",
		"STRIPE_PRICE_TEAM_MONTHLY",
		"STRIPE_PRICE_TEAM_YEARLY",
	])
		required(name);
}
if (env.HOSTED_COMPUTE_ENABLED === "true") {
	url("HOSTED_COMPUTE_PROVISIONER_URL", ["https:"]);
	required("HOSTED_COMPUTE_PROVISIONER_TOKEN");
}
if (env.REPOARENA_S3_ENABLED === "true") {
	required("S3_BUCKET");
	required("S3_REGION");
	required("S3_ACCESS_KEY");
	required("S3_SECRET_KEY");
}
process.stdout.write("PRODUCTION_CONFIG_OK\n");
