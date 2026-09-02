CREATE TABLE readiness_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  report jsonb NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('READY','NEEDS_ATTENTION','BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX readiness_snapshots_repository_created_idx ON readiness_snapshots(repository_id,created_at DESC,id DESC);

CREATE TABLE optimization_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  result jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETED','CANCELLED','BUDGET_EXHAUSTED','NO_VALID_CANDIDATES')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX optimization_runs_repository_created_idx ON optimization_runs(repository_id,created_at DESC,id DESC);
