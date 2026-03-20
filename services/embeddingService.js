/**
 * Embedding Service
 * Handles text embedding generation and vector similarity search
 * Uses the all-MiniLM-L6-v2 model (384 dimensions)
 * Supports two-stage retrieval with optional reranking
 */
const rerankerService = require('./rerankerService');

class EmbeddingService {
  constructor() {
    this.embedder = null;
    this.modelName = 'Xenova/all-MiniLM-L6-v2';
    this.enableReranking = true; // Can be toggled based on performance needs
  }

  /**
   * Initialize the embedding model
   * Lazy loads the model on first use
   */
  async initialize() {
    if (!this.embedder) {
      console.log('Loading embedding model:', this.modelName);
      // eslint-disable-next-line node/no-unsupported-features/es-syntax
      const { pipeline } = await import('@xenova/transformers');

      this.embedder = await pipeline('feature-extraction', this.modelName);
      console.log('Embedding model loaded successfully');
    }
    return this.embedder;
  }

  /**
   * Generate embedding for a single text
   * @param {string} text - Text to embed
   * @returns {Promise<Array<number>>} - 384-dimensional embedding vector
   */
  async generateEmbedding(text) {
    await this.initialize();

    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty');
    }

    const output = await this.embedder(text, {
      pooling: 'mean',
      normalize: true,
    });

    // Convert tensor to array
    return Array.from(output.data);
  }

  /**
   * Generate embedding for an event
   * Combines title, description, and time information
   * @param {Object} event - Event object with title, description, start_time, end_time
   * @returns {Promise<Array<number>>} - 384-dimensional embedding vector
   */
  async generateEventEmbedding(event) {
    const {
      title,
      description,
      start_time: startTime,
      end_time: endTime,
    } = event;

    // Create a rich text representation of the event
    let eventText = '';

    if (title) {
      eventText += `Event: ${title}\n`;
    }

    if (description) {
      eventText += `Description: ${description}\n`;
    }

    if (startTime) {
      const startDate = new Date(startTime);
      eventText += `Starts: ${startDate.toLocaleString()}\n`;
    }

    if (endTime) {
      const endDate = new Date(endTime);
      eventText += `Ends: ${endDate.toLocaleString()}\n`;
    }

    return this.generateEmbedding(eventText.trim());
  }

  /**
   * Perform vector similarity search in Supabase
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - User query text
   * @param {number} limit - Number of results to return (default: 5)
   * @param {boolean} upcomingOnly - Only return upcoming events (default: true)
   * @param {number} threshold - Similarity threshold (default: 0.5)
   * @returns {Promise<Array>} - Array of similar events with similarity scores
   */
  async searchSimilarEvents(
    supabase,
    query,
    limit = 5,
    upcomingOnly = true,
    threshold = 0.5,
  ) {
    // Generate embedding for the query
    const queryEmbedding = await this.generateEmbedding(query);

    // Build the RPC call for vector similarity search
    let rpcQuery = supabase.rpc('match_events', {
      query_embedding: queryEmbedding,
      match_threshold: threshold, // Use custom threshold
      match_count: limit,
    });

    // If we want only upcoming events, filter by start_time
    if (upcomingOnly) {
      const currentDateTime = new Date().toISOString();
      rpcQuery = rpcQuery.gte('start_time', currentDateTime);
    }

    const { data, error } = await rpcQuery;

    if (error) {
      console.error('Error searching similar events:', error);
      throw new Error(`Failed to search similar events: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Local knowledge base hybrid search using pgvector + keyword/question matching
   * Combines:
   * 1. Vector similarity search for semantic matching
   * 2. Keyword boosting for exact term matches
   * 3. Question matching to bridge semantic gap
   * @param {import('pg').Pool} pool - pg Pool for local DB
   * @param {string} query - user query
   * @param {number} limit - max results
   * @param {number} similarityThreshold - minimum similarity (0..1)
   * @returns {Promise<Array>} rows with content and similarity
   */
  async searchLocalKnowledgeBase(
    pool,
    query,
    limit = 5,
    similarityThreshold = 0.35,
    scoringWeights = { vectorWeight: 0.7, fullTextWeight: 0.3 },
    retrievalOptions = {},
  ) {
    const embedding = await this.generateEmbedding(query);

    // Format embedding as pgvector string: [0.1, 0.2, 0.3]
    const embeddingVector = `[${embedding.join(',')}]`;

    // Normalize query for keyword matching
    const queryLower = query.toLowerCase();
    const vectorWeight = Number.isFinite(Number(scoringWeights?.vectorWeight))
      ? Math.max(0, Math.min(1, Number(scoringWeights.vectorWeight)))
      : 0.7;
    const fullTextWeight = Number.isFinite(
      Number(scoringWeights?.fullTextWeight),
    )
      ? Math.max(0, Math.min(1, Number(scoringWeights.fullTextWeight)))
      : 0.3;
    const totalWeight = vectorWeight + fullTextWeight;
    const normalizedVectorWeight =
      totalWeight > 0 ? vectorWeight / totalWeight : 0.7;
    const normalizedFullTextWeight =
      totalWeight > 0 ? fullTextWeight / totalWeight : 0.3;
    const deployTarget =
      typeof retrievalOptions?.deployTarget === 'string' &&
      retrievalOptions.deployTarget.trim().length > 0
        ? retrievalOptions.deployTarget.trim().toLowerCase()
        : null;

    const sql = `
      SELECT 
        id, 
        content, 
        source_file, 
        metadata, 
        created_at,
        1 - (embedding <=> $1::vector) AS base_similarity,
        -- Calculate keyword boost
        CASE 
          WHEN metadata->>'keywords' IS NOT NULL THEN
            (
              SELECT COUNT(*) * 0.1
              FROM jsonb_array_elements_text((metadata->'keywords')::jsonb) AS keyword
              WHERE $3 ILIKE '%' || keyword || '%'
            )
          ELSE 0
        END AS keyword_boost,
        -- Calculate question match boost
        CASE 
          WHEN metadata->>'questions' IS NOT NULL THEN
            (
              SELECT MAX(
                CASE 
                  WHEN $3 ILIKE '%' || question || '%' OR question ILIKE '%' || $3 || '%' 
                  THEN 0.15
                  ELSE 0
                END
              )
              FROM jsonb_array_elements_text((metadata->'questions')::jsonb) AS question
            )
          ELSE 0
        END AS question_boost,
        -- Combined similarity score with adjustable vector/full-text weighting
        ((1 - (embedding <=> $1::vector)) * $4) +
        (COALESCE(
          (
            SELECT COUNT(*) * 0.1
            FROM jsonb_array_elements_text((metadata->'keywords')::jsonb) AS keyword
            WHERE $3 ILIKE '%' || keyword || '%'
          ), 0
        ) * $5) +
        (COALESCE(
          (
            SELECT MAX(
              CASE 
                WHEN $3 ILIKE '%' || question || '%' OR question ILIKE '%' || $3 || '%' 
                THEN 0.15
                ELSE 0
              END
            )
            FROM jsonb_array_elements_text((metadata->'questions')::jsonb) AS question
          ), 0
        ) * $5) AS similarity
      FROM knowledge_base
      WHERE (metadata->>'enabled' IS NULL OR metadata->>'enabled' = 'true')
        AND (
          $6::text IS NULL
          OR (
            jsonb_typeof(metadata->'deployTargets') = 'array'
            AND (metadata->'deployTargets') ? $6
          )
          OR metadata->>'deployTarget' IS NULL
          OR metadata->>'deployTarget' = 'shared'
          OR metadata->>'deployTarget' = $6
        )
      ORDER BY similarity DESC
      LIMIT $2;
    `;

    const { rows } = await pool.query(sql, [
      embeddingVector,
      limit,
      queryLower,
      normalizedVectorWeight,
      normalizedFullTextWeight,
      deployTarget,
    ]);
    return (rows || []).filter((r) => {
      const baseSimilarity = Number(r.base_similarity ?? 0);
      const combinedSimilarity = Number(r.similarity ?? 0);
      return (
        baseSimilarity >= similarityThreshold ||
        combinedSimilarity >= similarityThreshold
      );
    });
  }

  /**
   * Delete all vectors for a specific file page
   * @param {import('pg').Pool} pool
   * @param {string} fileName
   * @param {string|number} pageNumber
   */
  async deletePageVectors(pool, fileName, pageNumber) {
    const sql = `DELETE FROM knowledge_base WHERE source_file = $1 AND metadata->>'page' = $2;`;
    await pool.query(sql, [fileName, String(pageNumber)]);
  }

  /**
   * Insert a single chunk with precomputed embedding
   */
  async insertChunk(pool, content, sourceFile, metadata = {}) {
    const embedding = await this.generateEmbedding(content);

    // Format embedding as pgvector string: [0.1, 0.2, 0.3]
    const embeddingVector = `[${embedding.join(',')}]`;

    const sql = `
      INSERT INTO knowledge_base (content, source_file, metadata, embedding)
      VALUES ($1, $2, $3::jsonb, $4::vector)
      RETURNING id;
    `;
    const { rows } = await pool.query(sql, [
      content,
      sourceFile,
      JSON.stringify(metadata),
      embeddingVector,
    ]);
    return rows[0];
  }

  /**
   * Two-stage retrieval: vector search + reranking
   * First retrieves candidates with vector similarity + boosts
   * Then reranks using selected strategy for better precision
   * @param {import('pg').Pool} pool - Database connection pool
   * @param {string} query - User query string
   * @param {number} limit - Number of final results to return
   * @param {number} similarityThreshold - Minimum similarity threshold
   * @param {boolean} useReranking - Enable/disable reranking (default: true)
   * @param {string} strategy - Reranking strategy: 'cross-encoder' or 'embedding-based' (default: 'embedding-based')
   * @returns {Promise<Array>} - Final reranked results
   */
  async searchLocalKnowledgeBaseWithReranking(
    pool,
    query,
    limit = 5,
    similarityThreshold = 0.35,
    useReranking = true,
    strategy = 'embedding-based',
    scoringWeights = { vectorWeight: 0.7, fullTextWeight: 0.3 },
    retrievalOptions = {},
  ) {
    try {
      // Stage 1: Vector search + boost scoring (get more candidates)
      const candidateLimit = Math.max(limit * 3, 15); // Get 3x results for reranking
      const candidates = await this.searchLocalKnowledgeBase(
        pool,
        query,
        candidateLimit,
        similarityThreshold,
        scoringWeights,
        retrievalOptions,
      );

      if (!candidates || candidates.length === 0) {
        console.log('[TWO-STAGE] No candidates found in stage 1');
        return [];
      }

      console.log(
        `[TWO-STAGE] Stage 1 retrieved ${candidates.length} candidates (strategy: ${strategy})`,
      );

      // Stage 2: Reranking (if enabled and available)
      let reranked = candidates;
      if (useReranking && this.enableReranking) {
        try {
          // Use selected reranking strategy
          reranked = await rerankerService.rerank(query, candidates, strategy);
          console.log(
            `[TWO-STAGE] Stage 2 reranked using ${strategy} strategy`,
          );

          // Log top 3 scores for debugging
          const topScores = reranked.slice(0, 3).map((r, i) => ({
            rank: i + 1,
            file: r.source_file,
            original: (r.original_similarity || 0).toFixed(4),
            reranker: (r.reranker_score || 0).toFixed(4),
            strategy: r.strategy || strategy,
          }));
          console.log('[TWO-STAGE] Top 3 scores:', topScores);
        } catch (rerankerError) {
          console.warn(
            'Reranking failed, using stage 1 results:',
            rerankerError.message,
          );
          // Degrade gracefully: use original results
        }
      }

      // Return final limit
      return reranked.slice(0, limit);
    } catch (error) {
      console.error('Error in two-stage retrieval:', error);
      // Fallback to simple search
      return this.searchLocalKnowledgeBase(
        pool,
        query,
        limit,
        similarityThreshold,
        scoringWeights,
        retrievalOptions,
      );
    }
  }
}

// Create singleton instance
const embeddingService = new EmbeddingService();

module.exports = embeddingService;
