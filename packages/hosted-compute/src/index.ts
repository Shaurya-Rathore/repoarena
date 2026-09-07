import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudService, Principal } from "@repoarena/cloud-core";
import type { Database } from "@repoarena/cloud-db";
import { RepoArenaError } from "@repoarena/core";

export type HostedState =
	| "REQUESTED"
	| "PROVISIONING"
	| "BOOTSTRAPPING"
	| "READY"
	| "CLAIMED"
	| "RUNNING"
	| "TERMINATING"
	| "TERMINATED"
	| "FAILED"
	| "ORPHANED";
export type HostedFailureCode =
	| "HOSTED_CAPACITY_UNAVAILABLE"
	| "PROVIDER_AUTH_CONFIGURATION"
	| "PROVIDER_QUOTA_EXCEEDED"
	| "PROVIDER_TRANSIENT"
	| "BOOTSTRAP_FAILED"
	| "RUNNER_READY_TIMEOUT"
	| "INSTANCE_CRASH"
	| "EXECUTION_TIMEOUT"
	| "TERMINATION_FAILED"
	| "ORPHAN_CLEANUP_FAILED";
export type NetworkPolicy = "NETWORK_DISABLED" | "RESTRICTED_EGRESS";

export type ResourceClass = Readonly<{
	id: "SMALL" | "MEDIUM" | "LARGE";
	version: number;
	vcpu: number;
	memoryMb: number;
	ephemeralDiskMb: number;
	maxWallTimeMs: number;
	maxProcesses: number;
	maxLogBytes: number;
	maxArtifactBytes: number;
	networkModes: readonly NetworkPolicy[];
	pricingVersion: string;
	rateMicrosPerMinute: number | null;
}>;
export type ManagedResource = Readonly<{
	id: string;
	state: "PROVISIONING" | "READY" | "RUNNING" | "TERMINATED" | "MISSING";
	labels: Readonly<Record<string, string>>;
	observedDurationMs?: number;
}>;
export type ProvisionRequest = Readonly<{
	idempotencyKey: string;
	leaseId: string;
	resourceClass: ResourceClass;
	maxWallTimeMs: number;
	networkPolicy: NetworkPolicy;
	labels: Readonly<Record<string, string>>;
	bootstrapToken: string;
}>;
export interface HostedComputeProvider {
	readonly name: string;
	provision(request: ProvisionRequest): Promise<ManagedResource>;
	inspect(resourceId: string): Promise<ManagedResource>;
	terminate(resourceId: string, force?: boolean): Promise<void>;
	listManaged(
		labels: Readonly<Record<string, string>>,
	): Promise<readonly ManagedResource[]>;
}
type HostedLeaseRow = {
	id: string;
	organization_id: string;
	benchmark_run_id: string;
	job_id: string;
	runner_id: string | null;
	provider: string;
	provider_resource_id: string | null;
	resource_class_id: ResourceClass["id"];
	resource_class_version: number;
	state: HostedState;
	failure_code: HostedFailureCode | null;
	managed_identity: Record<string, string>;
	network_policy: NetworkPolicy;
	max_wall_time_ms: string;
	pricing_snapshot: { version: string; rate_micros_per_minute: number | null };
	provisioned_at: string | null;
	ready_at: string | null;
	execution_started_at: string | null;
	terminated_at: string | null;
	updated_at: string;
	vcpu: number;
	memory_mb: number;
	ephemeral_disk_mb: number;
	max_processes: number;
	max_log_bytes: string;
	max_artifact_bytes: string;
	network_modes: NetworkPolicy[];
	pricing_version: string;
	rate_micros_per_minute: string | null;
};
type HostedSettingsRow = {
	enabled: boolean;
	emergency_stop: boolean;
	environment: string;
	deployment_id: string;
	global_max_active: number;
	global_max_queued: number;
};
type HostedPolicyRow = {
	suspended_at: string | null;
	max_concurrency: number;
	max_queued: number;
	monthly_budget_micros: string | null;
};

export class HostedProviderError extends Error {
	constructor(
		public readonly code: HostedFailureCode,
		message: string,
		public readonly retryable: boolean,
	) {
		super(message);
		this.name = "HostedProviderError";
	}
}

export type DeterministicScenario =
	| "SUCCESS"
	| "DELAYED"
	| "CAPACITY"
	| "TRANSIENT"
	| "PERMANENT"
	| "CRASH"
	| "NO_HEARTBEAT"
	| "TERMINATION_FAILURE";
export class DeterministicHostedComputeProvider
	implements HostedComputeProvider
{
	readonly name = "deterministic";
	readonly resources = new Map<string, ManagedResource>();
	readonly provisionCalls: ProvisionRequest[] = [];
	readonly terminationCalls: string[] = [];
	constructor(public scenario: DeterministicScenario = "SUCCESS") {}
	async provision(request: ProvisionRequest): Promise<ManagedResource> {
		this.provisionCalls.push(request);
		const existing = [...this.resources.values()].find(
			(r) => r.labels.lease_id === request.leaseId,
		);
		if (existing) return existing;
		if (this.scenario === "CAPACITY")
			throw new HostedProviderError(
				"HOSTED_CAPACITY_UNAVAILABLE",
				"Provider capacity is unavailable.",
				true,
			);
		if (this.scenario === "TRANSIENT")
			throw new HostedProviderError(
				"PROVIDER_TRANSIENT",
				"Provider request failed transiently.",
				true,
			);
		if (this.scenario === "PERMANENT")
			throw new HostedProviderError(
				"PROVIDER_AUTH_CONFIGURATION",
				"Provider configuration is invalid.",
				false,
			);
		const resource: ManagedResource = {
			id: `resource-${request.leaseId}`,
			state:
				this.scenario === "DELAYED" || this.scenario === "NO_HEARTBEAT"
					? "PROVISIONING"
					: "READY",
			labels: request.labels,
		};
		this.resources.set(resource.id, resource);
		return resource;
	}
	async inspect(resourceId: string): Promise<ManagedResource> {
		const resource = this.resources.get(resourceId);
		if (!resource || this.scenario === "CRASH")
			return {
				id: resourceId,
				state: "MISSING",
				labels: resource?.labels ?? {},
			};
		return resource;
	}
	async terminate(resourceId: string): Promise<void> {
		this.terminationCalls.push(resourceId);
		if (this.scenario === "TERMINATION_FAILURE")
			throw new HostedProviderError(
				"TERMINATION_FAILED",
				"Provider termination failed transiently.",
				true,
			);
		const resource = this.resources.get(resourceId);
		if (resource)
			this.resources.set(resourceId, { ...resource, state: "TERMINATED" });
	}
	async listManaged(
		labels: Readonly<Record<string, string>>,
	): Promise<readonly ManagedResource[]> {
		return [...this.resources.values()].filter((resource) =>
			Object.entries(labels).every(
				([key, value]) => resource.labels[key] === value,
			),
		);
	}
	addResource(resource: ManagedResource): void {
		this.resources.set(resource.id, resource);
	}
}

export class HttpHostedComputeProvider implements HostedComputeProvider {
	readonly name = "repoarena-provisioner";
	constructor(
		private readonly endpoint: string,
		private readonly credential: string,
		private readonly request: typeof fetch = fetch,
	) {
		if (!endpoint.startsWith("https://"))
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted provider endpoint must use HTTPS.",
			);
		if (!credential)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted provider credential is required.",
			);
	}
	private async call(path: string, init?: RequestInit): Promise<unknown> {
		const response = await this.request(`${this.endpoint}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.credential}`,
				"content-type": "application/json",
				...(init?.headers ?? {}),
			},
		});
		if (!response.ok) {
			const code =
				response.status === 429
					? "PROVIDER_QUOTA_EXCEEDED"
					: response.status >= 500
						? "PROVIDER_TRANSIENT"
						: "PROVIDER_AUTH_CONFIGURATION";
			throw new HostedProviderError(
				code,
				`Hosted provider request failed (${response.status}).`,
				response.status === 429 || response.status >= 500,
			);
		}
		return response.status === 204 ? undefined : response.json();
	}
	async provision(request: ProvisionRequest): Promise<ManagedResource> {
		return (await this.call("/v1/resources", {
			method: "POST",
			headers: { "idempotency-key": request.idempotencyKey },
			body: JSON.stringify(request),
		})) as ManagedResource;
	}
	async inspect(id: string): Promise<ManagedResource> {
		return (await this.call(
			`/v1/resources/${encodeURIComponent(id)}`,
		)) as ManagedResource;
	}
	async terminate(id: string, force = false): Promise<void> {
		await this.call(
			`/v1/resources/${encodeURIComponent(id)}?force=${String(force)}`,
			{ method: "DELETE" },
		);
	}
	async listManaged(
		labels: Readonly<Record<string, string>>,
	): Promise<readonly ManagedResource[]> {
		return (await this.call(
			`/v1/resources?labels=${encodeURIComponent(JSON.stringify(labels))}`,
		)) as readonly ManagedResource[];
	}
}

const activeStates = [
	"PROVISIONING",
	"BOOTSTRAPPING",
	"READY",
	"CLAIMED",
	"RUNNING",
	"TERMINATING",
];
const terminalStates = new Set<HostedState>(["TERMINATED", "FAILED"]);
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const runnerToken = () => {
	const prefix = `rar_${randomBytes(6).toString("hex")}`;
	const plaintext = `${prefix}.${randomBytes(32).toString("base64url")}`;
	return { prefix, plaintext, hash: digest(plaintext) };
};
const safeError = (error: unknown) =>
	error instanceof HostedProviderError
		? { code: error.code, message: error.message, retryable: error.retryable }
		: {
				code: "PROVIDER_TRANSIENT" as const,
				message: "Hosted provider operation failed.",
				retryable: true,
			};

export class HostedComputeService {
	constructor(
		private readonly database: Database,
		private readonly cloud: CloudService,
		private readonly provider: HostedComputeProvider,
		private readonly now: () => Date = () => new Date(),
	) {}

	async resourceClasses(): Promise<readonly ResourceClass[]> {
		const rows = (
			await this.database.query<{
				id: ResourceClass["id"];
				version: number;
				vcpu: number;
				memory_mb: number;
				ephemeral_disk_mb: number;
				max_wall_time_ms: string;
				max_processes: number;
				max_log_bytes: string;
				max_artifact_bytes: string;
				network_modes: NetworkPolicy[];
				pricing_version: string;
				rate_micros_per_minute: string | null;
			}>(
				"SELECT DISTINCT ON(id) * FROM hosted_resource_classes WHERE enabled ORDER BY id,version DESC",
			)
		).rows;
		return rows.map((r) => ({
			id: r.id,
			version: r.version,
			vcpu: r.vcpu,
			memoryMb: r.memory_mb,
			ephemeralDiskMb: r.ephemeral_disk_mb,
			maxWallTimeMs: Number(r.max_wall_time_ms),
			maxProcesses: r.max_processes,
			maxLogBytes: Number(r.max_log_bytes),
			maxArtifactBytes: Number(r.max_artifact_bytes),
			networkModes: r.network_modes,
			pricingVersion: r.pricing_version,
			rateMicrosPerMinute:
				r.rate_micros_per_minute === null
					? null
					: Number(r.rate_micros_per_minute),
		}));
	}

	async preflight(
		actor: Principal,
		input: {
			organizationId: string;
			resourceClassId: ResourceClass["id"];
			maxWallTimeMs: number;
			networkPolicy: NetworkPolicy;
			computeBudgetMicros?: number;
		},
	): Promise<{
		resourceClass: ResourceClass;
		estimatedCostMicros: number | null;
	}> {
		await this.cloud.authorize(actor, input.organizationId, "BENCHMARK_RUN");
		const entitlement = await this.cloud.entitlements(input.organizationId);
		if (!entitlement.hosted_compute)
			throw new RepoArenaError(
				"FORBIDDEN",
				"Hosted compute is unavailable for this organization.",
			);
		const allowed = entitlement.allowed_hosted_resource_classes ?? [];
		if (!allowed.includes(input.resourceClassId))
			throw new RepoArenaError(
				"FORBIDDEN",
				"Hosted resource class is not entitled.",
			);
		const resourceClass = (await this.resourceClasses()).find(
			(item) => item.id === input.resourceClassId,
		);
		if (!resourceClass)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted resource class is unavailable.",
			);
		const ceiling = Math.min(
			resourceClass.maxWallTimeMs,
			entitlement.max_hosted_wall_time_ms ?? 0,
		);
		if (input.maxWallTimeMs <= 0 || input.maxWallTimeMs > ceiling)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted wall-time exceeds server policy.",
			);
		if (!resourceClass.networkModes.includes(input.networkPolicy))
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Network policy is unsupported by resource class.",
			);
		const estimatedCostMicros =
			resourceClass.rateMicrosPerMinute === null
				? null
				: Math.ceil(input.maxWallTimeMs / 60_000) *
					resourceClass.rateMicrosPerMinute;
		if (estimatedCostMicros === null)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted pricing is unknown; provisioning is disabled.",
			);
		if (
			input.computeBudgetMicros === undefined ||
			estimatedCostMicros > input.computeBudgetMicros
		)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted compute budget is insufficient.",
			);
		return { resourceClass, estimatedCostMicros };
	}

	async request(
		actor: Principal,
		input: {
			organizationId: string;
			runId: string;
			jobId: string;
			resourceClassId: ResourceClass["id"];
			maxWallTimeMs: number;
			networkPolicy: NetworkPolicy;
			computeBudgetMicros: number;
		},
	): Promise<{
		leaseId: string;
		replay: boolean;
		estimatedCostMicros: number;
	}> {
		const checked = await this.preflight(actor, input);
		const estimate = checked.estimatedCostMicros;
		if (estimate === null)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted pricing is unknown; provisioning is disabled.",
			);
		return this.database.transaction(async (client) => {
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('repoarena-hosted-capacity'))",
			);
			const replay = await client.query<{
				id: string;
				estimated_cost_micros: string;
			}>(
				"SELECT id,estimated_cost_micros FROM hosted_execution_leases WHERE job_id=$1",
				[input.jobId],
			);
			if (replay.rows[0])
				return {
					leaseId: replay.rows[0].id,
					replay: true,
					estimatedCostMicros: Number(replay.rows[0].estimated_cost_micros),
				};
			const settings = (
				await client.query<{
					enabled: boolean;
					emergency_stop: boolean;
					environment: string;
					deployment_id: string;
					global_max_active: number;
					global_max_queued: number;
				}>(
					"SELECT * FROM hosted_compute_settings WHERE singleton=true FOR UPDATE",
				)
			).rows[0];
			if (!settings?.enabled || settings.emergency_stop)
				throw new RepoArenaError(
					"FORBIDDEN",
					"Hosted compute provisioning is disabled.",
				);
			const policy = (
				await client.query<{
					suspended_at: string | null;
					max_concurrency: number;
					max_queued: number;
					monthly_budget_micros: string | null;
				}>(
					"SELECT * FROM organization_hosted_policies WHERE organization_id=$1 FOR UPDATE",
					[input.organizationId],
				)
			).rows[0];
			if (!policy || policy.suspended_at)
				throw new RepoArenaError(
					"FORBIDDEN",
					"Hosted compute is suspended or not configured for this organization.",
				);
			const counts = (
				await client.query<{ global_queued: string; org_queued: string }>(
					"SELECT count(*) FILTER(WHERE state='REQUESTED')::text global_queued,count(*) FILTER(WHERE organization_id=$1 AND state='REQUESTED')::text org_queued FROM hosted_execution_leases",
					[input.organizationId],
				)
			).rows[0];
			if (
				Number(counts?.global_queued) >= settings.global_max_queued ||
				Number(counts?.org_queued) >= policy.max_queued
			)
				throw new RepoArenaError("RATE_LIMITED", "Hosted queue limit reached.");
			const spent = await client.query<{ cost: string }>(
				"SELECT coalesce(sum(reserved_cost_micros),0)::text cost FROM hosted_execution_leases WHERE organization_id=$1 AND requested_at>=date_trunc('month',now())",
				[input.organizationId],
			);
			if (
				policy.monthly_budget_micros !== null &&
				Number(spent.rows[0]?.cost ?? 0) + estimate >
					Number(policy.monthly_budget_micros)
			)
				throw new RepoArenaError(
					"CONFIG_INVALID",
					"Organization hosted compute budget is exhausted.",
				);
			const leaseId = randomUUID();
			const managed = {
				environment: settings.environment,
				deployment_id: settings.deployment_id,
				lease_id: leaseId,
				managed_by: "repoarena",
			};
			await client.query(
				"INSERT INTO hosted_execution_leases(id,organization_id,benchmark_run_id,job_id,provider,resource_class_id,resource_class_version,state,managed_identity,network_policy,max_wall_time_ms,pricing_snapshot,estimated_cost_micros,reserved_cost_micros) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED',$8,$9,$10,$11,$12,$12)",
				[
					leaseId,
					input.organizationId,
					input.runId,
					input.jobId,
					this.provider.name,
					checked.resourceClass.id,
					checked.resourceClass.version,
					managed,
					input.networkPolicy,
					input.maxWallTimeMs,
					{
						version: checked.resourceClass.pricingVersion,
						rate_micros_per_minute: checked.resourceClass.rateMicrosPerMinute,
					},
					estimate,
				],
			);
			await client.query(
				"UPDATE jobs SET requirements=$2,updated_at=now() WHERE id=$1 AND organization_id=$3 AND state='QUEUED'",
				[
					input.jobId,
					{ hosted_execution_lease_id: leaseId },
					input.organizationId,
				],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,'hosted.requested','hosted_execution',$5,$6)",
				[
					randomUUID(),
					input.organizationId,
					actor.type,
					actor.type === "USER" ? actor.userId : null,
					leaseId,
					{
						resource_class: checked.resourceClass.id,
						estimated_cost_micros: estimate,
					},
				],
			);
			return { leaseId, replay: false, estimatedCostMicros: estimate };
		});
	}

	async provisionNext(): Promise<{
		leaseId: string;
		runnerToken?: string;
	} | null> {
		const lease = await this.database.transaction(async (client) => {
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('repoarena-hosted-capacity'))",
			);
			const row = (
				await client.query<HostedLeaseRow>(
					"SELECT l.*,rc.vcpu,rc.memory_mb,rc.ephemeral_disk_mb,rc.max_processes,rc.max_log_bytes,rc.max_artifact_bytes,rc.network_modes,rc.pricing_version,rc.rate_micros_per_minute FROM hosted_execution_leases l JOIN hosted_resource_classes rc ON rc.id=l.resource_class_id AND rc.version=l.resource_class_version WHERE l.state='REQUESTED' ORDER BY l.requested_at,l.id FOR UPDATE OF l SKIP LOCKED LIMIT 1",
				)
			).rows[0];
			if (!row) return null;
			const settings = (
				await client.query<HostedSettingsRow>(
					"SELECT * FROM hosted_compute_settings WHERE singleton=true FOR UPDATE",
				)
			).rows[0];
			const policy = (
				await client.query<HostedPolicyRow>(
					"SELECT * FROM organization_hosted_policies WHERE organization_id=$1 FOR UPDATE",
					[row.organization_id],
				)
			).rows[0];
			const counts = (
				await client.query<{ global_active: string; org_active: string }>(
					"SELECT count(*) FILTER(WHERE state=ANY($1))::text global_active,count(*) FILTER(WHERE organization_id=$2 AND state=ANY($1))::text org_active FROM hosted_execution_leases",
					[activeStates, row.organization_id],
				)
			).rows[0];
			if (
				!settings?.enabled ||
				settings.emergency_stop ||
				!policy ||
				policy.suspended_at ||
				Number(counts?.global_active) >= settings.global_max_active ||
				Number(counts?.org_active) >= policy.max_concurrency
			)
				return null;
			await client.query(
				"UPDATE hosted_execution_leases SET state='PROVISIONING',updated_at=$2 WHERE id=$1",
				[row.id, this.now()],
			);
			return row;
		});
		if (!lease) return null;
		const bootstrap = `rah_${randomBytes(32).toString("base64url")}`;
		try {
			const resourceClass: ResourceClass = {
				id: lease.resource_class_id,
				version: lease.resource_class_version,
				vcpu: lease.vcpu,
				memoryMb: lease.memory_mb,
				ephemeralDiskMb: lease.ephemeral_disk_mb,
				maxWallTimeMs: Number(lease.max_wall_time_ms),
				maxProcesses: lease.max_processes,
				maxLogBytes: Number(lease.max_log_bytes),
				maxArtifactBytes: Number(lease.max_artifact_bytes),
				networkModes: lease.network_modes,
				pricingVersion: lease.pricing_version,
				rateMicrosPerMinute:
					lease.rate_micros_per_minute === null
						? null
						: Number(lease.rate_micros_per_minute),
			};
			const resource = await this.provider.provision({
				idempotencyKey: lease.id,
				leaseId: lease.id,
				resourceClass,
				maxWallTimeMs: Number(lease.max_wall_time_ms),
				networkPolicy: lease.network_policy,
				labels: lease.managed_identity,
				bootstrapToken: bootstrap,
			});
			const generated = runnerToken();
			const runnerId = randomUUID();
			await this.database.transaction(async (client) => {
				await client.query(
					"INSERT INTO runners(id,organization_id,name,token_prefix,token_hash,capabilities,software_version,hosted_execution_lease_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
					[
						runnerId,
						lease.organization_id,
						`hosted-${lease.id}`,
						generated.prefix,
						generated.hash,
						{ hosted_execution_lease_id: lease.id },
						"hosted-1",
						lease.id,
					],
				);
				await client.query(
					"UPDATE hosted_execution_leases SET state='BOOTSTRAPPING',provider_resource_id=$2,runner_id=$3,provisioned_at=$4::timestamptz,updated_at=$4::timestamptz WHERE id=$1",
					[lease.id, resource.id, runnerId, this.now().toISOString()],
				);
			});
			return { leaseId: lease.id, runnerToken: generated.plaintext };
		} catch (error) {
			const safe = safeError(error);
			await this.database.query(
				"UPDATE hosted_execution_leases SET state=$2,failure_code=$3,safe_failure_message=$4,updated_at=$5 WHERE id=$1",
				[
					lease.id,
					safe.retryable ? "REQUESTED" : "FAILED",
					safe.code,
					safe.message,
					this.now(),
				],
			);
			if (!safe.retryable) await this.finalizeUsage(lease.id, "FAILED");
			return { leaseId: lease.id };
		}
	}
	async runnerHeartbeat(runnerId: string): Promise<void> {
		await this.database.query(
			"UPDATE hosted_execution_leases SET state='READY',ready_at=coalesce(ready_at,$2),updated_at=$2 WHERE runner_id=$1 AND state='BOOTSTRAPPING'",
			[runnerId, this.now()],
		);
	}
	async runnerClaimed(runnerId: string, jobId: string): Promise<void> {
		await this.database.query(
			"UPDATE hosted_execution_leases SET state='RUNNING',execution_started_at=coalesce(execution_started_at,$3),updated_at=$3 WHERE runner_id=$1 AND job_id=$2 AND state IN ('READY','CLAIMED')",
			[runnerId, jobId, this.now()],
		);
	}
	async resultSubmitted(runnerId: string, jobId: string): Promise<void> {
		const row = (
			await this.database.query<{ id: string }>(
				"SELECT id FROM hosted_execution_leases WHERE runner_id=$1 AND job_id=$2",
				[runnerId, jobId],
			)
		).rows[0];
		if (row) await this.complete(row.id);
	}

	async cancel(
		actor: Principal,
		organizationId: string,
		leaseId: string,
	): Promise<void> {
		await this.cloud.authorize(actor, organizationId, "BENCHMARK_RUN");
		const row = (
			await this.database.query<HostedLeaseRow>(
				"SELECT * FROM hosted_execution_leases WHERE id=$1 AND organization_id=$2",
				[leaseId, organizationId],
			)
		).rows[0];
		if (!row)
			throw new RepoArenaError("NOT_FOUND", "Hosted execution not found.");
		if (terminalStates.has(row.state)) return;
		await this.database.query(
			"UPDATE hosted_execution_leases SET state='TERMINATING',termination_requested_at=$2,updated_at=$2 WHERE id=$1",
			[leaseId, this.now()],
		);
		try {
			if (row.provider_resource_id)
				await this.provider.terminate(row.provider_resource_id, true);
			await this.database.transaction(async (client) => {
				await client.query(
					"UPDATE hosted_execution_leases SET state='TERMINATED',terminated_at=$2,updated_at=$2 WHERE id=$1",
					[leaseId, this.now()],
				);
				if (row.runner_id)
					await client.query(
						"UPDATE runners SET state='REVOKED',revoked_at=$2 WHERE id=$1",
						[row.runner_id, this.now()],
					);
				await client.query(
					"UPDATE jobs SET state='CANCELLED',lease_owner=NULL,lease_expires_at=NULL,completed_at=$2,updated_at=$2 WHERE id=$1 AND state NOT IN ('SUCCEEDED','CANCELLED')",
					[row.job_id, this.now()],
				);
				await client.query(
					"UPDATE benchmark_runs SET state='CANCELLED',completed_at=$2,updated_at=$2 WHERE id=$1 AND state NOT IN ('COMPLETED','CANCELLED')",
					[row.benchmark_run_id, this.now()],
				);
			});
			await this.finalizeUsage(leaseId, "CANCELLED");
		} catch (error) {
			const safe = safeError(error);
			await this.database.query(
				"UPDATE hosted_execution_leases SET state='ORPHANED',failure_code=$2,safe_failure_message=$3,updated_at=$4 WHERE id=$1",
				[leaseId, safe.code, safe.message, this.now()],
			);
		}
	}
	async cancelRun(
		actor: Principal,
		organizationId: string,
		runId: string,
	): Promise<boolean> {
		const row = (
			await this.database.query<{ id: string }>(
				"SELECT id FROM hosted_execution_leases WHERE benchmark_run_id=$1 AND organization_id=$2",
				[runId, organizationId],
			)
		).rows[0];
		if (!row) return false;
		await this.cancel(actor, organizationId, row.id);
		return true;
	}

	async finalizeUsage(leaseId: string, finalState: string): Promise<void> {
		await this.database.transaction(async (client) => {
			const row = (
				await client.query<HostedLeaseRow>(
					"SELECT * FROM hosted_execution_leases WHERE id=$1 FOR UPDATE",
					[leaseId],
				)
			).rows[0];
			if (!row) return;
			const existing = await client.query(
				"SELECT 1 FROM hosted_compute_usage WHERE hosted_execution_lease_id=$1",
				[leaseId],
			);
			if (existing.rowCount) return;
			const start = row.provisioned_at
				? new Date(row.provisioned_at).getTime()
				: this.now().getTime();
			const end = row.terminated_at
				? new Date(row.terminated_at).getTime()
				: this.now().getTime();
			const duration = Math.max(0, end - start);
			const rate = row.pricing_snapshot.rate_micros_per_minute as number | null;
			const cost = rate === null ? null : Math.ceil(duration / 60000) * rate;
			await client.query(
				"INSERT INTO hosted_compute_usage(id,hosted_execution_lease_id,organization_id,benchmark_run_id,provider,resource_class_id,resource_class_version,provisioned_at,ready_at,execution_started_at,execution_ended_at,terminated_at,billable_duration_ms,pricing_snapshot,cost_micros,final_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(hosted_execution_lease_id) DO NOTHING",
				[
					randomUUID(),
					row.id,
					row.organization_id,
					row.benchmark_run_id,
					row.provider,
					row.resource_class_id,
					row.resource_class_version,
					row.provisioned_at,
					row.ready_at,
					row.execution_started_at,
					this.now(),
					row.terminated_at,
					duration,
					row.pricing_snapshot,
					cost,
					finalState,
				],
			);
			if (cost !== null)
				await client.query(
					"UPDATE hosted_execution_leases SET reserved_cost_micros=$2 WHERE id=$1",
					[leaseId, cost],
				);
		});
	}

	async setOrganizationSuspended(
		actor: Principal,
		organizationId: string,
		suspended: boolean,
	): Promise<void> {
		await this.cloud.authorize(actor, organizationId, "ORG_MANAGE");
		await this.database.transaction(async (client) => {
			await client.query(
				"UPDATE organization_hosted_policies SET suspended_at=CASE WHEN $2 THEN now() ELSE NULL END,updated_at=now() WHERE organization_id=$1",
				[organizationId, suspended],
			);
			await client.query(
				"INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,'organization',$2,$6)",
				[
					randomUUID(),
					organizationId,
					actor.type,
					actor.type === "USER" ? actor.userId : null,
					suspended ? "hosted.suspended" : "hosted.resumed",
					{ suspended },
				],
			);
		});
	}

	async complete(leaseId: string): Promise<void> {
		const row = (
			await this.database.query<HostedLeaseRow>(
				"SELECT * FROM hosted_execution_leases WHERE id=$1",
				[leaseId],
			)
		).rows[0];
		if (!row || row.state === "TERMINATED") return;
		try {
			if (row.provider_resource_id)
				await this.provider.terminate(row.provider_resource_id);
			await this.database.query(
				"UPDATE hosted_execution_leases SET state='TERMINATED',terminated_at=$2,updated_at=$2 WHERE id=$1",
				[leaseId, this.now()],
			);
			if (row.runner_id)
				await this.database.query(
					"UPDATE runners SET state='REVOKED',revoked_at=$2 WHERE id=$1",
					[row.runner_id, this.now()],
				);
			await this.finalizeUsage(leaseId, "COMPLETED");
		} catch (error) {
			const safe = safeError(error);
			await this.database.query(
				"UPDATE hosted_execution_leases SET state='ORPHANED',failure_code=$2,safe_failure_message=$3,updated_at=$4 WHERE id=$1",
				[leaseId, safe.code, safe.message, this.now()],
			);
		}
	}

	async reconcile(): Promise<{
		terminatedOrphans: number;
		foreignResourcesIgnored: number;
		lost: number;
	}> {
		const settings = (
			await this.database.query<HostedSettingsRow>(
				"SELECT * FROM hosted_compute_settings WHERE singleton=true",
			)
		).rows[0];
		if (!settings)
			throw new RepoArenaError(
				"CONFIG_INVALID",
				"Hosted compute settings are unavailable.",
			);
		const managed = await this.provider.listManaged({
			managed_by: "repoarena",
			environment: settings.environment,
			deployment_id: settings.deployment_id,
		});
		let terminatedOrphans = 0;
		let foreignResourcesIgnored = 0;
		let lost = 0;
		for (const resource of managed) {
			if (
				resource.labels.managed_by !== "repoarena" ||
				resource.labels.environment !== settings.environment ||
				resource.labels.deployment_id !== settings.deployment_id
			) {
				foreignResourcesIgnored++;
				continue;
			}
			const lease = (
				await this.database.query<HostedLeaseRow>(
					"SELECT * FROM hosted_execution_leases WHERE id=$1",
					[resource.labels.lease_id],
				)
			).rows[0];
			if (!lease || terminalStates.has(lease.state)) {
				await this.provider.terminate(resource.id, true);
				terminatedOrphans++;
			} else if (resource.state === "MISSING") {
				await this.database.query(
					"UPDATE hosted_execution_leases SET state='FAILED',failure_code='INSTANCE_CRASH',safe_failure_message='Hosted resource disappeared.',updated_at=$2 WHERE id=$1",
					[lease.id, this.now()],
				);
				await this.finalizeUsage(lease.id, "INFRASTRUCTURE_FAILED");
				lost++;
			}
		}
		for (const lease of (
			await this.database.query<HostedLeaseRow>(
				"SELECT * FROM hosted_execution_leases WHERE state IN ('PROVISIONING','BOOTSTRAPPING','READY','CLAIMED','RUNNING')",
			)
		).rows) {
			const age = this.now().getTime() - new Date(lease.updated_at).getTime();
			const executionAge = lease.execution_started_at
				? this.now().getTime() - new Date(lease.execution_started_at).getTime()
				: 0;
			if (
				lease.provider_resource_id &&
				(await this.provider.inspect(lease.provider_resource_id)).state ===
					"MISSING"
			) {
				await this.database.query(
					"UPDATE hosted_execution_leases SET state='FAILED',failure_code='INSTANCE_CRASH',safe_failure_message='Hosted resource disappeared.',terminated_at=$2,updated_at=$2 WHERE id=$1",
					[lease.id, this.now()],
				);
				await this.finalizeUsage(lease.id, "INFRASTRUCTURE_FAILED");
				lost++;
				continue;
			}
			if (
				lease.state === "RUNNING" &&
				executionAge > Number(lease.max_wall_time_ms)
			) {
				if (lease.provider_resource_id)
					await this.provider.terminate(lease.provider_resource_id, true);
				await this.database.query(
					"UPDATE hosted_execution_leases SET state='FAILED',failure_code='EXECUTION_TIMEOUT',safe_failure_message='Hosted execution exceeded its absolute wall time.',terminated_at=$2,updated_at=$2 WHERE id=$1",
					[lease.id, this.now()],
				);
				if (lease.runner_id)
					await this.database.query(
						"UPDATE runners SET state='REVOKED',revoked_at=$2 WHERE id=$1",
						[lease.runner_id, this.now()],
					);
				await this.finalizeUsage(lease.id, "TIMEOUT");
				lost++;
				continue;
			}
			if (
				(lease.state === "BOOTSTRAPPING" || lease.state === "PROVISIONING") &&
				age > 120000
			) {
				if (lease.provider_resource_id)
					await this.provider.terminate(lease.provider_resource_id, true);
				await this.database.query(
					"UPDATE hosted_execution_leases SET state='FAILED',failure_code='RUNNER_READY_TIMEOUT',safe_failure_message='Hosted runner did not become ready.',terminated_at=$2,updated_at=$2 WHERE id=$1",
					[lease.id, this.now()],
				);
				await this.finalizeUsage(lease.id, "INFRASTRUCTURE_FAILED");
				lost++;
			}
		}
		return { terminatedOrphans, foreignResourcesIgnored, lost };
	}

	async list(actor: Principal, organizationId: string): Promise<unknown[]> {
		await this.cloud.authorize(actor, organizationId, "ORG_READ");
		return (
			await this.database.query(
				"SELECT id,benchmark_run_id,resource_class_id,resource_class_version,state,network_policy,max_wall_time_ms,estimated_cost_micros,requested_at,ready_at,execution_started_at,terminated_at,failure_code FROM hosted_execution_leases WHERE organization_id=$1 ORDER BY requested_at DESC LIMIT 100",
				[organizationId],
			)
		).rows;
	}
	async usage(actor: Principal, organizationId: string): Promise<unknown[]> {
		await this.cloud.authorize(actor, organizationId, "ORG_READ");
		return (
			await this.database.query(
				"SELECT id,benchmark_run_id,resource_class_id,resource_class_version,billable_duration_ms,pricing_snapshot,cost_micros,final_state,created_at FROM hosted_compute_usage WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
				[organizationId],
			)
		).rows;
	}
}
