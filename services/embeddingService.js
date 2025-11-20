/**
 * Embedding Service
 * Handles text embedding generation and vector similarity search
 * Uses the all-MiniLM-L6-v2 model (384 dimensions)
 */
class EmbeddingService {
  constructor() {
    this.embedder = null;
    this.modelName = 'Xenova/all-MiniLM-L6-v2';
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
}

// Create singleton instance
const embeddingService = new EmbeddingService();

module.exports = embeddingService;
