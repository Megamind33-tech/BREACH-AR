-- Viro resale certificate: a signed statement about a computer's measured condition and history, requested by a seller for a named buyer and
-- delivered only by Viro to the buyer's own email address. The seller never receives the verification code, so the seller cannot alter or forge it.
CREATE TABLE resale_certificates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  requested_by    uuid,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  buyer_email_hash text NOT NULL,                 -- sha-256 of the lower-cased address; the address itself is only held in the sent email
  buyer_email_masked text NOT NULL,               -- a***@d***.com, so the seller can see where it went without being able to reuse it
  buyer_email_pending text,                       -- held only until the email has been sent, then erased
  status          text NOT NULL DEFAULT 'awaiting_inspection' CHECK (status IN ('awaiting_inspection','issued','revoked','failed')),
  code_hash       text UNIQUE,                    -- sha-256 of the verification code; the code is shown only in the buyer's email and on the verify page
  issued_at       timestamptz,
  expires_at      timestamptz,
  statement       text,                           -- exactly the text that was signed (kept as text so the signature can always be re-checked byte for byte)
  signature       text,
  key_id          text,
  hw_binding      text,                           -- hash of the machine's own serial numbers: a buyer can check the certificate belongs to the machine in front of them
  emailed_at      timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,
  failure         text
);
CREATE INDEX resale_certificates_device ON resale_certificates (device_id, requested_at DESC);
CREATE INDEX resale_certificates_waiting ON resale_certificates (device_id) WHERE status = 'awaiting_inspection';

-- One row per message Viro sends on its own behalf (no message bodies are kept).
CREATE TABLE mail_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  purpose   text NOT NULL,
  to_hash   text NOT NULL,
  status    text NOT NULL CHECK (status IN ('sent','failed')),
  error     text
);
