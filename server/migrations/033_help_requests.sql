-- "Ask a technician": a person, or a user in an organization, asks the Viro team for help. The team replies by email and can then start a remote support session.
CREATE TABLE help_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  message     text NOT NULL,
  contact     text,                              -- a phone or WhatsApp number the person chose to share
  details     jsonb,                             -- what the person agreed to send about their PC (make, Windows, free space, issues)
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answered_by text,
  reply       text
);
CREATE INDEX help_requests_open ON help_requests (status, created_at DESC);
CREATE INDEX help_requests_org ON help_requests (org_id, created_at DESC);
