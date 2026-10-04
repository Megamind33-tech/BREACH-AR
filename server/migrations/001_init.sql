-- Viro Control: Phase 0 schema. Every tenant-owned table carries org_id and is
-- always queried with it; there is no cross-org read path in the API layer.

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard','compute_sponsored')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','technician','viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE sites (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE departments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id   uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (site_id, name)
);

-- One-time-ish enrollment credentials an admin hands to the installer.
CREATE TABLE enrollment_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,          -- sha256 hex of the secret
  site_id       uuid REFERENCES sites(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  max_uses      integer NOT NULL DEFAULT 1000,
  uses          integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id        uuid REFERENCES sites(id) ON DELETE SET NULL,
  department_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  hostname       text NOT NULL,
  machine_guid   text NOT NULL,                -- hardware-stable identity; re-enroll reuses the row
  credential_hash text NOT NULL,               -- sha256 hex of the device secret
  agent_version  text,
  tags           text[] NOT NULL DEFAULT '{}',
  logged_in_user text,
  ip_address     text,
  os_caption     text,
  os_build       text,
  uptime_seconds bigint,
  last_seen_at   timestamptz,
  enrolled_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  UNIQUE (org_id, machine_guid)
);
CREATE INDEX devices_org_idx ON devices(org_id);

-- Latest hardware + software inventory as reported by the agent (real data only).
CREATE TABLE device_inventory (
  device_id     uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hardware      jsonb NOT NULL,
  software      jsonb NOT NULL DEFAULT '[]'::jsonb,
  collected_at  timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_heartbeats (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  received_at   timestamptz NOT NULL DEFAULT now(),
  metrics       jsonb NOT NULL
);
CREATE INDEX heartbeats_device_time_idx ON device_heartbeats(device_id, received_at DESC);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('user','device','system')),
  actor_id    text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  previous    jsonb,
  next        jsonb,
  result      text NOT NULL DEFAULT 'ok',
  ip          text
);
CREATE INDEX audit_org_time_idx ON audit_log(org_id, at DESC);
