-- The mining engine builds the Viro operator has published. PCs only ever download one of these, and only run it when its SHA-256 matches the signed policy.
CREATE TABLE compute_engines (
  version     text PRIMARY KEY CHECK (version ~ '^[A-Za-z0-9._-]{1,40}$'),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  bigint NOT NULL,
  file_path   text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
