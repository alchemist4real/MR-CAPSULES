CREATE TABLE IF NOT EXISTS divisions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO divisions VALUES 
  ('management', 'Management & Innovation', 'Bagi tugas, evaluasi, inovasi'),
  ('development', 'Development Division', 'Membuat konten, inovasi'),
  ('review', 'Database Review & QA', 'Cek jawaban dan soal di HTML')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS division_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  division_id TEXT NOT NULL REFERENCES divisions(id),
  whatsapp TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, division_id)
);

CREATE TABLE IF NOT EXISTS content_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  semester TEXT,
  block TEXT,
  category TEXT,
  target_path TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('draft','open','in_progress','developed','in_review','done','rejected')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  created_by UUID REFERENCES auth.users(id),
  assigned_to UUID REFERENCES auth.users(id),
  reviewed_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  assigned_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  review_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS task_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES content_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES content_tasks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  points INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contributions_user_date ON contributions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES content_tasks(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES auth.users(id),
  issue_type TEXT NOT NULL,
  question_index INT,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','fixed','wontfix')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION check_user_contribution(uid UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM contributions 
    WHERE user_id = uid 
    AND created_at > NOW() - INTERVAL '30 days'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
;
