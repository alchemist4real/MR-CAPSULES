CREATE TABLE IF NOT EXISTS public.couple_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    partner1_email TEXT NOT NULL,
    partner1_user_id UUID,
    partner2_email TEXT NOT NULL,
    partner2_user_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.couple_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access for couple_config" ON public.couple_config
    FOR SELECT USING (true);;
