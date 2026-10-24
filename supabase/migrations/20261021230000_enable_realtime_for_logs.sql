-- Migration: Enable realtime replication and admin SELECT policies for unified logs
-- Timestamp: 2026-10-21 23:00:00

-- 1. Enable Realtime publication for unified logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'user_activity_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_activity_logs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'admin_action_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_action_logs;
  END IF;
END $$;

-- 2. Allow authenticated admins to view logs in realtime via Supabase client
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'user_activity_logs' 
      AND policyname = 'Admins can view user_activity_logs'
  ) THEN
    CREATE POLICY "Admins can view user_activity_logs"
      ON public.user_activity_logs
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE (ur.identifier = (auth.jwt() ->> 'email') OR ur.identifier = (auth.jwt() -> 'user_metadata' ->> 'username'))
            AND ur.role IN ('admin', 'owner', 'superadmin', 'lead')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'admin_action_logs' 
      AND policyname = 'Admins can view admin_action_logs'
  ) THEN
    CREATE POLICY "Admins can view admin_action_logs"
      ON public.admin_action_logs
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_roles ur
          WHERE (ur.identifier = (auth.jwt() ->> 'email') OR ur.identifier = (auth.jwt() -> 'user_metadata' ->> 'username'))
            AND ur.role IN ('admin', 'owner', 'superadmin', 'lead')
        )
      );
  END IF;
END $$;
