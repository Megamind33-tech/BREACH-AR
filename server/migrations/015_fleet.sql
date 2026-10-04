-- Fleet intelligence: recurring problems that affect many computers, and staged (test -> pilot -> everyone) repairs for them.

CREATE TABLE fleet_patterns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  signature     text NOT NULL,                       -- stable identity of the pattern: finding + common factor
  code          text NOT NULL,
  title         text NOT NULL,
  factors       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- what the affected computers have in common (model, OS build, site, app version, ...)
  device_ids    uuid[] NOT NULL DEFAULT '{}',
  affected      integer NOT NULL,
  fleet_size    integer NOT NULL,
  confidence    text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  fix           jsonb,
  status        text NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED','REMEDIATING','REMEDIATED','FLAGGED','DISMISSED')),
  first_detected timestamptz NOT NULL DEFAULT now(),
  last_detected  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, signature)
);

-- Rollouts also stage repairs, not only drivers.
ALTER TABLE rollouts DROP CONSTRAINT rollouts_kind_check;
ALTER TABLE rollouts ADD CONSTRAINT rollouts_kind_check CHECK (kind IN ('driver','fix'));
