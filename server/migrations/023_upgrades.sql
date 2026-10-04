-- Hardware upgrade intelligence: what was recommended, what was measured before and after a swap, and what the real outcomes were.

-- Controlled measurements (agent job benchmark.upgrade). Kept apart from the repair benchmarks so the two never mix.
CREATE TABLE upgrade_benchmarks (
  id        bigserial PRIMARY KEY,
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  purpose   text NOT NULL CHECK (purpose IN ('baseline','after','periodic')),
  metrics   jsonb NOT NULL,
  safety    jsonb,
  job_id    uuid,
  taken_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upgrade_benchmarks_device ON upgrade_benchmarks (device_id, taken_at DESC);

-- Immutable history of what WorkCare recommended for a computer and when. Rows are never changed; a new row is written only when the recommendation set changes.
CREATE TABLE upgrade_recommendations (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  signature       text NOT NULL,
  grade           text NOT NULL,
  best            text,
  recommendations jsonb NOT NULL,
  replacement     jsonb NOT NULL,
  hardware        jsonb NOT NULL
);
CREATE INDEX upgrade_recommendations_device ON upgrade_recommendations (device_id, created_at DESC);
CREATE FUNCTION upgrade_recommendations_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'upgrade_recommendations rows are immutable'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER upgrade_recommendations_no_update BEFORE UPDATE ON upgrade_recommendations FOR EACH ROW EXECUTE FUNCTION upgrade_recommendations_immutable();

-- A hardware change was seen; the computer is re-measured and the result is compared with the prediction.
CREATE TABLE upgrade_verifications (
  id                bigserial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id         uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  recommendation_id bigint REFERENCES upgrade_recommendations(id) ON DELETE SET NULL,
  detected_at       timestamptz NOT NULL DEFAULT now(),
  changes           jsonb NOT NULL,
  before_metrics    jsonb,
  before_at         timestamptz,
  predicted         jsonb,
  state             text NOT NULL DEFAULT 'awaiting_measurement' CHECK (state IN ('awaiting_measurement','done','inconclusive')),
  job_id            uuid,
  result            jsonb,
  after_metrics     jsonb,
  completed_at      timestamptz
);
CREATE INDEX upgrade_verifications_device ON upgrade_verifications (device_id, detected_at DESC);

-- Verified real-world results, per board and change. Pooled across organizations ONLY for organizations that opted in (hardware facts only, never organization data).
CREATE TABLE upgrade_outcomes (
  id            bigserial PRIMARY KEY,
  org_id        uuid REFERENCES organizations(id) ON DELETE SET NULL,
  shared        boolean NOT NULL DEFAULT false,
  board_key     text NOT NULL,
  component     text NOT NULL,
  from_part     text,
  to_part       text NOT NULL,
  success       boolean NOT NULL,
  gain_percent  numeric,
  temp_change_c numeric,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upgrade_outcomes_lookup ON upgrade_outcomes (board_key, to_part);

CREATE TABLE upgrade_settings (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  share_outcomes  boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
