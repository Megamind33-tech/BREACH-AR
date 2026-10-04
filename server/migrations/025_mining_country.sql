-- The ISO country code used to build a readable mining worker id (COUNTRY-ORG-SITE-DEVICE). 'XX' is the ISO 3166 user-assigned code for
-- "unspecified", used here only as a safe default until an administrator/operator sets the real one.
ALTER TABLE organizations ADD COLUMN country_code text NOT NULL DEFAULT 'XX' CHECK (country_code ~ '^[A-Z]{2}$');

-- mining_devices (024) tracked identity but not liveness/authorization state; add what the directive's schema and the dashboard need.
ALTER TABLE mining_devices ADD COLUMN last_seen_at timestamptz;
ALTER TABLE mining_devices ADD COLUMN authorization_status text NOT NULL DEFAULT 'pending' CHECK (authorization_status IN ('pending','authorized','revoked'));

