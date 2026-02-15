-- User Proficiency State Table Setup for Supabase
-- This table tracks user's learning progress across the curriculum knowledge graph

-- Create enum for Bloom's taxonomy levels
DO $$ BEGIN
    CREATE TYPE bloom_level_enum AS ENUM (
        '0_unseen',
        '1_remember', 
        '2_understand',
        '3_apply',
        '4_analyze'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create the user proficiency state table
CREATE TABLE IF NOT EXISTS user_proficiency_state (
    user_id VARCHAR(255) NOT NULL,
    node_id VARCHAR(255) NOT NULL,
    bloom_level bloom_level_enum NOT NULL DEFAULT '0_unseen',
    misconception_flag BOOLEAN DEFAULT FALSE,
    last_evidence TEXT,
    last_reasoning TEXT,
    last_confidence FLOAT8 DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Composite primary key
    PRIMARY KEY (user_id, node_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_user_proficiency_user_id ON user_proficiency_state(user_id);
CREATE INDEX IF NOT EXISTS idx_user_proficiency_node_id ON user_proficiency_state(node_id);
CREATE INDEX IF NOT EXISTS idx_user_proficiency_bloom_level ON user_proficiency_state(bloom_level);
CREATE INDEX IF NOT EXISTS idx_user_proficiency_misconception ON user_proficiency_state(misconception_flag) WHERE misconception_flag = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_proficiency_updated_at ON user_proficiency_state(updated_at);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_proficiency_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_proficiency_updated_at ON user_proficiency_state;
CREATE TRIGGER trg_user_proficiency_updated_at
    BEFORE UPDATE ON user_proficiency_state
    FOR EACH ROW
    EXECUTE FUNCTION update_user_proficiency_updated_at();

-- Enable Row Level Security (RLS) for Supabase
ALTER TABLE user_proficiency_state ENABLE ROW LEVEL SECURITY;

-- Create policies for RLS (users can only see their own data)
CREATE POLICY "Users can view their own proficiency" ON user_proficiency_state
    FOR SELECT USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert their own proficiency" ON user_proficiency_state
    FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update their own proficiency" ON user_proficiency_state
    FOR UPDATE USING (auth.uid()::text = user_id);

-- Note: We don't allow DELETE to preserve learning history
-- CREATE POLICY "Users can delete their own proficiency" ON user_proficiency_state
--     FOR DELETE USING (auth.uid()::text = user_id);