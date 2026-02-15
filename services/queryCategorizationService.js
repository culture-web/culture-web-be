/* eslint-disable no-param-reassign */
const huggingFaceClient = require('../client/huggingfaceClient');

/**
 * Query Categorization Service
 * Uses LLM to categorize user queries into different types:
 * - event: queries about performances, shows, schedules
 * - ornament: queries about kathakali ornaments, costumes, accessories
 * - music: queries about kathakali music, ragam, songs, rhythm
 * - general: general questions about kathakali, culture, history
 */
class QueryCategorizationService {
  /**
   * Categorize user query and extract relevant parameters using LLM
   * Supports multi-category queries that span multiple domains
   * @param {string} query - User query text
   * @returns {Promise<Object>} - Query categorization result
   * @returns {Array} return.categories - Array of applicable categories with their parameters
   * @returns {string} return.primary_category - The main/most important category
   * @returns {string} return.semantic_query - Overall semantic query
   */
  async categorizeQuery(query) {
    try {
      console.log('Query categorization: Analyzing query with LLM...');
      const client = huggingFaceClient.getInstance();

      const model = process.env.HF_CHAT_MODEL || 'openai/gpt-oss-120b';
      const provider = process.env.HF_CHAT_PROVIDER || 'together';

      const response = await client.chatCompletion({
        provider,
        model,
        messages: [
          {
            role: 'system',
            content: `You are an expert Kathakali cultural consultant and query categorizer. You have deep knowledge of:
- Kathakali ragams (musical scales): Sukumara, Bhairavi, Mohanam, Kalyani, etc.
- Ornaments and costumes: kireedam (crown), chutti (face decoration), thoda (ear ornament), etc.  
- Performance terminology and cultural context

Analyze the user's query and identify ALL applicable categories. A query can belong to multiple categories.

**CRITICAL CATEGORIZATION RULES:**
- ANY query mentioning specific ragam names (like "Sukumara", "Bhairavi", "Mohanam") = MUSIC category
- ANY query about ornament names (like "kireedam", "chutti", "thoda") = ORNAMENT category
- ANY time-related performance queries (upcoming, past, schedule) = EVENT category
- Questions starting "What is [ragam_name]?" = MUSIC category
- Questions starting "What is [ornament_name]?" = ORNAMENT category

Categories:
1. EVENT: Queries about performances, shows, schedules, tickets, venues, dates, bookings
   - Time indicators: "upcoming", "past", "tonight", "this week", "happened", "schedule"
   - Performance terms: "show", "event", "performance", "concert", "festival"

2. ORNAMENT: Queries about kathakali ornaments, costumes, accessories, makeup, dress
   - Common ornaments: kireedam, chutti, thoda, chevippuvu, kazhuthunada
   - Costume terms: "costume", "dress", "wear", "ornament", "decoration", "makeup"

3. MUSIC: Queries about kathakali music, ragam, songs, rhythm, instruments, tala
   - Ragam names: Sukumara, Bhairavi, Mohanam, Kalyani, Kharaharapriya
   - Music terms: "ragam", "raga", "music", "song", "melody", "rhythm", "tala"

4. GENERAL: General questions about kathakali culture, history, stories, characters, techniques
   - Cultural terms: "what is kathakali", "history", "tradition", "culture", "story"

For each category, extract parameters:
EVENT: date_filter ("upcoming"/"past"/"all"), venue
ORNAMENT: ornament_type, body_part  
MUSIC: ragam_name, music_type, associated_character
GENERAL: topic

Respond with ONLY valid JSON:
{
  "categories": [{"category": "...", "semantic_query": "...", "parameters": {...}}],
  "primary_category": "...",
  "semantic_query": "..."
}

**EXAMPLES:**

Query: "What is Sukumara?"
Response: {
  "categories": [{"category": "music", "semantic_query": "Sukumara ragam kathakali music", "parameters": {"ragam_name": "Sukumara", "music_type": null, "associated_character": null}}],
  "primary_category": "music",
  "semantic_query": "Sukumara ragam"
}

Query: "Tell me about Bhairavi ragam"  
Response: {
  "categories": [{"category": "music", "semantic_query": "Bhairavi ragam characteristics", "parameters": {"ragam_name": "Bhairavi", "music_type": null, "associated_character": null}}],
  "primary_category": "music",
  "semantic_query": "Bhairavi ragam"
}

Query: "What is kireedam ornament?"
Response: {
  "categories": [{"category": "ornament", "semantic_query": "kireedam ornament crown", "parameters": {"ornament_type": "kireedam", "body_part": "head"}}],
  "primary_category": "ornament",
  "semantic_query": "kireedam ornament"
}

Query: "Upcoming kathakali shows this week"
Response: {
  "categories": [{"category": "event", "semantic_query": "kathakali shows performances", "parameters": {"date_filter": "upcoming", "venue": null}}],
  "primary_category": "event", 
  "semantic_query": "kathakali shows"
}

Query: "What ornaments are used with Bhairavi performances?"
Response: {
  "categories": [
    {"category": "ornament", "semantic_query": "kathakali ornaments costumes", "parameters": {"ornament_type": null, "body_part": null}},
    {"category": "music", "semantic_query": "Bhairavi ragam performances", "parameters": {"ragam_name": "Bhairavi", "music_type": null, "associated_character": null}}
  ],
  "primary_category": "ornament",
  "semantic_query": "ornaments Bhairavi ragam performances"
}`,
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 300,
        temperature: 0.1,
      });

      const answer = response.choices[0].message.content.trim();
      console.log(`Query categorization: LLM response: "${answer}"`);

      let parsedResponse;
      try {
        const jsonMatch = answer.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error(
          'Query categorization: Failed to parse LLM response:',
          parseError,
        );
        // Default to general category if parsing fails
        return {
          categories: [
            {
              category: 'general',
              semantic_query: query,
              parameters: { topic: 'general' },
            },
          ],
          primary_category: 'general',
          semantic_query: query,
        };
      }

      // Validate and normalize the response structure
      if (
        !parsedResponse.categories ||
        !Array.isArray(parsedResponse.categories) ||
        parsedResponse.categories.length === 0
      ) {
        console.warn(
          'Query categorization: Invalid categories structure, defaulting to general',
        );
        return {
          categories: [
            {
              category: 'general',
              semantic_query: query,
              parameters: { topic: 'general' },
            },
          ],
          primary_category: 'general',
          semantic_query: query,
        };
      }

      // Validate each category
      const validCategories = ['event', 'ornament', 'music', 'general'];
      parsedResponse.categories = parsedResponse.categories.filter((cat) => {
        if (!cat.category || !validCategories.includes(cat.category)) {
          console.warn(
            `Query categorization: Invalid category ${cat.category}, filtering out`,
          );
          return false;
        }
        if (!cat.semantic_query) {
          cat.semantic_query = query;
        }
        if (!cat.parameters) {
          cat.parameters = {};
        }
        return true;
      });

      // Ensure we have at least one category
      if (parsedResponse.categories.length === 0) {
        parsedResponse.categories = [
          {
            category: 'general',
            semantic_query: query,
            parameters: { topic: 'general' },
          },
        ];
      }

      // Validate primary category
      if (
        !parsedResponse.primary_category ||
        !validCategories.includes(parsedResponse.primary_category)
      ) {
        parsedResponse.primary_category = parsedResponse.categories[0].category;
      }

      // Ensure semantic query exists
      if (!parsedResponse.semantic_query) {
        parsedResponse.semantic_query = query;
      }

      console.log('Query categorization: Categorized as:', parsedResponse);
      return parsedResponse;
    } catch (error) {
      console.error('Query categorization: Error analyzing query:', error);
      // Return general category as fallback
      return {
        categories: [
          {
            category: 'general',
            semantic_query: query,
            parameters: { topic: 'general' },
          },
        ],
        primary_category: 'general',
        semantic_query: query,
      };
    }
  }

  /**
   * Check if query is event-related (backwards compatibility)
   * @param {string} query - User query text
   * @returns {Promise<Object|null>} - Event parameters or null if not event-related
   */
  async parseEventQuery(query) {
    const categorization = await this.categorizeQuery(query);

    // Check if any category is event-related
    const eventCategory = categorization.categories.find(
      (cat) => cat.category === 'event',
    );

    if (!eventCategory) {
      return null;
    }

    return {
      semantic_query: eventCategory.semantic_query,
      date_filter: eventCategory.parameters.date_filter || 'upcoming',
      venue: eventCategory.parameters.venue || null,
    };
  }

  /**
   * Get categories by type from categorization result
   * @param {Object} categorization - Result from categorizeQuery
   * @param {string} categoryType - Category type to filter by
   * @returns {Array} Array of categories matching the type
   */
  getCategoriesByType(categorization, categoryType) {
    return categorization.categories.filter(
      (cat) => cat.category === categoryType,
    );
  }

  /**
   * Check if categorization includes a specific category type
   * @param {Object} categorization - Result from categorizeQuery
   * @param {string} categoryType - Category type to check for
   * @returns {boolean} True if category is present
   */
  hasCategory(categorization, categoryType) {
    return categorization.categories.some(
      (cat) => cat.category === categoryType,
    );
  }
}

// Create singleton instance
const queryCategorizationService = new QueryCategorizationService();

module.exports = queryCategorizationService;
