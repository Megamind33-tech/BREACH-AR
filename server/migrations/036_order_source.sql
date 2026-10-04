-- Where an order came from: the campaign link or website that brought the buyer (utm_source, utm_medium, utm_campaign, ref). Kept on the order so the owner can see which ad pays.
ALTER TABLE billing_orders ADD COLUMN source jsonb;
