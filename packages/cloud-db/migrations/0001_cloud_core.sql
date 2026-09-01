CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  display_name text NOT NULL,
  email text,
  profile jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SUSPENDED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_subject)
);

CREATE TABLE plans (
  id text PRIMARY KEY CHECK (id IN ('COMMUNITY','PRO','TEAM','ENTERPRISE')),
  entitlements jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text NOT NULL,
  plan_id text NOT NULL REFERENCES plans(id),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','ARCHIVED','DELETING')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(slug)
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, user_id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL,
  external_id text,
  owner_name text NOT NULL,
  repository_name text NOT NULL,
  default_branch text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE','INTERNAL')),
  installation_id text,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, provider, external_id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  task_key text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(repository_id, task_key)
);

CREATE TABLE task_versions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  version integer NOT NULL CHECK (version > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  public_task jsonb NOT NULL,
  validation_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, version), UNIQUE(task_id, content_hash)
);

CREATE TABLE task_private_versions (
  task_version_id uuid PRIMARY KEY REFERENCES task_versions(id),
  encrypted_payload bytea,
  object_key text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((encrypted_payload IS NULL) <> (object_key IS NULL))
);

CREATE TABLE agents (
  id uuid PRIMARY KEY,
  agent_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_versions (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id),
  version text NOT NULL,
  capabilities jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id, version)
);
CREATE TABLE models (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  model_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, model_key)
);
CREATE TABLE model_versions (
  id uuid PRIMARY KEY,
  model_id uuid NOT NULL REFERENCES models(id),
  version text NOT NULL,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_id, version, configuration_hash)
);

CREATE TABLE benchmarks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  name text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE benchmark_versions (
  id uuid PRIMARY KEY,
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  version integer NOT NULL CHECK (version > 0),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(benchmark_id, version), UNIQUE(benchmark_id, config_hash)
);
CREATE TABLE benchmark_version_tasks (
  benchmark_version_id uuid NOT NULL REFERENCES benchmark_versions(id),
  task_version_id uuid NOT NULL REFERENCES task_versions(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY(benchmark_version_id, task_version_id),
  UNIQUE(benchmark_version_id, ordinal)
);

CREATE TABLE runners (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  token_prefix text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  capabilities jsonb NOT NULL,
  software_version text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','REVOKED')),
  last_heartbeat_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, name)
);

CREATE TABLE benchmark_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  benchmark_version_id uuid NOT NULL REFERENCES benchmark_versions(id),
  runner_id uuid REFERENCES runners(id),
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  billing_owner text NOT NULL DEFAULT 'ORGANIZATION_BYOK' CHECK (billing_owner IN ('USER_BYOK','ORGANIZATION_BYOK','REPOARENA_SPONSORED')),
  budget jsonb NOT NULL DEFAULT '{}',
  canonical_result jsonb,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_runs (
  id uuid PRIMARY KEY,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  task_version_id uuid NOT NULL REFERENCES task_versions(id),
  state text NOT NULL,
  canonical_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  task_run_id uuid NOT NULL REFERENCES task_runs(id),
  attempt_index integer NOT NULL CHECK (attempt_index >= 0),
  state text NOT NULL,
  agent_version_id uuid REFERENCES agent_versions(id),
  model_version_id uuid REFERENCES model_versions(id),
  canonical_public_result jsonb,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(task_run_id, attempt_index)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  attempt_id uuid REFERENCES attempts(id),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE','EVALUATOR_PRIVATE')),
  logical_path text NOT NULL CHECK (logical_path <> '' AND logical_path !~ '(^/|(^|/)\.\.(/|$))'),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^org/[0-9a-f-]+/objects/[0-9a-f-]+$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text,
  retention_state text NOT NULL DEFAULT 'ACTIVE' CHECK (retention_state IN ('ACTIVE','EXPIRING','DELETED')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_run_id uuid REFERENCES benchmark_runs(id),
  type text NOT NULL,
  payload_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  requirements jsonb NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('QUEUED','LEASED','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid REFERENCES runners(id),
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  final_error_code text,
  final_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX jobs_claim_idx ON jobs(state, available_at, priority DESC, created_at);

CREATE TABLE schedules (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_version_id uuid NOT NULL REFERENCES benchmark_versions(id),
  cadence text NOT NULL CHECK (cadence IN ('HOURLY','DAILY','WEEKLY')),
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE schedule_occurrences (
  schedule_id uuid NOT NULL REFERENCES schedules(id),
  occurrence_at timestamptz NOT NULL,
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(schedule_id, occurrence_at)
);

CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  scope text NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, scope, key_hash)
);
CREATE TABLE job_credentials (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  runner_id uuid NOT NULL REFERENCES runners(id),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  benchmark_run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  attempt_id uuid REFERENCES attempts(id),
  usage_type text NOT NULL,
  provider text,
  model text,
  quantity jsonb NOT NULL,
  cost_snapshot jsonb,
  billing_owner text NOT NULL CHECK (billing_owner IN ('USER_BYOK','ORGANIZATION_BYOK','REPOARENA_SPONSORED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(benchmark_run_id, attempt_id, usage_type)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  actor_type text NOT NULL CHECK (actor_type IN ('USER','API_KEY','RUNNER','SYSTEM')),
  actor_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit_events(organization_id, created_at DESC, id DESC);
CREATE TABLE rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans(id, entitlements) VALUES
('COMMUNITY', '{"private_repositories":false,"scheduled_runs":false,"max_schedules":0,"max_runners":1,"api_access":false,"max_members":1,"hosted_compute":false}'),
('PRO', '{"private_repositories":true,"scheduled_runs":true,"max_schedules":5,"max_runners":2,"api_access":true,"max_members":1,"hosted_compute":false}'),
('TEAM', '{"private_repositories":true,"scheduled_runs":true,"max_schedules":25,"max_runners":10,"api_access":true,"max_members":50,"hosted_compute":false}'),
('ENTERPRISE', '{"private_repositories":true,"scheduled_runs":true,"max_schedules":1000,"max_runners":1000,"api_access":true,"max_members":10000,"hosted_compute":true}');
