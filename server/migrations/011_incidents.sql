-- Viro Health Engine: incidents (evidence -> cause -> action -> verification), benchmarks, service history, device baseline.

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code             text NOT NULL,                       -- the health finding this incident is about (e.g. storage.system_low)
  category         text NOT NULL,
  impact           text NOT NULL CHECK (impact IN ('high','medium','low')),
  title            text NOT NULL,
  root_cause       text NOT NULL,
  confidence       text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','UNKNOWN')),
  status           text NOT NULL CHECK (status IN ('DETECTED','DIAGNOSING','ROOT_CAUSE_SUSPECTED','ROOT_CAUSE_CONFIRMED','REPAIR_READY','REPAIRING','VERIFYING','OBSERVING','RESOLVED','IMPROVED','UNRESOLVED','HARDWARE_ACTION_REQUIRED','USER_ACTION_REQUIRED','ADMIN_APPROVAL_REQUIRED')),
  remedy           text NOT NULL,                       -- safe-fix | review | manual | hardware
  safety_level     integer NOT NULL DEFAULT 0 CHECK (safety_level BETWEEN 0 AND 4),
  action_label     text,
  fix              jsonb,                               -- {jobType, params, label}
  recommendation   text,
  points           integer NOT NULL DEFAULT 0,          -- health points this finding costs now
  points_at_detection integer NOT NULL DEFAULT 0,
  first_detected   timestamptz NOT NULL DEFAULT now(),
  last_detected    timestamptz NOT NULL DEFAULT now(),
  repaired_at      timestamptz,
  observation_until timestamptz,
  resolved_at      timestamptz,
  resolution       text CHECK (resolution IN ('viro-repair','self-cleared')),
  recurrence_count integer NOT NULL DEFAULT 0,
  before_metrics   jsonb,
  after_metrics    jsonb,
  before_score     integer,
  after_score      integer,
  verification     jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- One unresolved incident per device and finding; a resolved one is kept as history and reopened on recurrence.
CREATE UNIQUE INDEX incidents_one_open ON incidents(device_id, code) WHERE status <> 'RESOLVED';
CREATE INDEX incidents_device ON incidents(device_id, first_detected DESC);
CREATE INDEX incidents_org_status ON incidents(org_id, status);

CREATE TABLE incident_evidence (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('TELEMETRY','EVENT_LOG','COMMAND_OUTPUT','INVENTORY','HARDWARE','VERIFICATION','RECURRENCE')),
  source      text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  value       jsonb NOT NULL,
  note        text
);
CREATE INDEX incident_evidence_incident ON incident_evidence(incident_id, observed_at);

CREATE TABLE incident_actions (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  job_id      uuid REFERENCES jobs(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('repair','verify-health','benchmark')),
  by          text NOT NULL CHECK (by IN ('autopilot','user')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text
);
CREATE INDEX incident_actions_job ON incident_actions(job_id);

CREATE TABLE benchmarks (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('baseline','before','after','periodic')),
  metrics     jsonb NOT NULL,
  incident_id uuid REFERENCES incidents(id) ON DELETE SET NULL,
  job_id      uuid,
  taken_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmarks_device ON benchmarks(device_id, taken_at DESC);

CREATE TABLE service_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id      uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL CHECK (source IN ('AUTOMATIC','ADMIN','TECHNICIAN','IMPORT','HARDWARE_CHANGE_DETECTION')),
  service_type   text NOT NULL,
  reason         text,
  technician     text,
  parts          jsonb NOT NULL DEFAULT '[]'::jsonb,
  old_part_serial text,
  new_part_serial text,
  notes          text,
  cost           numeric(12,2),
  downtime_minutes integer,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  incident_id    uuid REFERENCES incidents(id) ON DELETE SET NULL,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_events_device ON service_events(device_id, occurred_at DESC);

-- What "normal" looked like when Viro first saw the machine. Kept for the life of the device; never overwritten.
CREATE TABLE device_baselines (
  device_id      uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  taken_at       timestamptz NOT NULL DEFAULT now(),
  hardware       jsonb NOT NULL,
  software_count integer,
  startup_count  integer,
  health_overall integer,
  metrics        jsonb
);
