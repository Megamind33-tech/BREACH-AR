-- What the compute worker last saw: its thermal level (normal/warm/warning/critical) and the CPU temperature when the firmware exposes one.
ALTER TABLE compute_state ADD COLUMN thermal text CHECK (thermal IN ('normal','warm','warning','critical')), ADD COLUMN cpu_temp_c real;
