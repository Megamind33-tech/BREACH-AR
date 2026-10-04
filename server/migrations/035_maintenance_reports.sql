-- The weekly care report: what the scheduled run on a person's PC measured and fixed. Kept so the person can see their history and so the weekly email is not sent twice.
CREATE TABLE maintenance_reports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine    text,
  version    text,
  before     jsonb NOT NULL,
  after      jsonb NOT NULL,
  steps      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz
);
CREATE INDEX maintenance_reports_user ON maintenance_reports (org_id, user_id, created_at DESC);
