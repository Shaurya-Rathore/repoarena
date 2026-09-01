CREATE TABLE public_run_publications (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^rap_[A-Za-z0-9_-]{20,}$'),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  repository_id uuid NOT NULL REFERENCES repositories(id),
  benchmark_run_id uuid NOT NULL UNIQUE REFERENCES benchmark_runs(id),
  state text NOT NULL CHECK (state IN ('PUBLISHED','UNPUBLISHED')),
  repository_projection jsonb NOT NULL,
  run_projection jsonb NOT NULL,
  methodology_version text NOT NULL,
  publisher_type text NOT NULL CHECK (publisher_type IN ('USER','API_KEY')),
  publisher_id text NOT NULL,
  private_repository_confirmed boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL,
  unpublished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_run_publications_active_idx
  ON public_run_publications(state, published_at DESC, public_id)
  WHERE state='PUBLISHED';
CREATE INDEX public_run_publications_repository_idx
  ON public_run_publications(repository_id, published_at DESC)
  WHERE state='PUBLISHED';

CREATE TABLE product_analytics_events (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  actor_user_id uuid REFERENCES users(id),
  event_name text NOT NULL CHECK (length(event_name) BETWEEN 1 AND 100),
  properties jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_analytics_events_time_idx
  ON product_analytics_events(occurred_at DESC);
