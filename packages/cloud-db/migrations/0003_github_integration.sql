ALTER TABLE metric_events RENAME COLUMN metric TO name;
ALTER TABLE metric_events RENAME COLUMN observed_at TO recorded_at;
ALTER TABLE metric_events ADD COLUMN organization_id uuid REFERENCES organizations(id);

CREATE TABLE github_installations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  github_installation_id bigint NOT NULL UNIQUE,
  github_account_id bigint NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('User','Organization','Enterprise','Bot')),
  permissions jsonb NOT NULL DEFAULT '{}',
  repository_selection text NOT NULL CHECK (repository_selection IN ('all','selected')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','ACTIVE','SUSPENDED','UNINSTALLED')),
  installed_at timestamptz,
  suspended_at timestamptz,
  uninstalled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, github_account_id)
);

ALTER TABLE repositories ADD COLUMN github_installation_id uuid REFERENCES github_installations(id);
ALTER TABLE repositories ADD COLUMN full_name text;
ALTER TABLE repositories ADD COLUMN clone_url text;
ALTER TABLE repositories ADD COLUMN html_url text;
CREATE UNIQUE INDEX repositories_github_external_unique ON repositories(provider, external_id) WHERE provider='github';

CREATE TABLE github_webhook_deliveries (
  id uuid PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  action text,
  github_installation_id bigint,
  organization_id uuid REFERENCES organizations(id),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('RECEIVED','QUEUED','PROCESSING','PROCESSED','IGNORED','FAILED')),
  failure_code text,
  failure_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_trigger_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  benchmark_version_id uuid NOT NULL REFERENCES benchmark_versions(id),
  enabled boolean NOT NULL DEFAULT true,
  policy jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_id, benchmark_version_id)
);

ALTER TABLE benchmark_runs ADD COLUMN trigger_provenance jsonb;

CREATE TABLE github_check_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  benchmark_run_id uuid NOT NULL UNIQUE REFERENCES benchmark_runs(id),
  github_check_run_id bigint NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  status text NOT NULL CHECK (status IN ('queued','in_progress','completed')),
  conclusion text CHECK (conclusion IN ('success','failure','neutral','cancelled','timed_out','action_required','skipped','stale')),
  pull_request_number integer CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_id, github_check_run_id)
);

CREATE TABLE github_managed_comments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  pull_request_number integer NOT NULL CHECK (pull_request_number > 0),
  github_comment_id bigint NOT NULL,
  marker text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_id, pull_request_number, marker)
);

CREATE TABLE github_oidc_trusts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  github_repository_id bigint NOT NULL,
  issuer text NOT NULL DEFAULT 'https://token.actions.githubusercontent.com',
  audience text NOT NULL,
  allowed_refs text[] NOT NULL DEFAULT '{}',
  workflow_pattern text,
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, github_repository_id, audience)
);

CREATE TABLE github_oidc_replays (
  issuer text NOT NULL,
  token_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer, token_id)
);

CREATE TABLE github_action_credentials (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_deliveries_state_idx ON github_webhook_deliveries(state, received_at);
CREATE INDEX github_installations_org_idx ON github_installations(organization_id, state);
