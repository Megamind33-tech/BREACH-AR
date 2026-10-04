-- What Control needs to wake a PC from another PC on its network: the adapters' hardware addresses and subnets, and the address the PC reaches the internet from (PCs behind the same router share it).
ALTER TABLE devices ADD COLUMN network jsonb;
ALTER TABLE devices ADD COLUMN public_ip text;
ALTER TABLE devices ADD COLUMN network_at timestamptz;
