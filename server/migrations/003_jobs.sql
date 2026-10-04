-- Jobs: every administrative action on a device is a job. Jobs are signed by the server, verified by the agent,
-- and their whole lifecycle is recorded.
CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  batch_id         uuid,                                   -- groups jobs created by one bulk request
  type             text NOT NULL,
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,                   -- must start before this
  timeout_seconds  integer NOT NULL,                       -- max runtime once started
  dispatched_at    timestamptz,                            -- last time it was handed to the agent
  started_at       timestamptz,
  finished_at      timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  payload          text NOT NULL,                          -- exact signed bytes
  signature        text NOT NULL,                          -- base64 ECDSA P-256 over payload
  result           jsonb,
  error            text
);
CREATE INDEX jobs_device_status_idx ON jobs(device_id, status);
CREATE INDEX jobs_org_created_idx ON jobs(org_id, created_at DESC);
CREATE INDEX jobs_batch_idx ON jobs(batch_id);
