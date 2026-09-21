-- Quiz Session + Question Tables (Supabase/Postgres)
-- Stores generated quizzes so grading and proficiency updates are deterministic.

-- Enable UUID generation (Supabase typically allows this)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS quiz_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  source TEXT NOT NULL DEFAULT 'adaptive',
  selected_concepts JSONB,
  policy_version TEXT,
  session_state JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quiz_session_user_id ON quiz_session(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_session_created_at ON quiz_session(created_at);

CREATE TABLE IF NOT EXISTS quiz_question (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES quiz_session(id) ON DELETE CASCADE,
  display_id INT,
  concept_id VARCHAR(255) NOT NULL,
  target_level bloom_level_enum NOT NULL,
  misconception_target BOOLEAN NOT NULL DEFAULT FALSE,
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_answer TEXT NOT NULL,
  explanation TEXT,
  distractor_map JSONB,
  sequence_no INT,
  selected_answer TEXT,
  is_correct BOOLEAN,
  response_ms INT,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quiz_question_quiz_id ON quiz_question(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_question_concept_id ON quiz_question(concept_id);

-- Upgrade existing installations without requiring table recreation.
ALTER TABLE quiz_session ADD COLUMN IF NOT EXISTS policy_version TEXT;
ALTER TABLE quiz_session ADD COLUMN IF NOT EXISTS session_state JSONB;
ALTER TABLE quiz_session ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE quiz_question ADD COLUMN IF NOT EXISTS sequence_no INT;
ALTER TABLE quiz_question ADD COLUMN IF NOT EXISTS selected_answer TEXT;
ALTER TABLE quiz_question ADD COLUMN IF NOT EXISTS is_correct BOOLEAN;
ALTER TABLE quiz_question ADD COLUMN IF NOT EXISTS response_ms INT;
ALTER TABLE quiz_question ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_question_sequence
  ON quiz_question(quiz_id, sequence_no)
  WHERE sequence_no IS NOT NULL;

-- Enable Row Level Security (RLS)
ALTER TABLE quiz_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_question ENABLE ROW LEVEL SECURITY;

-- Policies (users can only see/insert their own quiz sessions)
DO $$ BEGIN
  CREATE POLICY "Users can view their own quizzes" ON quiz_session
    FOR SELECT USING (auth.uid()::text = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert their own quizzes" ON quiz_session
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own quizzes" ON quiz_session
    FOR UPDATE USING (auth.uid()::text = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policies for questions: user can access questions through their quiz sessions
DO $$ BEGIN
  CREATE POLICY "Users can view their own quiz questions" ON quiz_question
    FOR SELECT USING (
      EXISTS (
        SELECT 1
        FROM quiz_session s
        WHERE s.id = quiz_question.quiz_id
          AND s.user_id = auth.uid()::text
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert questions for their quizzes" ON quiz_question
    FOR INSERT WITH CHECK (
      EXISTS (
        SELECT 1
        FROM quiz_session s
        WHERE s.id = quiz_question.quiz_id
          AND s.user_id = auth.uid()::text
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update questions for their quizzes" ON quiz_question
    FOR UPDATE USING (
      EXISTS (
        SELECT 1
        FROM quiz_session s
        WHERE s.id = quiz_question.quiz_id
          AND s.user_id = auth.uid()::text
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
