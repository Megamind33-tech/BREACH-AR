-- WorkCare Mobile: a signed-in administrator can pause compute on a PC from the phone for a bounded time.
-- Pausing only ever turns compute OFF for that device; resuming only clears the pause. Neither can enable compute that the organization policy
-- does not already enable, and the health gate still overrides.
ALTER TABLE mining_devices ADD COLUMN paused_until timestamptz;
ALTER TABLE mining_devices ADD COLUMN paused_by uuid;
