# culture-web-be

## Local development: start here

Use KathakalAI's shared development Supabase `rzokzctxdqagnmhqhrqd`;
production is separate: `cxtsnupbfqqosvzhwqyw`.
Obtain dev keys and other env values from the current maintainer (or a previous
maintainer if nobody is currently working on the project), copy `.env.example` to `.env`
without overwriting existing settings, then run `npm ci`,
`npm run check:dev` and `npm run dev`.
Configure the sibling frontend for the same project before checking.
Follow [the setup guide](docs/development-environment.md) for external KB
dependencies, separate application signup and maintainer-provisioned KB roles.
The existing hosted dev schema needs no migration during onboarding.

The older table-maintenance notes below are reference material, not onboarding steps.

# Events Table Setup Guide

## Overview

This guide explains how to set up the events table in Supabase with full RAG (Retrieval Augmented Generation) support for semantic search.

## Quick Start

1. **Open Supabase SQL Editor**
   - Go to your Supabase project dashboard
   - Navigate to the SQL Editor

2. **Run the Setup Script**
   - Copy the contents of `sql/events_table_setup.sql`
   - Paste into the SQL Editor
   - Click "Run" or press `Ctrl/Cmd + Enter`

3. **Verify Installation**
   - The script includes verification queries at the end
   - Check the query results to confirm:
     - ✅ Events table created
     - ✅ pgvector extension enabled
     - ✅ Embedding column added
     - ✅ Indexes created
     - ✅ match_events function created
     - ✅ Triggers set up

## What Gets Created

### 1. Events Table
```sql
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location TEXT,
  url TEXT,
  embedding vector(384),  -- For semantic search
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

### 2. Indexes
- **events_start_time_idx**: Fast date-based queries
- **events_title_idx**: Text search on titles
- **events_embedding_idx**: Vector similarity search (IVFFlat)

### 3. Vector Search Function
```sql
match_events(
  query_embedding vector(384),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5
)
```

### 4. Auto-Update Trigger
Automatically updates `updated_at` timestamp on row modifications.

## Usage Examples

### Insert Events
```sql
INSERT INTO events (title, description, start_time, location, url) 
VALUES (
  'Kathakali Festival 2026',
  'A spectacular showcase of traditional Kathakali dance performances',
  '2026-05-01 19:00:00+00',
  'Esplanade Theatre, Singapore',
  'https://example.com/kathakali-2026'
);
```

### Query Upcoming Events
```sql
SELECT id, title, start_time, location 
FROM events 
WHERE start_time >= NOW()
ORDER BY start_time ASC
LIMIT 10;
```

### Query Past Events
```sql
SELECT id, title, start_time, location 
FROM events 
WHERE start_time < NOW()
ORDER BY start_time DESC
LIMIT 10;
```

### Vector Similarity Search
```sql
-- Note: Requires embeddings to be populated first
SELECT id, title, similarity 
FROM match_events(
  '[0.1, 0.2, ...]'::vector,  -- Query embedding
  0.3,                          -- Threshold
  5                             -- Max results
);
```

## Application Integration

### 1. Generate Embeddings
The application automatically generates embeddings for events using the `embeddingService`:

```javascript
const embeddingService = require('./services/embeddingService');

// Generate embedding for a new event
const embedding = await embeddingService.generateEventEmbedding(event);
```

### 2. Semantic Search
Use the embedding service to search for similar events:

```javascript
const results = await embeddingService.searchSimilarEvents(
  supabase,
  userQuery,           // User's query text
  10,                  // Number of results
  true,                // Upcoming only
  0.3                  // Similarity threshold
);
```

### 3. Auto-Embedding on Insert
The `eventScraperJob` automatically generates embeddings for new events:

```javascript
// In entities/eventScraperJob.js
const embedding = await embeddingService.generateEventEmbedding(newEvent);
await supabase.from('events').insert({
  ...newEvent,
  embedding
});
```

## Configuration

### Similarity Threshold
Adjust based on precision vs. recall needs:
- **0.5+**: High precision, fewer results
- **0.3-0.5**: Balanced (recommended)
- **0.0-0.3**: High recall, more results

### Embedding Dimensions
- **384 dimensions**: Matches `all-MiniLM-L6-v2` model
- Do NOT change without updating the model

### IVFFlat Index
- **lists = 100**: Good for small-medium datasets (< 100k rows)
- Increase for larger datasets
- Requires reindexing after bulk inserts

## Maintenance

### Reindex After Bulk Inserts
```sql
REINDEX INDEX events_embedding_idx;
```

### Check Index Usage
```sql
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan as index_scans
FROM pg_stat_user_indexes
WHERE tablename = 'events';
```

### Update Embeddings
If you change the embedding model or need to regenerate:

```bash
node scripts/backfillEmbeddings.js
```

## Troubleshooting

### Issue: No results from vector search
**Solutions:**
1. Check if embeddings exist: `SELECT COUNT(*) FROM events WHERE embedding IS NOT NULL;`
2. Lower the similarity threshold (try 0.2 or 0.3)
3. Verify embedding dimensions match (384)

### Issue: Slow queries
**Solutions:**
1. Ensure indexes are created: `SELECT * FROM pg_indexes WHERE tablename = 'events';`
2. Run `ANALYZE events;` to update query planner statistics
3. Consider increasing IVFFlat lists for larger datasets

### Issue: Embeddings not auto-generating
**Solutions:**
1. Check if the cron job is running
2. Verify environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
3. Check application logs for errors

## Additional Resources

- [pgvector Documentation](https://github.com/pgvector/pgvector)
- [Supabase Vector Search Guide](https://supabase.com/docs/guides/ai/vector-search)
- [Embedding Service Code](../services/embeddingService.js)
- [Event Scraper Code](../entities/eventScraperJob.js)
