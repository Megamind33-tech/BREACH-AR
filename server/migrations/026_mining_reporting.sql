-- Mining session reporting (024 created the tables; nothing wrote to them). The compute worker now reports each engine run as a session,
-- identified by a client-generated id so retries and late reports are idempotent.
ALTER TABLE mining_sessions ADD COLUMN client_session_id uuid;
ALTER TABLE mining_sessions ADD COLUMN engine_version text;
ALTER TABLE mining_sessions ADD COLUMN agent_version text;
ALTER TABLE mining_sessions ADD COLUMN last_report_at timestamptz NOT NULL DEFAULT now();
-- 'worker': the worker reported the stop itself (final). 'server': closed by the server after the worker went silent; a later worker report may still correct it.
ALTER TABLE mining_sessions ADD COLUMN closed_by text CHECK (closed_by IN ('worker','server'));
CREATE UNIQUE INDEX mining_sessions_client ON mining_sessions (device_id, client_session_id);
CREATE INDEX mining_sessions_open ON mining_sessions (last_report_at) WHERE stopped_at IS NULL;

-- Raw samples belong to a session; the share counters the worker sends are cumulative for that session, so the server stores the increase
-- since the previous sample as well, which is what the hourly rollup sums.
ALTER TABLE mining_telemetry ADD COLUMN session_id bigint REFERENCES mining_sessions(id) ON DELETE CASCADE;
ALTER TABLE mining_telemetry ADD COLUMN accepted_delta integer NOT NULL DEFAULT 0;
ALTER TABLE mining_telemetry ADD COLUMN rejected_delta integer NOT NULL DEFAULT 0;
CREATE INDEX mining_telemetry_at ON mining_telemetry (at);

-- Who acted: 'user' (organization admin, actor_id = user id), 'platform' (operator), 'system' (the server itself), 'device'.
ALTER TABLE mining_audit_log ADD COLUMN actor_type text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','platform','system','device'));
ALTER TABLE mining_audit_log ADD COLUMN actor_label text;
-- Why an entry is high-risk, in plain words (for example "payout address changed"), so a reviewer does not have to diff JSON.
ALTER TABLE mining_audit_log ADD COLUMN reasons text[] NOT NULL DEFAULT '{}';
