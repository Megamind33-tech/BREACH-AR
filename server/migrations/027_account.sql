-- Organization administration: sign-in security (TOTP MFA with recovery codes, optional enforcement), people management, organization
-- settings and the recorded consent for compute sponsorship.

ALTER TABLE users ADD COLUMN disabled_at timestamptz;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
-- TOTP secrets are stored encrypted (AES-256-GCM, key derived from the server secret); never in clear.
ALTER TABLE users ADD COLUMN mfa_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_pending_enc text;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
-- The 30-second step of the last accepted code, so one code cannot be used twice.
ALTER TABLE users ADD COLUMN mfa_last_step bigint;
ALTER TABLE users ADD COLUMN mfa_failed integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_locked_until timestamptz;

CREATE TABLE mfa_recovery_codes (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX mfa_recovery_user ON mfa_recovery_codes (user_id);

-- Owner-controlled: when on, owners, admins and technicians must have MFA before they can use the console.
ALTER TABLE organizations ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;
ALTER TABLE organizations ADD COLUMN notification_emails text[] NOT NULL DEFAULT '{}';

-- A signed record that a named person accepted the compute-sponsorship terms (which wording, when). Append-only.
CREATE TABLE compute_consents (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email      text NOT NULL,
  wording_version text NOT NULL,
  wording_sha256  text NOT NULL,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  signature       text NOT NULL
);
CREATE INDEX compute_consents_org ON compute_consents (org_id, id DESC);
