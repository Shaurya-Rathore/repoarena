CREATE TABLE billing_customers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('STRIPE')),
  provider_customer_id text NOT NULL UNIQUE,
  billing_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_subscriptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  billing_customer_id uuid NOT NULL REFERENCES billing_customers(id),
  provider text NOT NULL CHECK (provider IN ('STRIPE')),
  provider_subscription_id text NOT NULL UNIQUE,
  plan_id text NOT NULL REFERENCES plans(id) CHECK (plan_id <> 'COMMUNITY'),
  provider_price_id text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('MONTHLY','YEARLY')),
  provider_status text NOT NULL,
  status text NOT NULL CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','INCOMPLETE','INCOMPLETE_EXPIRED','PAUSED','UNPAID','CANCELLED')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  provider_event_created_at timestamptz NOT NULL,
  last_provider_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_invoices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  billing_subscription_id uuid REFERENCES billing_subscriptions(id),
  provider_invoice_id text NOT NULL UNIQUE,
  status text NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  period_start timestamptz,
  period_end timestamptz,
  hosted_invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_webhook_events (
  id uuid PRIMARY KEY,
  provider_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  provider_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('RECEIVED','QUEUED','PROCESSING','PROCESSED','IGNORED','FAILED','DEAD_LETTER')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  organization_id uuid REFERENCES organizations(id),
  provider_customer_id text,
  provider_subscription_id text,
  safe_payload jsonb NOT NULL,
  failure_code text,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_events_state_idx ON billing_webhook_events(state, received_at);

CREATE TABLE billing_checkout_operations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  idempotency_key text NOT NULL,
  plan_id text NOT NULL REFERENCES plans(id),
  billing_interval text NOT NULL CHECK (billing_interval IN ('MONTHLY','YEARLY')),
  provider_session_id text NOT NULL,
  checkout_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, idempotency_key)
);
