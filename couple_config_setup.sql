-- Couple Config table: stores the active couple package configuration.
-- Only 1 row should ever exist (singleton pattern enforced by CHECK constraint).
-- This replaces the in-memory Set that was lost on every cold start / deploy.

CREATE TABLE IF NOT EXISTS public.couple_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton: only id=1 allowed
    partner1_email TEXT NOT NULL,
    partner1_user_id UUID,
    partner2_email TEXT NOT NULL,
    partner2_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.couple_config ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read couple config (needed for leaderboard/point checks)
CREATE POLICY "Allow public read access for couple_config" ON public.couple_config
    FOR SELECT USING (true);

-- Only service role can write (admin actions go through server API with service role key)
-- No INSERT/UPDATE/DELETE policies for anon/authenticated = write blocked at RLS level.
-- Server API uses service_role key which bypasses RLS.

-- Seed with current couple data (Farid & Khesy) so existing setup is preserved
INSERT INTO public.couple_config (id, partner1_email, partner1_user_id, partner2_email, partner2_user_id)
VALUES (
    1,
    'farid.hmzh00@gmail.com',
    '20326419-e37a-4e46-a473-cb013a21acfe',
    'khesyian@gmail.com',
    'a197ddbd-7f7f-44ad-8c77-4fd868607241'
)
ON CONFLICT (id) DO NOTHING;
