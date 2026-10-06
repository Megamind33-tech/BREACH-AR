-- Organization demo requests from the marketing site's "Request a demo" form. A lead is never discarded: it always lands
-- here even if the notification email fails to send, and the platform owner can read the list without email at all.
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  organization text NOT NULL,
  email text NOT NULL,
  phone text,
  computers text,
  city text,
  message text,
  source text,
  notified_at timestamptz
);
CREATE INDEX leads_created_at_idx ON leads (created_at DESC);
