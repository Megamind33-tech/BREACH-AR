-- Service Passport: hardware component history (so replacements are noticed, not silently overwritten), pending confirmations, purchase info.

ALTER TABLE devices ADD COLUMN purchase_date date;
ALTER TABLE devices ADD COLUMN purchase_cost numeric(12,2);

ALTER TABLE service_events ADD COLUMN status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','PENDING_CONFIRMATION','DISMISSED'));

CREATE TABLE hardware_components (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('storage','memory','gpu','system')),
  identity    text NOT NULL,                      -- serial number when the hardware reports one, otherwise model + size
  label       text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  UNIQUE (device_id, kind, identity)
);
CREATE INDEX hardware_components_device ON hardware_components(device_id, kind);
