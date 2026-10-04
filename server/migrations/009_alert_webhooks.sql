-- Alert delivery: signed webhooks with retry. Alerts stay derived state; deliveries are just a durable outbox of "opened"/"resolved" events.
CREATE TABLE alert_webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url           text NOT NULL,
  secret        text NOT NULL,
  min_severity  text NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('warning','critical')),
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_webhooks_org ON alert_webhooks(org_id);

CREATE TABLE alert_deliveries (
  id              bigserial PRIMARY KEY,
  webhook_id      uuid NOT NULL REFERENCES alert_webhooks(id) ON DELETE CASCADE,
  alert_id        bigint NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  event           text NOT NULL CHECK (event IN ('opened','resolved')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  delivered_at    timestamptz,
  UNIQUE (webhook_id, alert_id, event)
);
CREATE INDEX alert_deliveries_due ON alert_deliveries(next_attempt_at) WHERE status = 'pending';
