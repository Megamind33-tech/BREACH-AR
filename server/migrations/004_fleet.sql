-- Phase 3: fleet management (policies, scheduler state, alerts).
ALTER TABLE organizations ADD COLUMN utc_offset_minutes integer NOT NULL DEFAULT 0 CHECK (utc_offset_minutes BETWEEN -720 AND 840);

CREATE TABLE policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  enabled     boolean NOT NULL DEFAULT true,
  scope_type  text NOT NULL CHECK (scope_type IN ('org','site','department','tag')),
  scope_id    uuid,                       -- site or department id
  scope_tag   text,                       -- tag value when scope_type = 'tag'
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- When each policy schedule last produced a job for each device.
CREATE TABLE policy_runs (
  policy_id    uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  schedule_key text NOT NULL,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  last_run_at  timestamptz NOT NULL,
  PRIMARY KEY (policy_id, schedule_key, device_id)
);

CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('critical','warning')),
  message         text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX alerts_open_unique ON alerts(device_id, code) WHERE resolved_at IS NULL;
CREATE INDEX alerts_org_open_idx ON alerts(org_id, resolved_at, severity);
