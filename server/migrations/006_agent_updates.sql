-- Signed agent releases, staged rollout, update outcomes, integrity reports.
CREATE TABLE agent_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component     text NOT NULL DEFAULT 'agent' CHECK (component IN ('agent')),
  version       text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  sha256        text NOT NULL,                 -- of the package (zip)
  exe_sha256    text NOT NULL,                 -- of viro-agent.exe inside; used for tamper detection
  size_bytes    bigint NOT NULL,
  manifest      text NOT NULL,                 -- exact signed bytes
  signature     text NOT NULL,
  file_path     text NOT NULL,
  stage         text NOT NULL DEFAULT 'internal' CHECK (stage IN ('internal','pilot','10','50','100')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','halted')),
  halt_reason   text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (component, version)
);

CREATE TABLE agent_update_events (
  id         bigserial PRIMARY KEY,
  device_id  uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL,
  version    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('ok','rolled_back','failed')),
  detail     text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX update_events_version_idx ON agent_update_events(version, status);

ALTER TABLE devices ADD COLUMN update_ring   text NOT NULL DEFAULT 'stable' CHECK (update_ring IN ('internal','pilot','stable'));
ALTER TABLE devices ADD COLUMN integrity     jsonb;
ALTER TABLE devices ADD COLUMN integrity_at  timestamptz;
ALTER TABLE devices ADD COLUMN uninstalled_at timestamptz;
