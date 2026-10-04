-- Lost mode: an administrator can mark a stolen or missing computer, lock its screen on command with a passphrase only they chose, and see where it last
-- connected from. The passphrase itself is never stored, only a salted PBKDF2 hash the agent uses to check an entry without needing the network. A serial
-- hash lets anyone checking a used PC (the same way a buyer checks a Viro certificate) see, without any other detail, that it was reported stolen.
ALTER TABLE devices
  ADD COLUMN lost_mode        boolean NOT NULL DEFAULT false,
  ADD COLUMN lost_at          timestamptz,
  ADD COLUMN lost_note        text,
  ADD COLUMN lost_passphrase  text,       -- 'pbkdf2$<iterations>$<salt b64>$<hash b64>'; never returned by any route
  ADD COLUMN recovered_at     timestamptz,
  ADD COLUMN serial_hash      text;       -- sha256('viro-serial-v1\n' + normalised serial), same scheme as certificate.ts serialKey()
CREATE INDEX devices_serial_hash ON devices (serial_hash) WHERE serial_hash IS NOT NULL;
CREATE INDEX devices_lost ON devices (org_id) WHERE lost_mode;

-- Where this computer has connected from, kept as a short trail rather than only the latest value, so a lost computer's movement can be read at a glance.
-- One row per network it is seen on (the public IP changing), not one per heartbeat.
CREATE TABLE device_locations (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  public_ip  text,
  network    jsonb
);
CREATE INDEX device_locations_device ON device_locations (device_id, at DESC);
