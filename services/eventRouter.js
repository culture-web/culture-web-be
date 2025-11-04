const huggingFaceClient = require('../client/huggingfaceClient');

/**
 * Event Router Service
 * Determines if a user query is about cultural events using LLM classification
 */
class EventRouter {
  /**
   * Determine if a query is event-related
   * @param {string} query - User query text
   * @returns {Promise<boolean>} - True if query is event-related, false otherwise
   */
  async isEventRelatedQuery(query) {
    try {
      // First, use keyword-based detection for common patterns
      const eventKeywords = [
        'event',
        'show',
        'performance',
        'happening',
        'upcoming',
        'schedule',
        'when is',
        'what is on',
        'whats on',
        'calendar',
        'today',
        'tomorrow',
        'this week',
        'this month',
        'next week',
        'next month',
      ];

      const queryLower = query.toLowerCase();
      const hasEventKeyword = eventKeywords.some((keyword) =>
        queryLower.includes(keyword),
      );

      // Keywords that indicate NON-event queries
      const nonEventKeywords = [
        'what is',
        'explain',
        'tell me about',
        'describe',
        'meaning',
        'represent',
        'mudra',
        'costume',
        'history',
        'tradition',
      ];

      const hasNonEventKeyword = nonEventKeywords.some((keyword) =>
        queryLower.includes(keyword),
      );

      // If it has event keywords and no non-event keywords, likely event-related
      if (hasEventKeyword && !hasNonEventKeyword) {
        console.log('Event router: Classified as event query (keyword match)');
        return true;
      }

      // If it has non-event keywords, likely not event-related
      if (hasNonEventKeyword && !hasEventKeyword) {
        console.log(
          'Event router: Classified as non-event query (keyword match)',
        );
        return false;
      }

      // For ambiguous cases, use LLM classification
      console.log('Event router: Using LLM for classification...');
      const client = huggingFaceClient.getInstance();

      const response = await client.chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: `You are a binary classifier. Determine if the user is asking about EVENTS (performances, shows, schedules, what's happening) or INFORMATION (definitions, explanations, cultural knowledge).

EVENTS examples: "what events", "upcoming shows", "performances this week", "schedule"
INFORMATION examples: "what is", "explain", "tell me about", "history of"

Respond with exactly one word: EVENT or INFO`,
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 5,
        temperature: 0.1,
      });

      const answer = response.choices[0].message.content.trim().toUpperCase();
      console.log(`Event router: LLM response: "${answer}"`);

      // Check if the answer contains "EVENT"
      const isEventQuery = answer.includes('EVENT');
      console.log(
        `Event router: Final classification: ${isEventQuery ? 'EVENT' : 'NON-EVENT'}`,
      );

      return isEventQuery;
    } catch (error) {
      console.error('Error in event router classification:', error);
      // Default to false (non-event query) on error
      return false;
    }
  }
}

// Create singleton instance
const eventRouter = new EventRouter();

module.exports = eventRouter;
