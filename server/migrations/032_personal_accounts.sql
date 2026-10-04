-- Personal accounts: a person can sign up for themselves (a one-person organization) to buy a plan, sign in to the Windows app and keep their move/backup.
ALTER TABLE organizations ADD COLUMN kind text NOT NULL DEFAULT 'business' CHECK (kind IN ('business','personal'));
ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now();   -- people an operator or admin adds are trusted; only self-service sign-up leaves it empty until the link is followed
CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
-- What a paid plan includes. Empty means "the standard set for its audience" (see entitlements.ts).
ALTER TABLE billing_plans ADD COLUMN entitlements jsonb NOT NULL DEFAULT '[]';
