const embeddingService = require('./embeddingService');

/**
 * Ornaments RAG Service
 * Handles ornament-related queries with RAG capabilities
 */
class OrnamentsService {
  /**
   * Search for similar ornaments using semantic search
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - Search query
   * @param {number} limit - Maximum number of results (default: 5)
   * @param {number} threshold - Similarity threshold (default: 0.3)
   * @returns {Promise<Array>} Array of similar ornaments
   */
  async searchSimilarOrnaments(supabase, query, limit = 5, threshold = 0.3) {
    try {
      console.log(
        `🔍 [OrnamentsService] Searching for ornaments similar to: "${query}"`,
      );

      // Generate embedding for the query
      const queryEmbedding = await embeddingService.generateEmbedding(query);

      // Perform vector similarity search
      const { data: ornaments, error } = await supabase.rpc('match_ornaments', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
      });

      if (error) {
        console.error('❌ [OrnamentsService] Vector search error:', error);
        // Fallback to text search if vector search fails
        return await this.fallbackTextSearch(supabase, query, limit);
      }

      if (!ornaments || ornaments.length === 0) {
        console.log(
          '🔍 [OrnamentsService] No vector matches found, trying text search...',
        );
        // eslint-disable-next-line no-return-await
        return await this.fallbackTextSearch(supabase, query, limit);
      }

      console.log(
        `✅ [OrnamentsService] Found ${ornaments.length} similar ornaments`,
      );
      return ornaments;
    } catch (error) {
      console.error('❌ [OrnamentsService] Error in similarity search:', error);
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
   * @returns {Promise<Array>} Array of matching ornaments
   */
  async fallbackTextSearch(supabase, query, limit) {
    try {
      console.log(
        `🔄 [OrnamentsService] Performing fallback text search for: "${query}"`,
      );

      const searchTerms = query
        .toLowerCase()
        .split(' ')
        .filter((term) => term.length > 2);

      let searchQuery = supabase.from('ornaments').select('*');

      if (searchTerms.length > 0) {
        // Build search conditions for name and description
        const searchConditions = searchTerms
          .map((term) => `name.ilike.%${term}%,description.ilike.%${term}%`)
          .join(',');

        searchQuery = searchQuery.or(searchConditions);
      }

      const { data: ornaments, error } = await searchQuery.limit(limit);

      if (error) {
        console.error('❌ [OrnamentsService] Fallback search error:', error);
        return [];
      }

      console.log(
        `✅ [OrnamentsService] Fallback search found ${ornaments?.length || 0} ornaments`,
      );
      return ornaments || [];
    } catch (error) {
      console.error('❌ [OrnamentsService] Error in fallback search:', error);
      return [];
    }
  }

  /**
   * Get ornament information for RAG context
   * @param {Object} supabase - Supabase client instance
   * @param {string} query - User query
   * @param {Object} parameters - Query parameters from categorization
   * @returns {Promise<Object>} RAG context and ornaments data
   */
  async getOrnamentContext(supabase, query, parameters = {}) {
    try {
      console.log(
        `🎭 [OrnamentsService] Getting ornament context for: "${query}"`,
      );

      let ornaments = [];

      // If specific ornament is mentioned, try to find it first
      if (parameters.ornament_type) {
        const { data: specificOrnament, error } = await supabase
          .from('ornaments')
          .select('*')
          .ilike('name', `%${parameters.ornament_type}%`)
          .limit(1);

        if (!error && specificOrnament && specificOrnament.length > 0) {
          ornaments = specificOrnament;
        }
      }

      // If no specific ornament found or body part specified, do semantic search
      if (ornaments.length === 0) {
        let searchQuery = query;

        // Enhance search query with body part information
        if (parameters.body_part) {
          searchQuery = `${query} ${parameters.body_part}`;
        }

        ornaments = await this.searchSimilarOrnaments(
          supabase,
          searchQuery,
          5,
          0.2,
        );
      }

      if (ornaments.length === 0) {
        console.log('⚠️ [OrnamentsService] No ornaments found for query');
        return {
          hasContext: false,
          ornaments: [],
          contextMessage:
            'No specific ornament information found for your query.',
        };
      }

      // Format ornaments for context
      const ornamentsContext = ornaments
        .map((ornament, index) => {
          const tooltipPos = ornament.tooltip_position || {};
          const metadata = ornament.metadata || {};

          return `
Ornament ${index + 1}:
- Name: ${ornament.name}
- ID: ${ornament.id}
- Description: ${ornament.description}
- Tooltip Position: Top ${tooltipPos.top || 'N/A'}, Left ${tooltipPos.left || 'N/A'}
- Type: ${metadata.type || 'Not specified'}
- Materials: ${Array.isArray(metadata.materials) ? metadata.materials.join(', ') : metadata.material || 'Not specified'}
${metadata.worn_with ? `- Worn with: ${metadata.worn_with}` : ''}
${metadata.worn_below ? `- Worn below: ${metadata.worn_below}` : ''}
${metadata.worn_over ? `- Worn over: ${metadata.worn_over}` : ''}
${metadata.pieces ? `- Number of pieces: ${metadata.pieces}` : ''}
${metadata.purpose ? `- Purpose: ${metadata.purpose}` : ''}
`;
        })
        .join('\n');

      console.log(
        `✅ [OrnamentsService] Generated context for ${ornaments.length} ornaments`,
      );

      return {
        hasContext: true,
        ornaments: ornaments,
        contextMessage: `Here are the relevant Kathakali ornaments from our database:\n\n${ornamentsContext}`,
      };
    } catch (error) {
      console.error(
        '❌ [OrnamentsService] Error generating ornament context:',
        error,
      );
      return {
        hasContext: false,
        ornaments: [],
        contextMessage: 'Unable to retrieve ornament information at this time.',
      };
    }
  }

  /**
   * Generate system message for ornament queries
   * @param {Object} contextData - Context data from getOrnamentContext
   * @param {string} conversationHistory - Previous conversation context
   * @returns {string} System message for LLM
   */
  generateSystemMessage(contextData, conversationHistory = '') {
    const baseMessage =
      'You are a helpful assistant for a Kathakali cultural chatbot specializing in traditional ornaments and costumes.';

    if (!contextData.hasContext) {
      return `${baseMessage} The user is asking about Kathakali ornaments, but no specific ornament information was found. Please provide general information about Kathakali ornaments and costume elements.${conversationHistory}`;
    }

    return `${baseMessage} The user is asking about Kathakali ornaments. Here is the relevant information from our ornaments database:

${contextData.contextMessage}

Please use this information to answer the user's question accurately. Focus on the specific ornaments mentioned above, their characteristics, materials, and how they are worn. Be informative and educational about the cultural significance of these ornaments in Kathakali performances.${conversationHistory}`;
  }
}

// Create singleton instance
const ornamentsService = new OrnamentsService();

module.exports = ornamentsService;
