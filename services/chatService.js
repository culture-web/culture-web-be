const supabase = require('../client/supabaseClient');
const huggingFaceClient = require('../client/huggingfaceClient');
const eventRouterService = require('./eventRouterService');
const embeddingService = require('./embeddingService');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');

/**
 * Conversation History Service
 * Handles storing and retrieving conversation history for the chatbot
 */
class ChatService {
  /**
   * Add a new message to the conversation history
   * If it's a user message, automatically generate and store an AI response
   * @param {string} userId - User identifier
   * @param {string} sessionId - Session identifier
   * @param {string} message - Message content
   * @param {string} role - 'user' or 'assistant'
   * @param {Object} metadata - Optional metadata (can include imageAnalysis, characterData, expressionData, imageFile)
   * @returns {Promise<Object>} Contains userMessage and optionally aiResponse
   */
  async addMessage(sessionId, message, role, metadata = {}) {
    // Store the user/assistant message
    const { data, error } = await supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role,
        content: message,
        metadata,
        response_for: null,
        is_summary: false,
      })
      .select()
      .single();

    if (error) {
      console.error('❌ [ChatService] Failed to store message:', error.message);
      throw new Error(`Failed to add message: ${error.message}`);
    }

    console.log(`✅ [ChatService] Message stored with ID: ${data.id}`);
    const userMessage = data;

    // If it's a user message, generate AI response automatically
    if (role === 'user') {
      console.log(
        '🤖 [ChatService] User message detected - generating AI response',
      );
      try {
        const { imageAnalysis, characterData, expressionData, imageFile } =
          metadata || {};

        console.log(
          `🔍 [ChatService] AI generation context - ImageAnalysis: ${!!imageAnalysis}, CharacterData: ${!!characterData}, ExpressionData: ${!!expressionData}, ImageFile: ${!!imageFile}`,
        );

        // Generate AI response using the same logic as kathakali controller
        console.log('⚙️ [ChatService] Calling generateAIResponse...');
        const aiResponse = await this.generateAIResponse(
          message,
          imageAnalysis,
          characterData,
          expressionData,
          imageFile,
        );

        console.log(`🎯 [ChatService] AI response generated successfully`);

        // Store the AI response
        console.log('💾 [ChatService] Storing AI response in database...');
        const { data: aiData, error: aiError } = await supabase
          .from('messages')
          .insert({
            session_id: sessionId,
            role: 'assistant',
            content: aiResponse.shortAnswer || JSON.stringify(aiResponse),
            metadata: { generatedWithRAG: true },
            response_for: userMessage.id,
            is_summary: false,
          })
          .select()
          .single();

        if (aiError) {
          console.error('❌ [ChatService] Error storing AI response:', aiError);
          // Return user message even if AI response fails
          return {
            userMessage,
            aiResponse: null,
            error: 'Failed to generate AI response',
          };
        }

        console.log(
          `✅ [ChatService] AI response stored with ID: ${aiData.id}`,
        );
        console.log(
          '🎉 [ChatService] Returning user message + AI response + generated content',
        );
        return {
          userMessage,
          aiResponse: aiData,
          generatedResponse: aiResponse,
        };
      } catch (aiError) {
        console.error(
          '💥 [ChatService] Error generating AI response:',
          aiError.message,
        );
        // Return user message even if AI response fails
        return { userMessage, aiResponse: null, error: aiError.message };
      }
    }

    // For assistant messages, just return the stored message
    console.log('👨‍💼 [ChatService] Assistant message - no AI generation needed');
    return { userMessage };
  }

  /**
   * Generate AI response with RAG capabilities
   * @param {string} query - User's message/question
   * @param {string} imageAnalysis - Optional image analysis context
   * @param {Array} characterData - Optional Kathakali character data
   * @param {Array} expressionData - Optional expression data
   * @param {Object} imageFile - Optional uploaded image file
   * @returns {Promise<Object>} AI response
   */
  async generateAIResponse(
    query,
    imageAnalysis = null,
    characterData = null,
    expressionData = null,
    imageFile = null,
  ) {
    if (!query) {
      throw new Error('Query is required');
    }

    const client = huggingFaceClient.getInstance();

    const messages = [
      {
        role: 'user',
        content: query,
      },
    ];

    // RAG: Parse query to extract event search parameters
    const eventParams = await eventRouterService.parseEventQuery(query);
    console.log('Event query parameters:', eventParams);

    // If event-related, perform vector search and add context
    if (eventParams) {
      try {
        let similarEvents = [];

        console.log(
          `Event query detected - Topic: "${eventParams.semantic_query}", Time: ${eventParams.date_filter}, Venue: ${eventParams.venue || 'any'}`,
        );

        // Determine if we should search upcoming or past events
        const searchUpcomingOnly = eventParams.date_filter !== 'past';
        const searchAllEvents = eventParams.date_filter === 'all';

        similarEvents = await embeddingService.searchSimilarEvents(
          supabase,
          eventParams.semantic_query, // Use extracted semantic query
          10, // Get more results
          searchUpcomingOnly && !searchAllEvents, // Filter based on LLM's date_filter
          0.3, // Lower threshold for better recall
        );

        console.log(
          `Semantic search found ${similarEvents.length} event(s) with similarity > 0.3`,
        );

        if (eventParams.venue && similarEvents.length > 0) {
          const venueLower = eventParams.venue.toLowerCase();
          similarEvents = similarEvents.filter((event) =>
            event.location?.toLowerCase().includes(venueLower),
          );
          console.log(
            `After venue filter (${eventParams.venue}): ${similarEvents.length} event(s)`,
          );
        }

        if (similarEvents.length === 0) {
          console.log(
            'No events found via semantic search - fetching events as fallback',
          );

          const currentDateTime = new Date().toISOString();
          let fetchQuery = supabase.from('events').select('*').limit(10);

          if (eventParams.venue) {
            fetchQuery = fetchQuery.ilike('location', `%${eventParams.venue}%`);
          }

          if (searchUpcomingOnly && !searchAllEvents) {
            // Fetch upcoming events
            fetchQuery = fetchQuery
              .gte('start_time', currentDateTime)
              .order('start_time', { ascending: true });
          } else if (!searchAllEvents) {
            // Fetch past events
            fetchQuery = fetchQuery
              .lt('start_time', currentDateTime)
              .order('start_time', { ascending: false });
          } else {
            // Fetch all events
            fetchQuery = fetchQuery.order('start_time', { ascending: false });
          }

          const { data: events, error } = await fetchQuery;

          if (error) {
            console.error('Error fetching events:', error);
          } else {
            similarEvents = events || [];
            let timeFilter = 'past';
            if (searchAllEvents) {
              timeFilter = 'all';
            } else if (searchUpcomingOnly) {
              timeFilter = 'upcoming';
            }
            const venueInfo = eventParams.venue
              ? ` at ${eventParams.venue}`
              : '';
            console.log(
              `Fallback: Found ${similarEvents.length} ${timeFilter} events${venueInfo}`,
            );
          }
        }

        if (similarEvents && similarEvents.length > 0) {
          console.log(
            `Found ${similarEvents.length} relevant event(s) for RAG`,
          );

          // Format events for context
          const eventsContext = similarEvents
            .map((event, index) => {
              const startDate = new Date(event.start_time);
              const endDate = event.end_time ? new Date(event.end_time) : null;

              return `
Event ${index + 1}:
- Title: ${event.title}
- Description: ${event.description || 'No description available'}
- Start Time: ${startDate.toLocaleString()}
${endDate ? `- End Time: ${endDate.toLocaleString()}` : ''}
- Location: ${event.location || 'Location not specified'}
- URL: ${event.url || 'No URL available'}
`;
            })
            .join('\n');

          const eventSystemMessage = `You are a helpful assistant for a cultural chatbot. The user is asking about cultural events. Here are the relevant upcoming events from our database:

${eventsContext}

Please use this information to answer the user's question accurately. If the user asks about upcoming events, refer to these events. Be helpful and provide details from the events listed above.`;

          messages.unshift({
            role: 'system',
            content: eventSystemMessage,
          });
        } else {
          console.log('No relevant events found for this query');
          messages.unshift({
            role: 'system',
            content:
              'You are a helpful assistant for a cultural chatbot. The user is asking about events, but there are no upcoming events matching their query at this time. Please inform them politely.',
          });
        }
      } catch (eventError) {
        console.error('Error fetching events for RAG:', eventError);
        // Continue with normal chat if event search fails
      }
    }

    if (imageAnalysis) {
      if (messages.find((msg) => msg.role === 'system')) {
        messages[0].content += `\n\nContext from image analysis: ${imageAnalysis}`;
      } else {
        messages.unshift({
          role: 'system',
          content: `Context from image analysis: ${imageAnalysis}`,
        });
      }
    }

    // Handle uploaded image file if present
    if (imageFile) {
      let imageContext =
        'The user has uploaded an image for Kathakali analysis.';

      // Add character information if available
      if (characterData && characterData.length > 0) {
        const characters = characterData
          .map((data) => data.character || data.predicted_class)
          .filter(Boolean);
        if (characters.length > 0) {
          imageContext += ` The image contains the following Kathakali character(s): ${characters.join(', ')}.`;
        }
      }

      // Add expression information if available
      if (expressionData && expressionData.length > 0) {
        const expressions = expressionData
          .map((data) => data.expression || data.predicted_class)
          .filter(Boolean);
        if (expressions.length > 0) {
          imageContext += ` The detected expression(s) are: ${expressions.join(', ')}.`;
        }
      }

      imageContext +=
        " Please provide information about these Kathakali elements and respond to the user's query in the context of this classical Indian dance form.";

      if (messages.find((msg) => msg.role === 'system')) {
        messages[0].content += `\n${imageContext}`;
      } else {
        messages.unshift({
          role: 'system',
          content: imageContext,
        });
      }
    }

    const chatCompletion = await client.chatCompletion({
      provider: 'together',
      model: 'openai/gpt-oss-120b',
      messages: messages,
    });

    const responseMessage = chatCompletion.choices[0].message.content;
    const chatbotResponse = preprocessChatResponse(responseMessage);

    return chatbotResponse;
  }

  async addSession(userId) {
    console.log(
      `🆕 [ChatService] Creating new session for userId: ${userId || 'UNAUTHENTICATED'}`,
    );

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        user_id: userId,
        title: 'New Conversation',
      })
      .select()
      .single();

    if (error) {
      console.error(
        '❌ [ChatService] Failed to create session:',
        error.message,
      );
      throw new Error(`Failed to create session: ${error.message}`);
    }

    console.log(`✅ [ChatService] Session created with ID: ${data.id}`);
    return data;
  }

  /**
   * Get chat sessions that belong to the user
   * @param {*} userId - User identifier
   * @param {*} limit - Maximum number of sessions to return (default: 100)
   * @returns {Promise<Array>} Array of chat sessions
   */
  async getChatSessionsByUserId(userId, limit = 100) {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to get user chat sessions: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get conversation history for a session (with user authorization)
   * @param {string} sessionId - Session identifier
   * @param {number} limit - Maximum number of messages to return (default: 50)
   * @param {number} offset - Offset for pagination (default: 0)
   * @returns {Promise<Array>} Array of messages ordered by timestamp
   */
  async getMessagesByChatSessionId(sessionId, limit = 50, offset = 0) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to get conversation history: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Delete conversation history for a session
   * @param {string} sessionId - Session identifier
   * @returns {Promise<Object>} Deletion result
   */
  async deleteSessionHistory(sessionId) {
    // Delete the session (messages will be deleted automatically due to CASCADE)
    const { error: sessionDeleteError } = await supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (sessionDeleteError) {
      throw new Error(
        `Failed to delete session history: ${sessionDeleteError.message}`,
      );
    }

    return { success: true };
  }
}

module.exports = ChatService;
