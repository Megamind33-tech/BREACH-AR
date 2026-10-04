-- Two-step sign-in for platform operators (same scheme as organization users: TOTP, sealed secret, recovery codes, lock after repeated misses).
ALTER TABLE platform_users ADD COLUMN mfa_secret_enc text;
ALTER TABLE platform_users ADD COLUMN mfa_pending_enc text;
ALTER TABLE platform_users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE platform_users ADD COLUMN mfa_last_step bigint;
ALTER TABLE platform_users ADD COLUMN mfa_failed integer NOT NULL DEFAULT 0;
ALTER TABLE platform_users ADD COLUMN mfa_locked_until timestamptz;

CREATE TABLE platform_recovery_codes (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);
CREATE INDEX platform_recovery_user ON platform_recovery_codes (user_id);
