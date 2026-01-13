/**
 * Reranker Service
 * Supports multiple reranking strategies:
 * 1. Cross-encoder: Uses ms-marco-MiniLM-L-6-v2 for semantic ranking
 * 2. Embedding-based: Uses cosine similarity on embeddings (faster, no new model)
 */
const embeddingService = require('./embeddingService');

class RerankerService {
  constructor() {
    this.crossEncoder = null;
    this.crossEncoderModel = 'Xenova/ms-marco-MiniLM-L-6-v2';
    this.supportedStrategies = ['cross-encoder', 'embedding-based'];
  }

  /**
   * Initialize the cross-encoder model (lazy load)
   */
  async initializeCrossEncoder() {
    if (!this.crossEncoder) {
      console.log('Loading cross-encoder model:', this.crossEncoderModel);
      try {
        // eslint-disable-next-line node/no-unsupported-features/es-syntax
        const { pipeline } = await import('@xenova/transformers');
        
        this.crossEncoder = await pipeline('zero-shot-classification', this.crossEncoderModel);
        console.log('Cross-encoder model loaded successfully');
      } catch (err) {
        console.error('Failed to load cross-encoder model:', err);
        throw err;
      }
    }
    return this.crossEncoder;
  }

  /**
   * Rerank using cross-encoder (ms-marco-MiniLM-L-6-v2)
   * @param {string} query - User query
   * @param {Array<Object>} candidates - Candidate documents to rerank
   * @returns {Promise<Array<Object>>} - Reranked candidates with scores
   */
  async reankCrossEncoder(query, candidates) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    try {
      await this.initializeCrossEncoder();

      console.log(`[CROSS-ENCODER] Reranking ${candidates.length} candidates for query: "${query}"`);

      // Prepare candidate texts
      const candidateTexts = candidates.map((doc) => {
        let text = doc.content || '';
        if (doc.source_file) {
          text = `[${doc.source_file}] ${text}`;
        }
        if (doc.metadata?.page) {
          text = `${text} (Page ${doc.metadata.page})`;
        }
        return text.substring(0, 512);
      });

      // Score each candidate
      const scores = [];
      for (let i = 0; i < candidateTexts.length; i += 1) {
        try {
          const result = await this.crossEncoder(query, [candidateTexts[i]], {
            hypothesis_template: 'This document is relevant to the query.',
            multi_class: false,
          });

          const score = result.scores ? result.scores[0] : 0;
          scores.push({
            index: i,
            reranker_score: score,
            original_score: candidates[i].similarity || candidates[i].base_similarity || 0,
          });
        } catch (err) {
          console.warn(`Failed to score candidate ${i}:`, err.message);
          scores.push({
            index: i,
            reranker_score: 0,
            original_score: candidates[i].similarity || candidates[i].base_similarity || 0,
          });
        }
      }

      scores.sort((a, b) => b.reranker_score - a.reranker_score);

      const reranked = scores.map((scoreData) => {
        const original = candidates[scoreData.index];
        return {
          ...original,
          reranker_score: scoreData.reranker_score,
          original_similarity: scoreData.original_score,
          final_score: scoreData.reranker_score,
          strategy: 'cross-encoder',
        };
      });

      console.log(`[CROSS-ENCODER] Top score: ${scores[0]?.reranker_score?.toFixed(4) || 'N/A'}`);
      return reranked;
    } catch (error) {
      console.error('Error in cross-encoder reranking:', error);
      return candidates.sort((a, b) => (b.similarity || b.base_similarity || 0) - (a.similarity || a.base_similarity || 0));
    }
  }

  /**
   * Rerank using embedding-based similarity
   * Re-embeds query and candidates, scores by cosine similarity
   * @param {string} query - User query
   * @param {Array<Object>} candidates - Candidate documents to rerank
   * @returns {Promise<Array<Object>>} - Reranked candidates with scores
   */
  async reankEmbeddingBased(query, candidates) {
    if (!candidates || candidates.length === 0) {
      return [];
    }

    try {
      console.log(`[EMBEDDING-BASED] Reranking ${candidates.length} candidates for query: "${query}"`);

      // Generate query embedding
      const queryEmbedding = await embeddingService.generateEmbedding(query);

      // Score each candidate by cosine similarity
      const scores = [];
      for (let i = 0; i < candidates.length; i += 1) {
        try {
          const candidateEmbedding = await embeddingService.generateEmbedding(candidates[i].content);
          
          // Calculate cosine similarity
          const cosineSim = this.cosineSimilarity(queryEmbedding, candidateEmbedding);
          
          scores.push({
            index: i,
            reranker_score: cosineSim,
            original_score: candidates[i].similarity || candidates[i].base_similarity || 0,
          });
        } catch (err) {
          console.warn(`Failed to embed candidate ${i}:`, err.message);
          scores.push({
            index: i,
            reranker_score: 0,
            original_score: candidates[i].similarity || candidates[i].base_similarity || 0,
          });
        }
      }

      scores.sort((a, b) => b.reranker_score - a.reranker_score);

      const reranked = scores.map((scoreData) => {
        const original = candidates[scoreData.index];
        return {
          ...original,
          reranker_score: scoreData.reranker_score,
          original_similarity: scoreData.original_score,
          final_score: scoreData.reranker_score,
          strategy: 'embedding-based',
        };
      });

      console.log(`[EMBEDDING-BASED] Top score: ${scores[0]?.reranker_score?.toFixed(4) || 'N/A'}`);
      return reranked;
    } catch (error) {
      console.error('Error in embedding-based reranking:', error);
      return candidates.sort((a, b) => (b.similarity || b.base_similarity || 0) - (a.similarity || a.base_similarity || 0));
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array<number>} a - First vector
   * @param {Array<number>} b - Second vector
   * @returns {number} - Cosine similarity score (0-1)
   */
  cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i += 1) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Unified rerank method - dispatches to strategy
   * @param {string} strategy - 'cross-encoder' or 'embedding-based'
   * @param {string} query - User query
   * @param {Array<Object>} candidates - Candidates to rerank
   * @returns {Promise<Array<Object>>} - Reranked results
   */
  async rerank(strategy = 'embedding-based', query, candidates) {
    if (!this.supportedStrategies.includes(strategy)) {
      console.warn(`Unknown strategy: ${strategy}, falling back to embedding-based`);
      strategy = 'embedding-based';
    }

    if (strategy === 'cross-encoder') {
      return this.reankCrossEncoder(query, candidates);
    }
    return this.reankEmbeddingBased(query, candidates);
  }
}

// Create singleton instance
const rerankerService = new RerankerService();

module.exports = rerankerService;
