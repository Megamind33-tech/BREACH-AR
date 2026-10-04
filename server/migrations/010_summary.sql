-- Weekly plain-language summary: remember when it was last pushed to an organization's webhooks.
ALTER TABLE organizations ADD COLUMN summary_sent_at timestamptz;
