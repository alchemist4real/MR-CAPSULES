-- Migration to support multiple couple packages and eliminate single-row id=1 constraint
ALTER TABLE public.couple_config DROP CONSTRAINT IF EXISTS couple_config_id_check;

-- Ensure an auto-incrementing sequence for id
CREATE SEQUENCE IF NOT EXISTS couple_config_id_seq;
SELECT setval('couple_config_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM public.couple_config), 0) + 1, 2), false);
ALTER TABLE public.couple_config ALTER COLUMN id SET DEFAULT nextval('couple_config_id_seq');
ALTER SEQUENCE couple_config_id_seq OWNED BY public.couple_config.id;

-- Add package details and status columns if they do not exist
ALTER TABLE public.couple_config
  ADD COLUMN IF NOT EXISTS package_name TEXT DEFAULT 'Couple Package',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Indexing for fast lookups by partner email and active status
CREATE INDEX IF NOT EXISTS idx_couple_partner1_email ON public.couple_config (partner1_email);
CREATE INDEX IF NOT EXISTS idx_couple_partner2_email ON public.couple_config (partner2_email);
CREATE INDEX IF NOT EXISTS idx_couple_is_active ON public.couple_config (is_active);
