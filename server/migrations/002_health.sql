-- Latest raw health snapshot per device (scores are computed from it at read time so rule changes apply retroactively).
CREATE TABLE device_health (
  device_id    uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot     jsonb NOT NULL,
  collected_at timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Score trend recorded at ingest time.
CREATE TABLE device_health_history (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  overall     integer NOT NULL,
  categories  jsonb NOT NULL
);
CREATE INDEX health_history_device_idx ON device_health_history(device_id, at DESC);
