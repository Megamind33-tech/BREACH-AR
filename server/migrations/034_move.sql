-- Viro Move: a person's files, settings and app list, encrypted on their own PC before upload, kept so they can be put back on a new PC.
-- The server only ever holds ciphertext: it cannot read file names, contents or settings. The header (key derivation settings and a small check value) lets a new PC
-- confirm the passphrase before downloading anything.
ALTER TABLE billing_plans ADD COLUMN move_quota_gb numeric(8,2) NOT NULL DEFAULT 5 CHECK (move_quota_gb >= 0 AND move_quota_gb <= 5000);

CREATE TABLE move_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,
  machine       text,
  status        text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','complete','failed')),
  kdf           jsonb NOT NULL,                 -- { alg, iterations, salt }: how the key is made from the passphrase (public by design)
  key_check     text NOT NULL,                  -- an encrypted constant: decrypts only with the right passphrase
  manifest      text,                           -- encrypted list of files, settings and apps (base64)
  chunk_count   int NOT NULL DEFAULT 0,
  bytes         bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX move_snapshots_user ON move_snapshots (org_id, user_id, created_at DESC);

CREATE TABLE move_chunks (
  snapshot_id uuid NOT NULL REFERENCES move_snapshots(id) ON DELETE CASCADE,
  n           int NOT NULL,
  size        int NOT NULL,
  sha256      text NOT NULL,
  PRIMARY KEY (snapshot_id, n)
);
