-- Migration: Create unified user activity logs and admin action logs
-- Timestamp: 2026-10-21 22:25:00

-- 1. Create admin_action_logs table for immutable audit trail
CREATE TABLE IF NOT EXISTS public.admin_action_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    admin_email TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    ip_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at 
    ON public.admin_action_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_action 
    ON public.admin_action_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_email 
    ON public.admin_action_logs (admin_email, created_at DESC);

ALTER TABLE public.admin_action_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on admin_action_logs" 
    ON public.admin_action_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);


-- 2. Create user_activity_logs table for student/guest telemetry
CREATE TABLE IF NOT EXISTS public.user_activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    user_email TEXT,
    user_role TEXT DEFAULT 'user',
    is_guest BOOLEAN DEFAULT false,
    session_id TEXT,
    device_id TEXT,
    event_type TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    payload JSONB DEFAULT '{}'::jsonb,
    ip_hash TEXT,
    geo_city TEXT,
    geo_country TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_created_at 
    ON public.user_activity_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_user_id 
    ON public.user_activity_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_email 
    ON public.user_activity_logs (user_email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_event_type 
    ON public.user_activity_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_severity 
    ON public.user_activity_logs (severity) 
    WHERE severity IN ('warning', 'security', 'error');

ALTER TABLE public.user_activity_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on user_activity_logs" 
    ON public.user_activity_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
