-- Hardware readings over time (from each hardware diagnosis), so wear, error counts and battery capacity have a history, not just a current value.
CREATE TABLE hardware_readings (
  id        bigserial PRIMARY KEY,
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  storage   jsonb NOT NULL DEFAULT '[]'::jsonb,
  battery   jsonb
);
CREATE INDEX hardware_readings_device ON hardware_readings(device_id, at DESC);
