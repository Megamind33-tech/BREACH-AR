-- Billing: plans, the ways a customer can pay (mobile money, bank transfer, cash), orders, and each organization's subscription.
-- Payments are confirmed by a person at Viro until a payment provider is connected: a customer places an order, pays by the chosen method using a unique
-- reference, says they have paid, and an operator confirms it against the money that actually arrived. Nothing is activated on the customer's word alone.
CREATE TABLE billing_plans (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  audience    text NOT NULL CHECK (audience IN ('person','business','shop')),
  price       numeric(12,2) NOT NULL CHECK (price >= 0),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period      text NOT NULL CHECK (period IN ('month','year','once')),
  per         text NOT NULL DEFAULT 'pc' CHECK (per IN ('pc','certificate','account')),
  description text,
  features    jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT false,   -- a plan is invisible to customers until the owner has set its price and switched it on
  sort        int NOT NULL DEFAULT 100,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('mobile_money','bank','cash')),
  label        text NOT NULL,                   -- e.g. "MTN Mobile Money", "Airtel Money", "Stanbic Bank", "Pay in person"
  instructions text NOT NULL,                   -- exactly what the customer should do, shown to them with their reference
  details      jsonb NOT NULL DEFAULT '{}',     -- account name and number, till number, branch, or where to pay cash
  currency     text,
  active       boolean NOT NULL DEFAULT true,
  sort         int NOT NULL DEFAULT 100
);

CREATE TABLE billing_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by    uuid,
  plan_code     text NOT NULL REFERENCES billing_plans(code),
  quantity      int NOT NULL CHECK (quantity BETWEEN 1 AND 5000),
  amount        numeric(12,2) NOT NULL,
  currency      text NOT NULL,
  method_id     uuid NOT NULL REFERENCES payment_methods(id),
  method_kind   text NOT NULL,
  reference     text NOT NULL UNIQUE,           -- VBL-XXXXXX: quoted by the customer when they pay, matched by the operator
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','paid','cancelled','rejected')),
  payer_name    text,
  payer_phone   text,
  payer_txn     text,                           -- the mobile-money transaction id, bank reference or cash receipt number
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  paid_at       timestamptz,
  confirmed_by  text,
  reject_reason text
);
CREATE INDEX billing_orders_org ON billing_orders (org_id, created_at DESC);
CREATE INDEX billing_orders_open ON billing_orders (status) WHERE status IN ('pending','submitted');

CREATE TABLE subscriptions (
  org_id             uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code          text NOT NULL REFERENCES billing_plans(code),
  quantity           int NOT NULL,
  current_period_end timestamptz,               -- null for a one-off purchase
  updated_at         timestamptz NOT NULL DEFAULT now()
);
