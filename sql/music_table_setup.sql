-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Music/Ragam table for kathakali music information
CREATE TABLE IF NOT EXISTS music (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  ragam_name TEXT, -- Main ragam name
  artist TEXT, -- Artist/composer name
  performance_type TEXT, -- Type of performance (classical, devotional, etc.)
  description TEXT,
  lyrics TEXT, -- Song lyrics if applicable
  audio_url TEXT, -- URL to audio file
  sheet_music_url TEXT, -- URL to sheet music
  duration INTEGER, -- Duration in seconds
  tempo TEXT, -- Slow, medium, fast
  tala TEXT, -- Rhythm pattern
  raga_characteristics TEXT, -- Characteristics of the raga
  emotional_context TEXT, -- Emotional context/rasa
  associated_characters TEXT[], -- Kathakali characters this music is associated with
  metadata JSONB, -- Additional metadata
  embedding VECTOR(384), -- For semantic search
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Helpful indexes for music
CREATE INDEX IF NOT EXISTS idx_music_name 
  ON music (name);

CREATE INDEX IF NOT EXISTS idx_music_ragam 
  ON music (ragam_name);

CREATE INDEX IF NOT EXISTS idx_music_artist 
  ON music (artist);

CREATE INDEX IF NOT EXISTS idx_music_embedding 
  ON music USING ivfflat (embedding vector_cosine_ops);

-- Full text search index
CREATE INDEX IF NOT EXISTS idx_music_search
  ON music USING gin(to_tsvector('english', 
    coalesce(name, '') || ' ' || 
    coalesce(ragam_name, '') || ' ' || 
    coalesce(artist, '') || ' ' || 
    coalesce(description, '') || ' ' ||
    coalesce(raga_characteristics, '') || ' ' ||
    coalesce(emotional_context, '')
  ));

-- GIN index for associated characters array
CREATE INDEX IF NOT EXISTS idx_music_characters
  ON music USING gin(associated_characters);

-- Trigger to automatically update the updated_at column
DROP TRIGGER IF EXISTS update_music_updated_at ON music;
CREATE TRIGGER update_music_updated_at
  BEFORE UPDATE ON music
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample music data based on the mentioned attributes
-- Function for vector similarity search
CREATE OR REPLACE FUNCTION match_music(
  query_embedding vector(384),
  match_threshold float,
  match_count int
)
RETURNS TABLE (
  id BIGINT,
  name TEXT,
  ragam_name TEXT,
  artist TEXT,
  performance_type TEXT,
  description TEXT,
  lyrics TEXT,
  audio_url TEXT,
  sheet_music_url TEXT,
  duration INTEGER,
  tempo TEXT,
  tala TEXT,
  raga_characteristics TEXT,
  emotional_context TEXT,
  associated_characters TEXT[],
  metadata JSONB,
  similarity float
)
LANGUAGE SQL STABLE
AS $$
  SELECT 
    music.id,
    music.name,
    music.ragam_name,
    music.artist,
    music.performance_type,
    music.description,
    music.lyrics,
    music.audio_url,
    music.sheet_music_url,
    music.duration,
    music.tempo,
    music.tala,
    music.raga_characteristics,
    music.emotional_context,
    music.associated_characters,
    music.metadata,
    1 - (music.embedding <=> query_embedding) AS similarity
  FROM music
  WHERE music.embedding IS NOT NULL
  AND 1 - (music.embedding <=> query_embedding) > match_threshold
  ORDER BY music.embedding <=> query_embedding
  LIMIT match_count;
$$;

INSERT INTO music (name, ragam_name, artist, performance_type, description, raga_characteristics, emotional_context, associated_characters, metadata) VALUES
('Sukumara Nandakumara', 'Sukumara', 'Traditional', 'Classical Kathakali', 'A melodious ragam often used in Kathakali performances depicting gentle and heroic characters', 'Sweet, melodious, and soothing characteristics with ascending and descending patterns that evoke serenity', 'Peaceful, heroic, gentle emotions (Santha and Veera rasa)', ARRAY['Rama', 'Arjuna', 'Nala'], '{"tempo": "medium", "tala": "adi", "traditional": true}'),
('Kottakkal P.D Namboothiri', 'Kottakkal', 'P.D Namboothiri', 'Traditional', 'Associated with the famous Kottakkal style of Kathakali, known for its distinctive musical patterns', 'Complex rhythmic patterns with intricate melodic variations characteristic of the Kottakkal tradition', 'Devotional and spiritual emotions, often used in temple sequences', ARRAY['Hanuman', 'Bhima', 'Krishna'], '{"tempo": "variable", "tala": "triputa", "style": "kottakkal"}'),
('Kottakkal Madhu', 'Kottakkal', 'Madhu', 'Classical', 'Another composition in the Kottakkal tradition, emphasizing the rhythmic complexity', 'Features quick tempo changes and sophisticated melodic progressions', 'Dynamic range from peaceful to intense, suitable for dramatic scenes', ARRAY['Ravana', 'Duryodhana', 'Kichaka'], '{"tempo": "fast", "tala": "eka", "complexity": "high"}'),
('Poothana Moksham', 'Moksham', 'Traditional', 'Devotional', 'A spiritual composition relating to the story of Poothana''s liberation, often used in devotional Kathakali performances', 'Ascending melodic patterns that symbolize spiritual elevation and liberation', 'Spiritual transcendence, devotional fervor (Bhakti rasa)', ARRAY['Krishna', 'Vishnu'], '{"tempo": "slow", "tala": "adi", "spiritual_context": "liberation"}'),
('Anantha Bhairavi', 'Bhairavi', 'Traditional', 'Classical', 'A powerful ragam in the Bhairavi family, known for its intense and dramatic characteristics', 'Deep, intense characteristics with strong emotional impact, often used for serious and dramatic moments', 'Intense emotions, often associated with sorrow, anger, or determination (Karuna, Raudra rasa)', ARRAY['Bheema', 'Ravana', 'Dushshasana'], '{"tempo": "variable", "tala": "adi", "emotional_intensity": "high"}')
ON CONFLICT DO NOTHING;