-- Software management: org-approved catalog + policy rules; staged driver rollouts.
CREATE TABLE software_catalog (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  winget_id    text NOT NULL CHECK (winget_id ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{1,100}$'),
  allow_uninstall boolean NOT NULL DEFAULT false,
  note         text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, winget_id)
);

CREATE TABLE software_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('prohibited','min_version')),
  pattern     text NOT NULL CHECK (length(pattern) BETWEEN 2 AND 120),   -- case-insensitive substring of the application name
  min_version text,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'min_version' OR min_version IS NOT NULL)
);

CREATE TABLE rollouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('driver')),
  subject_id  text NOT NULL,                       -- e.g. the Windows Update id of the driver package
  title       text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage       text NOT NULL DEFAULT 'test' CHECK (stage IN ('test','pilot','fleet')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','halted','completed')),
  halt_reason text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rollout_devices (
  rollout_id    uuid NOT NULL REFERENCES rollouts(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL,
  stage         text NOT NULL,
  install_job   uuid,
  verify_job    uuid,
  health_before integer,
  health_after  integer,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','installed','verified','failed','rolled_back')),
  detail        text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, device_id)
);
CREATE INDEX rollout_devices_status_idx ON rollout_devices(status);
