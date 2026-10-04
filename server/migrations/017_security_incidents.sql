-- A threat Viro is managing from detection to verified clean. "Resolved" is reached only after containment, evidence review, any approved repair,
-- a fresh scan and re-inspection, and an observation period without recurrence.
CREATE TABLE security_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  threat_type      text NOT NULL CHECK (threat_type IN ('malware','ransomware','pua','other')),
  threat_name      text NOT NULL,
  source           text NOT NULL DEFAULT 'Microsoft Defender',
  severity         text NOT NULL,
  detected_at      timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'DETECTED',
  containment_action text,
  removal_action   text,
  persistence_found boolean,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','clean','failed','unverifiable')),
  evidence         jsonb NOT NULL DEFAULT '{}',
  proposed_actions jsonb NOT NULL DEFAULT '[]',
  verification     jsonb,
  timeline         jsonb NOT NULL DEFAULT '[]',
  jobs             jsonb NOT NULL DEFAULT '{}',
  observe_until    timestamptz,
  reopened_from    uuid REFERENCES security_incidents(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  UNIQUE (device_id, threat_name, detected_at)
);
CREATE INDEX security_incidents_open ON security_incidents (org_id, status);
CREATE INDEX security_incidents_device ON security_incidents (device_id, created_at DESC);
