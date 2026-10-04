-- Care engines: what the agent saw and did about heat, battery, memory and start-up. Every figure on the outcome pages comes from these rows.
CREATE TABLE care_events (
  id        bigserial PRIMARY KEY,
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL,
  kind      text NOT NULL,
  data      jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_events_device ON care_events (device_id, at DESC);
CREATE INDEX care_events_org_kind ON care_events (org_id, kind, at DESC);

CREATE TABLE thermal_incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  at              timestamptz NOT NULL,
  level           text NOT NULL CHECK (level IN ('warm','warning','critical')),
  sensor          text NOT NULL DEFAULT 'cpu',
  temperature_c   real,
  load_percent    real,
  throttling_state text,
  top_processes   jsonb NOT NULL DEFAULT '[]',
  compute_state   text,
  action_taken    text,
  recovered_at    timestamptz,
  cooling_suspected boolean NOT NULL DEFAULT false
);
CREATE INDEX thermal_incidents_device ON thermal_incidents (device_id, at DESC);

CREATE TABLE battery_samples (
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  at              timestamptz NOT NULL,
  percent         int,
  on_battery      boolean,
  discharge_watts real,
  remaining_wh    real,
  full_charge_wh  real,
  design_wh       real,
  health_percent  real,
  cycle_count     int,
  PRIMARY KEY (device_id, at)
);

CREATE TABLE boot_history (
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  boot_at      timestamptz NOT NULL,
  seconds      real NOT NULL,
  PRIMARY KEY (device_id, boot_at)
);
