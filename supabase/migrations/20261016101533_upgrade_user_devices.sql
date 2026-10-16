-- Migration: Upgrade user_devices table for serverless device tracking & Safari ITP resilience

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS browser TEXT,
  ADD COLUMN IF NOT EXISTS os TEXT,
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS is_safari BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW();

-- Create indices for fast lookup & security auditing
CREATE INDEX IF NOT EXISTS idx_user_devices_ip_hash ON public.user_devices (ip_hash);
CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON public.user_devices (user_id);
