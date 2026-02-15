const embeddingService = require('./embeddingService');

/**
 * Music RAG Service
 * Handles music and ragam-related queries with RAG capabilities
 */
class MusicService {
  /**
   * Search for similar music/ragam using semantic search
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - Search query
   * @param {number} limit - Maximum number of results (default: 5)
   * @param {number} threshold - Similarity threshold (default: 0.3)
   * @returns {Promise<Array>} Array of similar music pieces
   */
  async searchSimilarMusic(supabase, query, limit = 5, threshold = 0.3) {
    try {
      console.log(
        `🎵 [MusicService] Searching for music similar to: "${query}"`,
      );

      // Generate embedding for the query
      const queryEmbedding = await embeddingService.generateEmbedding(query);

      // Perform vector similarity search
      const { data: music, error } = await supabase.rpc('match_music', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
      });

      if (error) {
        console.error('❌ [MusicService] Vector search error:', error);
        // Fallback to text search if vector search fails
        return await this.fallbackTextSearch(supabase, query, limit);
      }

      if (!music || music.length === 0) {
        console.log(
          '🔍 [MusicService] No vector matches found, trying text search...',
        );
        return await this.fallbackTextSearch(supabase, query, limit);
      }

      console.log(
        `✅ [MusicService] Found ${music.length} similar music pieces`,
      );
      return music;
    } catch (error) {
      console.error('❌ [MusicService] Error in similarity search:', error);
      // Fallback to text search
      // eslint-disable-next-line no-return-await
      return await this.fallbackTextSearch(supabase, query, limit);
    }
  }

  /**
   * Fallback text search when vector search fails
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - Search query
   * @param {number} limit - Maximum number of results
   * @returns {Promise<Array>} Array of matching music pieces
   */
  async fallbackTextSearch(supabase, query, limit) {
    try {
      console.log(
        `🔄 [MusicService] Performing fallback text search for: "${query}"`,
      );

      const searchTerms = query
        .toLowerCase()
        .split(' ')
        .filter((term) => term.length > 2);

      let searchQuery = supabase.from('music').select('*');

      if (searchTerms.length > 0) {
        // Build search conditions for multiple fields
        const searchConditions = searchTerms
          .map(
            (term) =>
              `name.ilike.%${term}%,ragam_name.ilike.%${term}%,artist.ilike.%${term}%,description.ilike.%${term}%,raga_characteristics.ilike.%${term}%,emotional_context.ilike.%${term}%`,
          )
          .join(',');

        searchQuery = searchQuery.or(searchConditions);
      }

      const { data: music, error } = await searchQuery.limit(limit);

      if (error) {
        console.error('❌ [MusicService] Fallback search error:', error);
        return [];
      }

      console.log(
        `✅ [MusicService] Fallback search found ${music?.length || 0} music pieces`,
      );
      return music || [];
    } catch (error) {
      console.error('❌ [MusicService] Error in fallback search:', error);
      return [];
    }
  }

  /**
   * Get music information for RAG context
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - User query
   * @param {Object} parameters - Query parameters from categorization
   * @returns {Promise<Object>} RAG context and music data
   */
  async getMusicContext(supabase, query, parameters = {}) {
    try {
      console.log(`🎼 [MusicService] Getting music context for: "${query}"`);

      let musicPieces = [];

      // If specific ragam is mentioned, try to find it first
      if (parameters.ragam_name) {
        const { data: specificRagam, error } = await supabase
          .from('music')
          .select('*')
          .or(
            `name.ilike.%${parameters.ragam_name}%,ragam_name.ilike.%${parameters.ragam_name}%`,
          )
          .limit(3);

        if (!error && specificRagam && specificRagam.length > 0) {
          musicPieces = specificRagam;
        }
      }

      // If specific character is mentioned, search by associated characters
      if (musicPieces.length === 0 && parameters.associated_character) {
        const { data: characterMusic, error } = await supabase
          .from('music')
          .select('*')
          .contains('associated_characters', [parameters.associated_character])
          .limit(3);

        if (!error && characterMusic && characterMusic.length > 0) {
          musicPieces = characterMusic;
        }
      }

      // If no specific music found, do semantic search
      if (musicPieces.length === 0) {
        let searchQuery = query;

        // Enhance search query with additional parameters
        if (parameters.music_type) {
          searchQuery = `${query} ${parameters.music_type}`;
        }

        musicPieces = await this.searchSimilarMusic(
          supabase,
          searchQuery,
          5,
          0.2,
        );
      }

      if (musicPieces.length === 0) {
        console.log('⚠️ [MusicService] No music found for query');
        return {
          hasContext: false,
          music: [],
          contextMessage:
            'No specific music or ragam information found for your query.',
        };
      }

      // Format music pieces for context
      const musicContext = musicPieces
        .map((piece, index) => {
          const metadata = piece.metadata || {};
          const characters = piece.associated_characters || [];

          return `
Music Piece ${index + 1}:
- Name: ${piece.name}
- Ragam: ${piece.ragam_name || 'Not specified'}
- Artist/Composer: ${piece.artist || 'Traditional'}
- Performance Type: ${piece.performance_type || 'Classical'}
- Description: ${piece.description || 'No description available'}
- Raga Characteristics: ${piece.raga_characteristics || 'Not specified'}
- Emotional Context: ${piece.emotional_context || 'Not specified'}
- Associated Characters: ${characters.length > 0 ? characters.join(', ') : 'None specified'}
${piece.tempo ? `- Tempo: ${piece.tempo}` : ''}
${piece.tala ? `- Tala (Rhythm): ${piece.tala}` : ''}
${metadata.tempo ? `- Tempo: ${metadata.tempo}` : ''}
${metadata.tala ? `- Tala: ${metadata.tala}` : ''}
${metadata.style ? `- Style: ${metadata.style}` : ''}
${metadata.complexity ? `- Complexity: ${metadata.complexity}` : ''}
${metadata.spiritual_context ? `- Spiritual Context: ${metadata.spiritual_context}` : ''}
${metadata.emotional_intensity ? `- Emotional Intensity: ${metadata.emotional_intensity}` : ''}
`;
        })
        .join('\n');

      console.log(
        `✅ [MusicService] Generated context for ${musicPieces.length} music pieces`,
      );

      return {
        hasContext: true,
        music: musicPieces,
        contextMessage: `Here are the relevant Kathakali music pieces and ragams from our database:\n\n${musicContext}`,
      };
    } catch (error) {
      console.error('❌ [MusicService] Error generating music context:', error);
      return {
        hasContext: false,
        music: [],
        contextMessage: 'Unable to retrieve music information at this time.',
      };
    }
  }

  /**
   * Generate system message for music queries
   * @param {Object} contextData - Context data from getMusicContext
   * @param {string} conversationHistory - Previous conversation context
   * @returns {string} System message for LLM
   */
  generateSystemMessage(contextData, conversationHistory = '') {
    const baseMessage =
      'You are a helpful assistant for a Kathakali cultural chatbot specializing in traditional music, ragams, and rhythmic elements.';

    if (!contextData.hasContext) {
      return `${baseMessage} The user is asking about Kathakali music or ragams, but no specific music information was found. Please provide general information about Kathakali music, ragams, rhythm patterns (tala), and their role in performances.${conversationHistory}`;
    }

    return `${baseMessage} The user is asking about Kathakali music or ragams. Here is the relevant information from our music database:

${contextData.contextMessage}

Please use this information to answer the user's question accurately. Explain the musical concepts, the characteristics of the ragams, their emotional contexts, and how they relate to specific Kathakali characters and performances. Be educational about the musical traditions and their cultural significance in Kathakali.${conversationHistory}`;
  }
}

// Create singleton instance
const musicService = new MusicService();

module.exports = musicService;
