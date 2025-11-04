const huggingFaceClient = require('../client/huggingfaceClient');

/**
 * Event Router Service
 * Uses LLM to extract structured event search parameters from user queries
 */
class EventRouter {
  /**
   * Parse user query and extract event search parameters using LLM
   * @param {string} query - User query text
   * @returns {Promise<Object|null>} - Event search parameters or null if not event-related
   * @returns {string} return.semantic_query - Topic to search for
   * @returns {string} return.date_filter - 'upcoming', 'past', or 'all'
   * @returns {string} return.venue - Optional venue filter
   */
  async parseEventQuery(query) {
    try {
      console.log('Event router: Parsing query with LLM...');
      const client = huggingFaceClient.getInstance();

      const response = await client.chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: `You are a query parser for a cultural events database. Analyze the user's query and determine:

1. Is this an EVENT query (about performances, shows, schedules) or an INFORMATIONAL query (about definitions, history, culture)?

2. If it's an EVENT query, extract:
   - semantic_query: The topic/theme (e.g., "kathakali performances", "dance shows", "all events")
   - date_filter: "upcoming" (future events), "past" (already happened), or "all" (no time filter)
   - venue: Specific location if mentioned (e.g., "Esplanade Theatre", "Victoria Theatre")

Respond with ONLY a valid JSON object in this format:
{"is_event_query": true/false, "semantic_query": "...", "date_filter": "upcoming/past/all", "venue": "..." or null}

Examples:
Query: "What are upcoming events?" 
Response: {"is_event_query": true, "semantic_query": "all cultural events", "date_filter": "upcoming", "venue": null}

Query: "What kathakali performances happened before?"
Response: {"is_event_query": true, "semantic_query": "kathakali performances", "date_filter": "past", "venue": null}

Query: "Shows about Bhima at the Esplanade?"
Response: {"is_event_query": true, "semantic_query": "shows about Bhima", "date_filter": "upcoming", "venue": "Esplanade Theatre"}

Query: "What is kathakali?"
Response: {"is_event_query": false, "semantic_query": null, "date_filter": null, "venue": null}

Important: Default to "upcoming" for date_filter unless the query explicitly mentions past tense or history.`,
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 150,
        temperature: 0.1,
      });

      const answer = response.choices[0].message.content.trim();
      console.log(`Event router: LLM response: "${answer}"`);

      let parsedResponse;
      try {
        const jsonMatch = answer.match(/\{[^}]+\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        parsedResponse = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error(
          'Event router: Failed to parse LLM response:',
          parseError,
        );
        return null;
      }

      if (!parsedResponse.is_event_query) {
        console.log('Event router: Not an event query');
        return null;
      }

      const eventParams = {
        semantic_query: parsedResponse.semantic_query || query,
        date_filter: parsedResponse.date_filter || 'upcoming',
        venue: parsedResponse.venue || null,
      };

      console.log('Event router: Extracted parameters:', eventParams);
      return eventParams;
    } catch (error) {
      console.error('Event router: Error parsing query:', error);
      return null;
    }
  }
}

// Create singleton instance
const eventRouter = new EventRouter();

module.exports = eventRouter;
