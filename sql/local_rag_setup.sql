-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Knowledge base table for local RAG
CREATE TABLE IF NOT EXISTS knowledge_base (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  source_file TEXT NOT NULL,
  metadata JSONB,
  embedding VECTOR(384),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_kb_source_page 
  ON knowledge_base (source_file, (metadata->>'page'));

CREATE INDEX IF NOT EXISTS idx_kb_embedding 
  ON knowledge_base USING ivfflat (embedding vector_cosine_ops);

-- Job tracking for parsing/re-embedding progress
CREATE TABLE IF NOT EXISTS kb_jobs (
  id BIGSERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed
  progress NUMERIC DEFAULT 0,            -- 0..100
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  last_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_jobs_file_time
  ON kb_jobs (file_name, start_time DESC);

-- Version history for knowledge base files
CREATE TABLE IF NOT EXISTS knowledge_base_versions (
  id BIGSERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  action TEXT NOT NULL, -- ingest_text|ingest_pdf|parse|reembed|rename|set_enabled|delete|restore
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_versions_file_time
  ON knowledge_base_versions (file_name, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_versions_file_version
  ON knowledge_base_versions (file_name, version_number);

-- Optional snapshots for version restore
CREATE TABLE IF NOT EXISTS knowledge_base_version_snapshots (
  id BIGSERIAL PRIMARY KEY,
  version_id BIGINT NOT NULL REFERENCES knowledge_base_versions(id) ON DELETE CASCADE,
  chunks JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_version_snapshots_version
  ON knowledge_base_version_snapshots (version_id);
