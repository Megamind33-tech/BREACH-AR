-- Remote support sessions: who, which PC, when, what was done, and how it ended.
ALTER TABLE organizations ADD COLUMN remote_support_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE support_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  admin_id     uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL CHECK (kind IN ('terminal','files','desktop')),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','ended')),
  ended_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  ended_at     timestamptz
);
CREATE INDEX support_sessions_org_idx ON support_sessions(org_id, requested_at DESC);
CREATE INDEX support_sessions_device_idx ON support_sessions(device_id, status);

CREATE TABLE support_events (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,
  detail     text
);
CREATE INDEX support_events_session_idx ON support_events(session_id, id);
