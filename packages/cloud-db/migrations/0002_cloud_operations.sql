ALTER TABLE artifacts ADD COLUMN published_at timestamptz;
ALTER TABLE benchmark_runs ADD COLUMN retention_expires_at timestamptz;
ALTER TABLE task_private_versions ADD COLUMN retention_expires_at timestamptz;
ALTER TABLE runners ADD COLUMN current_job_id uuid REFERENCES jobs(id);

CREATE TABLE organization_entitlement_overrides (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  entitlement text NOT NULL,
  value jsonb NOT NULL,
  updated_by_user_id uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, entitlement)
);

CREATE TABLE metric_events (
  id uuid PRIMARY KEY,
  metric text NOT NULL,
  value double precision NOT NULL,
  labels jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metric_events_name_time_idx ON metric_events(metric, observed_at DESC);

ALTER TABLE usage_records DROP CONSTRAINT usage_records_benchmark_run_id_attempt_id_usage_type_key;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_identity_unique UNIQUE NULLS NOT DISTINCT (benchmark_run_id, attempt_id, usage_type);
