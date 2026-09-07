import { HttpHostedComputeProvider } from "../packages/hosted-compute/dist/index.js";
if (process.env.REPOARENA_REAL_HOSTED_COMPUTE_TESTS !== "1")
	throw new Error(
		"Set REPOARENA_REAL_HOSTED_COMPUTE_TESTS=1 for the opt-in smoke test",
	);
if (process.env.HOSTED_COMPUTE_TEST_ENVIRONMENT !== "test")
	throw new Error(
		"Live hosted smoke requires HOSTED_COMPUTE_TEST_ENVIRONMENT=test",
	);
if (
	!process.env.HOSTED_COMPUTE_PROVISIONER_URL ||
	!process.env.HOSTED_COMPUTE_PROVISIONER_TOKEN
)
	throw new Error("Test provisioner configuration is required");
const provider = new HttpHostedComputeProvider(
	process.env.HOSTED_COMPUTE_PROVISIONER_URL,
	process.env.HOSTED_COMPUTE_PROVISIONER_TOKEN,
);
const lease = `smoke-${crypto.randomUUID()}`;
const resource = await provider.provision({
	idempotencyKey: lease,
	leaseId: lease,
	resourceClass: {
		id: "SMALL",
		version: 1,
		vcpu: 2,
		memoryMb: 4096,
		ephemeralDiskMb: 10240,
		maxWallTimeMs: 300000,
		maxProcesses: 256,
		maxLogBytes: 10485760,
		maxArtifactBytes: 104857600,
		networkModes: ["NETWORK_DISABLED"],
		pricingVersion: "smoke",
		rateMicrosPerMinute: null,
	},
	maxWallTimeMs: 300000,
	networkPolicy: "NETWORK_DISABLED",
	labels: {
		managed_by: "repoarena",
		environment: "test",
		deployment_id: process.env.HOSTED_COMPUTE_TEST_DEPLOYMENT ?? "smoke",
		lease_id: lease,
	},
	bootstrapToken: `rah_${crypto.randomUUID()}`,
});
try {
	process.stdout.write(`Provisioned test resource ${resource.id}\n`);
} finally {
	await provider.terminate(resource.id, true);
}
