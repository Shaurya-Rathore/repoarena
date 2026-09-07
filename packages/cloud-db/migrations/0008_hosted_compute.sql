ALTER TABLE runners ADD COLUMN IF NOT EXISTS hosted_execution_lease_id uuid;

CREATE TABLE hosted_resource_classes (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  vcpu integer NOT NULL CHECK (vcpu > 0),
  memory_mb integer NOT NULL CHECK (memory_mb > 0),
  ephemeral_disk_mb integer NOT NULL CHECK (ephemeral_disk_mb > 0),
  max_wall_time_ms bigint NOT NULL CHECK (max_wall_time_ms > 0),
  max_processes integer NOT NULL CHECK (max_processes > 0),
  max_log_bytes bigint NOT NULL CHECK (max_log_bytes > 0),
  max_artifact_bytes bigint NOT NULL CHECK (max_artifact_bytes > 0),
  network_modes text[] NOT NULL,
  pricing_version text NOT NULL,
  rate_micros_per_minute bigint CHECK (rate_micros_per_minute >= 0),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id, version)
);

INSERT INTO hosted_resource_classes(id,version,vcpu,memory_mb,ephemeral_disk_mb,max_wall_time_ms,max_processes,max_log_bytes,max_artifact_bytes,network_modes,pricing_version,rate_micros_per_minute) VALUES
 ('SMALL',1,2,4096,10240,1800000,256,10485760,104857600,ARRAY['NETWORK_DISABLED'],'2026-09-v1',12000),
 ('MEDIUM',1,4,8192,20480,3600000,512,20971520,262144000,ARRAY['NETWORK_DISABLED','RESTRICTED_EGRESS'],'2026-09-v1',24000),
 ('LARGE',1,8,16384,40960,3600000,1024,41943040,524288000,ARRAY['NETWORK_DISABLED','RESTRICTED_EGRESS'],'2026-09-v1',48000)
ON CONFLICT DO NOTHING;

CREATE TABLE hosted_compute_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT false,
  environment text NOT NULL DEFAULT 'development',
  deployment_id text NOT NULL DEFAULT 'local',
  global_max_active integer NOT NULL DEFAULT 0 CHECK (global_max_active >= 0),
  global_max_queued integer NOT NULL DEFAULT 0 CHECK (global_max_queued >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hosted_compute_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE organization_hosted_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  suspended_at timestamptz,
  max_concurrency integer NOT NULL CHECK (max_concurrency >= 0),
  max_queued integer NOT NULL CHECK (max_queued >= 0),
  monthly_budget_micros bigint CHECK (monthly_budget_micros >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hosted_execution_leases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  runner_id uuid REFERENCES runners(id),
  provider text NOT NULL,
  provider_resource_id text UNIQUE,
  resource_class_id text NOT NULL,
  resource_class_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('REQUESTED','PROVISIONING','BOOTSTRAPPING','READY','CLAIMED','RUNNING','TERMINATING','TERMINATED','FAILED','ORPHANED')),
  failure_code text,
  safe_failure_message text,
  managed_identity jsonb NOT NULL,
  network_policy text NOT NULL CHECK (network_policy IN ('NETWORK_DISABLED','RESTRICTED_EGRESS')),
  max_wall_time_ms bigint NOT NULL CHECK (max_wall_time_ms > 0),
  pricing_snapshot jsonb NOT NULL,
  estimated_cost_micros bigint CHECK (estimated_cost_micros >= 0),
  reserved_cost_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_micros >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  provisioned_at timestamptz,
  ready_at timestamptz,
  execution_started_at timestamptz,
  termination_requested_at timestamptz,
  terminated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(resource_class_id, resource_class_version) REFERENCES hosted_resource_classes(id,version)
);
CREATE INDEX hosted_execution_active_idx ON hosted_execution_leases(state,requested_at);
CREATE INDEX hosted_execution_org_idx ON hosted_execution_leases(organization_id,state,requested_at);

ALTER TABLE runners ADD CONSTRAINT runners_hosted_lease_fk FOREIGN KEY(hosted_execution_lease_id) REFERENCES hosted_execution_leases(id);
CREATE UNIQUE INDEX runners_one_hosted_lease_idx ON runners(hosted_execution_lease_id) WHERE hosted_execution_lease_id IS NOT NULL;

CREATE TABLE hosted_compute_usage (
  id uuid PRIMARY KEY,
  hosted_execution_lease_id uuid NOT NULL UNIQUE REFERENCES hosted_execution_leases(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  provider text NOT NULL,
  resource_class_id text NOT NULL,
  resource_class_version integer NOT NULL,
  provisioned_at timestamptz,
  ready_at timestamptz,
  execution_started_at timestamptz,
  execution_ended_at timestamptz,
  terminated_at timestamptz,
  billable_duration_ms bigint NOT NULL CHECK (billable_duration_ms >= 0),
  provider_observed jsonb NOT NULL DEFAULT '{}',
  pricing_snapshot jsonb NOT NULL,
  cost_micros bigint CHECK (cost_micros >= 0),
  final_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

UPDATE plans SET entitlements = entitlements ||
 CASE id
  WHEN 'ENTERPRISE' THEN '{"max_hosted_concurrency":4,"allowed_hosted_resource_classes":["SMALL","MEDIUM","LARGE"],"max_hosted_wall_time_ms":3600000}'::jsonb
  ELSE '{"max_hosted_concurrency":0,"allowed_hosted_resource_classes":[],"max_hosted_wall_time_ms":0}'::jsonb
 END;
