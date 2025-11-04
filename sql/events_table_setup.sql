-- ============================================
-- Events Table Complete Setup for Supabase
-- Run these commands in your Supabase SQL Editor
-- ============================================
-- This file sets up everything needed for the events table with RAG support:
-- 1. Events table creation
-- 2. pgvector extension for semantic search
-- 3. Vector embedding column
-- 4. Indexes for performance
-- 5. Vector similarity search function
-- ============================================


-- ============================================
-- STEP 1: Create Events Table
-- ============================================
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location TEXT,
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index on start_time for efficient date-based queries
CREATE INDEX IF NOT EXISTS events_start_time_idx ON events(start_time);

-- Create index on title for text search
CREATE INDEX IF NOT EXISTS events_title_idx ON events USING gin(to_tsvector('english', title));


-- ============================================
-- STEP 2: Enable pgvector Extension
-- ============================================
-- This enables vector operations in PostgreSQL for semantic search
CREATE EXTENSION IF NOT EXISTS vector;


-- ============================================
-- STEP 3: Add Embedding Column for RAG
-- ============================================
-- Add a 384-dimensional vector column for embeddings
-- (384 dimensions matches the all-MiniLM-L6-v2 model output)
ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding vector(384);


-- ============================================
-- STEP 4: Create Vector Similarity Index
-- ============================================
-- This speeds up vector similarity queries using IVFFlat algorithm
-- The index uses cosine similarity for semantic search
CREATE INDEX IF NOT EXISTS events_embedding_idx ON events 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);


-- ============================================
-- STEP 5: Create Vector Search Function
-- ============================================
-- This function performs semantic search on events using cosine similarity
-- Parameters:
--   query_embedding: The embedding vector of the user's query (384 dimensions)
--   match_threshold: Minimum similarity score (0-1, default 0.5)
--   match_count: Maximum number of results to return (default 5)
-- Returns:
--   Matching events with similarity scores, ordered by relevance
CREATE OR REPLACE FUNCTION match_events(
  query_embedding vector(384),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id bigint,
  title text,
  description text,
  start_time timestamptz,
  end_time timestamptz,
  location text,
  url text,
  embedding vector(384),
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    events.id,
    events.title,
    events.description,
    events.start_time,
    events.end_time,
    events.location,
    events.url,
    events.embedding,
    (1 - (events.embedding <=> query_embedding))::float as similarity
  FROM events
  WHERE events.embedding IS NOT NULL
    AND 1 - (events.embedding <=> query_embedding) > match_threshold
  ORDER BY events.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ============================================
-- STEP 6: Create Trigger for Updated Timestamp
-- ============================================
-- Automatically update the updated_at column when a row is modified
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_events_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


-- ============================================
-- VERIFICATION QUERIES (Optional)
-- ============================================
-- Run these queries to verify the setup was successful

-- 1. Check if events table was created
SELECT table_name, column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'events'
ORDER BY ordinal_position;

-- 2. Check if pgvector extension is enabled
SELECT * FROM pg_extension WHERE extname = 'vector';

-- 3. Check if embedding column was added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'events' AND column_name = 'embedding';

-- 4. Check if indexes were created
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'events'
ORDER BY indexname;

-- 5. Check if match_events function was created
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname = 'match_events';

-- 6. Check if trigger was created
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_table = 'events';

-- 7. Count events with and without embeddings (after data is added)
SELECT 
  COUNT(*) as total_events,
  COUNT(embedding) as events_with_embeddings,
  COUNT(*) - COUNT(embedding) as events_without_embeddings
FROM events;


-- ============================================
-- SAMPLE QUERIES FOR TESTING
-- ============================================

-- Insert a sample event (optional, for testing)
-- INSERT INTO events (title, description, start_time, location, url) 
-- VALUES (
--   'Kathakali Festival 2026',
--   'A spectacular showcase of traditional Kathakali dance performances',
--   '2026-05-01 19:00:00+00',
--   'Esplanade Theatre, Singapore',
--   'https://example.com/kathakali-2026'
-- );

-- Query all events
-- SELECT id, title, start_time, location FROM events ORDER BY start_time DESC;

-- Query upcoming events
-- SELECT id, title, start_time, location 
-- FROM events 
-- WHERE start_time >= NOW()
-- ORDER BY start_time ASC;

-- Test vector search (requires embedding data)
-- SELECT id, title, similarity 
-- FROM match_events('[0.1, 0.2, ...]'::vector, 0.3, 5);


-- ============================================
-- NOTES
-- ============================================
-- 1. The events table uses BIGSERIAL for id (auto-incrementing)
-- 2. start_time is required; end_time is optional
-- 3. The embedding column is populated by the application (not in SQL)
-- 4. Vector similarity search uses cosine distance (<=> operator)
-- 5. IVFFlat index improves performance but requires training after data insertion
-- 6. Adjust match_threshold (0.3-0.5) based on your precision/recall needs
-- 7. The trigger automatically updates updated_at on any row modification
