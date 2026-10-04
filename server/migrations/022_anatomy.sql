-- Computer anatomy: every part of a computer as it was read from the machine, how it changed over time, and the prices an organization uses for repair and replacement decisions.
CREATE TABLE device_anatomy (
  device_id    uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data         jsonb NOT NULL,
  collected_at timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- One row each time the anatomy differs from the last one, so what was in the computer on any date can be shown.
CREATE TABLE anatomy_history (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL,
  fingerprint  text NOT NULL,
  data         jsonb NOT NULL
);
CREATE INDEX anatomy_history_device ON anatomy_history (device_id, collected_at DESC);

-- Parts that appeared, disappeared or were swapped between two readings. These are facts about the computer; whether it was a repair or an upgrade is for a person to record in the service history.
CREATE TABLE anatomy_changes (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  change      text NOT NULL CHECK (change IN ('added','removed','replaced','changed')),
  label       text NOT NULL,
  before      jsonb,
  after       jsonb
);
CREATE INDEX anatomy_changes_device ON anatomy_changes (device_id, detected_at DESC);

-- What parts and labour cost in the organization's market. 'reference' prices are typical figures loaded as a starting point and are shown as such; 'entered' prices were set by an administrator.
CREATE TABLE price_book (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  currency        text NOT NULL DEFAULT 'USD',
  source          text NOT NULL DEFAULT 'entered' CHECK (source IN ('entered','reference')),
  labour_per_hour numeric(10,2) NOT NULL,
  items           jsonb NOT NULL,
  new_pc          jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);
