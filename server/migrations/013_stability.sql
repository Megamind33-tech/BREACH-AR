-- The measurements at each health report, so a crash can be correlated with memory and disk state at the time it happened.
ALTER TABLE device_health_history ADD COLUMN metrics jsonb;
