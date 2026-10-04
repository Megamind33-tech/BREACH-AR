-- Compute-sponsorship worker identity, sessions and telemetry. This is additive to compute_policies/compute_state/compute_engines (008/016):
-- it does not change their behaviour. A device's mining_worker_id is assigned once, server-side, and never reused.
CREATE TABLE mining_devices (
  device_id    uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      uuid REFERENCES sites(id) ON DELETE SET NULL,
  worker_id    text NOT NULL UNIQUE,
  enabled      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);
CREATE INDEX mining_devices_org ON mining_devices (org_id);

-- A worker_id, once given out, is never reused, even after the device or its row is gone. This outlives mining_devices on purpose.
CREATE TABLE mining_worker_ids (
  worker_id  text PRIMARY KEY,
  device_id  uuid NOT NULL,
  org_id     uuid NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mining_sessions (
  id               bigserial PRIMARY KEY,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_id        text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  stopped_at       timestamptz,
  runtime_seconds  double precision,
  average_hashrate double precision,
  peak_hashrate    double precision,
  accepted_shares  integer NOT NULL DEFAULT 0,
  rejected_shares  integer NOT NULL DEFAULT 0,
  stop_reason      text
);
CREATE INDEX mining_sessions_device ON mining_sessions (device_id, started_at DESC);

-- Recent, fine-grained samples. Kept only briefly: mining_telemetry_hourly below is what lasts.
CREATE TABLE mining_telemetry (
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at               timestamptz NOT NULL DEFAULT now(),
  hashrate         double precision,
  cpu_usage_percent double precision,
  cpu_temp_c       double precision,
  memory_percent   double precision,
  pool_connected   boolean,
  accepted_shares  integer,
  rejected_shares  integer,
  last_share_at    timestamptz
);
CREATE INDEX mining_telemetry_device_at ON mining_telemetry (device_id, at DESC);

-- Hourly rollup: raw mining_telemetry rows older than a few days are aggregated into this and deleted, so storage does not grow without bound.
CREATE TABLE mining_telemetry_hourly (
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hour             timestamptz NOT NULL,
  avg_hashrate     double precision,
  max_hashrate     double precision,
  avg_cpu_percent  double precision,
  max_cpu_temp_c   double precision,
  accepted_shares  integer NOT NULL DEFAULT 0,
  rejected_shares  integer NOT NULL DEFAULT 0,
  samples          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, hour)
);

-- Audit trail required by the mining directive: who changed what, with the wallet address change treated as high-risk (flag only; approval is enforced in code).
CREATE TABLE mining_audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id    uuid,
  action      text NOT NULL,
  device_id   uuid,
  high_risk   boolean NOT NULL DEFAULT false,
  previous    jsonb,
  next        jsonb,
  agent_version text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mining_audit_log_org ON mining_audit_log (org_id, at DESC);
