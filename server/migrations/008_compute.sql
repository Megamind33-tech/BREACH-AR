-- Compute sponsorship: policy, worker state, usage. (Mining/pool integration is NOT part of this schema's behaviour yet.)
CREATE TABLE compute_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type  text NOT NULL CHECK (scope_type IN ('org','site','department')),
  scope_id    uuid,
  settings    jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX compute_policies_scope_idx ON compute_policies(org_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE compute_state (
  device_id        uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  state            text NOT NULL,
  reason           text,
  cpu_cap_percent  integer,
  hash_rate        double precision,
  worker_version   text,
  policy_version   integer,
  user_idle_seconds double precision,
  integrity        jsonb,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compute_usage (
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL,
  day        date NOT NULL,
  seconds    double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX compute_usage_org_day_idx ON compute_usage(org_id, day);
