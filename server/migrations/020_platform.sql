-- Two sides: the platform (the operator of this service) and each organization. Platform operators have their own accounts, separate from every organization's users.
CREATE TABLE platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- An organization can be suspended by the platform: its people cannot sign in and its computers are refused until it is resumed. Nothing is deleted.
ALTER TABLE organizations ADD COLUMN suspended_at timestamptz;
ALTER TABLE organizations ADD COLUMN suspended_reason text;
