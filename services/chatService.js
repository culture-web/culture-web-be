const supabase = require('../client/supabaseClient');
const huggingFaceClient = require('../client/huggingfaceClient');
const queryCategorizationService = require('./queryCategorizationService');
const ornamentsService = require('./ornamentsService');
const musicService = require('./musicService');
const embeddingService = require('./embeddingService');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');
const ProficiencyAssessmentService = require('./proficiencyAssessmentService');
const CurriculumService = require('./curriculumService');

/**
 * Conversation History Service
 * Handles storing and retrieving conversation history for the chatbot
 */
class ChatService {
  constructor() {
    this.proficiencyService = new ProficiencyAssessmentService();
    this.curriculumService = new CurriculumService();
  }

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
  async addMessage(userId, sessionId, message, role, metadata = {}) {
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
          userId,
          sessionId,
          message,
          imageAnalysis,
          characterData,
          expressionData,
          imageFile,
        );

        console.log(`🎯 [ChatService] AI response generated successfully.`);

        // Store the AI response
        console.log('💾 [ChatService] Storing AI response in database...');
        const { data: aiData, error: aiError } = await supabase
          .from('messages')
          .insert({
            session_id: sessionId,
            role: 'assistant',
            content: aiResponse,
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

        // Truly asynchronous proficiency assessment (runs in next event loop tick)
        if (userId) {
          console.log(
            '🎓 [ChatService] Scheduling asynchronous proficiency assessment...',
          );
          setImmediate(() => {
            this.updateUserProficiency(userId, message, sessionId).catch(
              (proficiencyError) => {
                console.error(
                  '❌ [ChatService] Proficiency assessment failed:',
                  proficiencyError,
                );
                // Don't block the chat response if proficiency assessment fails
              },
            );
          });
        }

        // Trigger conversation compression asynchronously if needed
        this.triggerConversationCompression(sessionId);

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
   * @param {string} userId - User identifier for proficiency context
   * @param {string} sessionId - Session identifier for message history context
   * @param {string} query - User's message/question
   * @param {string} imageAnalysis - Optional image analysis context
   * @param {Array} characterData - Optional Kathakali character data
   * @param {Array} expressionData - Optional expression data
   * @param {Object} imageFile - Optional uploaded image file
   * @returns {Promise<Object>} AI response
   */
  async generateAIResponse(
    userId,
    sessionId,
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

    // Retrieve conversation summary and recent messages for context
    let conversationSummary = '';
    let messageHistoryContext = '';
    if (sessionId) {
      try {
        console.log(
          '📜 [ChatService] Retrieving conversation summary and message history...',
        );

        // First, get the latest conversation summary if it exists
        const { data: summaryData, error: summaryError } = await supabase
          .from('messages')
          .select('content')
          .eq('session_id', sessionId)
          .eq('is_summary', true)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (!summaryError && summaryData) {
          conversationSummary = summaryData.content;
          console.log(
            '✅ [ChatService] Found conversation summary for context',
          );
        }

        // Then get recent non-summary messages for additional context
        const recentMessages = await this.getRecentNonSummaryMessages(
          sessionId,
          8, // Reduced from 10 to leave room for summary
        );

        if (recentMessages && recentMessages.length > 0) {
          // Sort messages by creation time to ensure proper order
          const sortedMessages = recentMessages.sort(
            (a, b) => new Date(a.created_at) - new Date(b.created_at),
          );

          // Format message history
          const historyLines = sortedMessages.map((msg) => {
            const timestamp = new Date(msg.created_at).toLocaleString();
            return `[${timestamp}] ${msg.role}: ${msg.content}`;
          });

          messageHistoryContext = `\n\nRecent conversation history:\n${historyLines.join('\n')}`;
          console.log(
            `✅ [ChatService] Retrieved ${recentMessages.length} recent messages for context`,
          );
        }
      } catch (historyError) {
        console.warn(
          '⚠️ [ChatService] Failed to retrieve conversation context:',
          historyError.message,
        );
        // Continue without context if retrieval fails
      }
    }

    // Add base system message with conversation summary and history context
    let systemMessageContent =
      'You are a helpful assistant for a cultural chatbot.';

    if (conversationSummary) {
      systemMessageContent += `\n\n${conversationSummary}`;
    }

    if (messageHistoryContext) {
      systemMessageContent += `\n\nPlease use the recent conversation history to provide contextually relevant responses.${messageHistoryContext}`;
    } else {
      systemMessageContent +=
        ' Please provide accurate information about Kathakali performances, culture, ornaments, music, and traditions.';
    }

    messages.unshift({
      role: 'system',
      content: systemMessageContent,
    });

    // Enhanced RAG: Categorize query and apply appropriate RAG strategy
    console.log('🤖 [ChatService] Categorizing query for enhanced RAG...');
    const queryCategory =
      await queryCategorizationService.categorizeQuery(query);
    console.log('Query categorization:', queryCategory);

    // Apply multi-category RAG logic
    try {
      let ragSystemMessage = null;

      // Handle multi-category queries
      if (queryCategory.categories.length > 1) {
        console.log(
          `🎯 [ChatService] Processing multi-category query with ${queryCategory.categories.length} categories`,
        );
        ragSystemMessage = await this.handleMultiCategoryQuery(
          queryCategory,
          messageHistoryContext,
        );
      } else {
        // Handle single category queries
        const singleCategory = queryCategory.categories[0];
        console.log(
          `📝 [ChatService] Processing single-category query: ${singleCategory.category}`,
        );

        switch (singleCategory.category) {
          case 'event':
            console.log('📅 [ChatService] Processing event query...');
            ragSystemMessage = await this.handleEventQuery(
              singleCategory,
              messageHistoryContext,
            );
            break;

          case 'ornament':
            console.log('👑 [ChatService] Processing ornament query...');
            ragSystemMessage = await this.handleOrnamentQuery(
              singleCategory,
              messageHistoryContext,
            );
            break;

          case 'music':
            console.log('🎵 [ChatService] Processing music query...');
            ragSystemMessage = await this.handleMusicQuery(
              singleCategory,
              messageHistoryContext,
            );
            break;

          case 'general':
          default:
            console.log('💬 [ChatService] Processing general query...');
            ragSystemMessage = await this.handleGeneralQuery(
              singleCategory,
              messageHistoryContext,
            );
            break;
        }
      }

      // Apply the RAG-enhanced system message
      if (ragSystemMessage) {
        if (messages.find((msg) => msg.role === 'system')) {
          messages[0].content = ragSystemMessage;
        } else {
          messages.unshift({
            role: 'system',
            content: ragSystemMessage,
          });
        }
      }
    } catch (ragError) {
      console.error('❌ [ChatService] Error in RAG processing:', ragError);
      // Fall back to general system message
      const fallbackMessage = `You are a helpful assistant for a Kathakali cultural chatbot. Please provide accurate information about Kathakali performances, culture, ornaments, music, and traditions.${messageHistoryContext}`;

      if (messages.find((msg) => msg.role === 'system')) {
        messages[0].content = fallbackMessage;
      } else {
        messages.unshift({
          role: 'system',
          content: fallbackMessage,
        });
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

    // Add user proficiency state misconceptions to the context
    if (userId) {
      try {
        console.log(
          '🧠 [ChatService] Fetching user misconceptions for context...',
        );
        const { data: misconceptions, error } = await supabase
          .from('user_proficiency_state')
          .select('node_id, last_evidence')
          .eq('user_id', userId)
          .eq('misconception_flag', true);

        if (error) {
          console.warn(
            '⚠️ [ChatService] Error fetching misconceptions:',
            error.message,
          );
        } else if (misconceptions && misconceptions.length > 0) {
          const misconceptionContext = misconceptions
            .map((m) => {
              const concept = this.curriculumService.getConcept(m.node_id);
              const conceptName = concept?.name || m.node_id;
              return `${conceptName} (${m.last_evidence || 'misconception detected'})`;
            })
            .join(', ');

          const contextMessage = `\n\nContext about user's learning progress: The user has shown some misconceptions in these areas: ${misconceptionContext}. Please provide accurate, helpful information that addresses these topics naturally in your response.`;

          if (messages.find((msg) => msg.role === 'system')) {
            messages[0].content += contextMessage;
          } else {
            messages.unshift({
              role: 'system',
              content: `You are a helpful assistant for a Kathakali cultural chatbot.${contextMessage}`,
            });
          }

          console.log(
            `✅ [ChatService] Added ${misconceptions.length} misconceptions to context`,
          );
        } else {
          console.log('ℹ️ [ChatService] No misconceptions found for user');
        }
      } catch (misconceptionError) {
        console.warn(
          '⚠️ [ChatService] Failed to add misconceptions to context:',
          misconceptionError.message,
        );
      }
    }

    const chatCompletion = await client.chatCompletion({
      provider: 'together',
      model: 'openai/gpt-oss-120b',
      messages: messages,
    });

    const responseMessage = chatCompletion.choices[0].message.content;
    console.log('responseMessage', responseMessage);
    const chatbotResponse = preprocessChatResponse(responseMessage);

    return chatbotResponse;
  }

  async addSession(userId) {
    console.log(
      `🆕 [ChatService] Creating new session for userId: ${userId || 'UNAUTHENTICATED'}`,
    );

    // Check if user already has an active "New Conversation" session
    try {
      const { data: existingSession, error: checkError } = await supabase
        .from('sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('title', 'New Conversation')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!checkError && existingSession) {
        console.log(
          `♻️ [ChatService] Reusing existing "New Conversation" session: ${existingSession.id}`,
        );
        return existingSession;
      }
    } catch (checkError) {
      // Continue with creation if check fails (not a critical error)
      console.log(
        'ℹ️ [ChatService] Could not check for existing session, proceeding with creation',
      );
    }

    // Create new session if no existing "New Conversation" session found
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
   * Generate AI-powered session title/summary based on the first user message
   * @param {string} userMessage - The first user message
   * @returns {Promise<string>} Generated session title
   */
  async generateSessionSummary(userMessage) {
    if (!userMessage) {
      throw new Error('User message is required for session summary');
    }

    const client = huggingFaceClient.getInstance();

    const messages = [
      {
        role: 'system',
        content:
          "You are a helpful assistant that creates concise, descriptive titles for conversations. Based on the user's first message, generate a brief title (3-6 words) that captures the main topic or intent. Only respond with the title, nothing else.",
      },
      {
        role: 'user',
        content: `Please create a short title for a conversation that starts with this message: "${userMessage}"`,
      },
    ];

    try {
      const chatCompletion = await client.chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: messages,
      });

      const title = chatCompletion.choices[0].message.content.trim();
      console.log(`🏷️ [ChatService] Generated session title: "${title}"`);
      return title;
    } catch (error) {
      console.warn(
        '⚠️ [ChatService] Failed to generate session summary:',
        error.message,
      );
      // Fallback to first few words of the user message
      const fallbackTitle = userMessage.substring(0, 50).trim();
      return fallbackTitle.length < userMessage.length
        ? `${fallbackTitle}...`
        : fallbackTitle;
    }
  }

  /**
   * Update session title in the database
   * @param {string} sessionId - Session identifier
   * @param {string} title - New title for the session
   * @returns {Promise<Object>} Updated session data
   */
  async updateSessionTitle(sessionId, title) {
    if (!sessionId || !title) {
      throw new Error('Session ID and title are required');
    }

    const { data, error } = await supabase
      .from('sessions')
      .update({ title: title })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      console.error(
        '❌ [ChatService] Failed to update session title:',
        error.message,
      );
      throw new Error(`Failed to update session title: ${error.message}`);
    }

    console.log(
      `✅ [ChatService] Updated session ${sessionId} title to: "${title}"`,
    );
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
      .eq('is_summary', false)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to get conversation history: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Get recent non-summary messages for a session (used for context in AI responses)
   * @param {string} sessionId - Session identifier
   * @param {number} limit - Maximum number of messages to retrieve
   * @returns {Promise<Array>} Array of recent non-summary messages
   */
  async getRecentNonSummaryMessages(sessionId, limit = 8) {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('is_summary', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to get recent messages: ${error.message}`);
    }

    // Return in chronological order (oldest first)
    return (data || []).reverse();
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

  async deleteMessage(messageId) {
    const { error: messageDeleteError } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId);

    if (messageDeleteError) {
      throw new Error(
        `Failed to delete message: ${messageDeleteError.message}`,
      );
    }

    return { success: true };
  }

  /**
   * Handle event-related queries with existing event RAG logic
   * @param {Object} categoryData - Single category data object
   * @param {string} messageHistoryContext - Previous conversation context
   * @returns {Promise<string>} System message for event queries
   */
  async handleEventQuery(categoryData, messageHistoryContext) {
    try {
      // Use the existing event logic but with new parameters structure
      const eventParams = {
        semantic_query: categoryData.semantic_query,
        date_filter: categoryData.parameters.date_filter || 'upcoming',
        venue: categoryData.parameters.venue || null,
      };

      console.log(
        `📅 Event query detected - Topic: "${eventParams.semantic_query}", Time: ${eventParams.date_filter}, Venue: ${eventParams.venue || 'any'}`,
      );

      // Determine if we should search upcoming or past events
      const searchUpcomingOnly = eventParams.date_filter !== 'past';
      const searchAllEvents = eventParams.date_filter === 'all';

      let similarEvents = await embeddingService.searchSimilarEvents(
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
          const venueInfo = eventParams.venue ? ` at ${eventParams.venue}` : '';
          console.log(
            `Fallback: Found ${similarEvents.length} ${timeFilter} events${venueInfo}`,
          );
        }
      }

      if (similarEvents && similarEvents.length > 0) {
        console.log(`Found ${similarEvents.length} relevant event(s) for RAG`);

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

        return `You are a helpful assistant for a cultural chatbot. The user is asking about cultural events. Here are the relevant upcoming events from our database:

${eventsContext}

Please use this information to answer the user's question accurately. If the user asks about upcoming events, refer to these events. Be helpful and provide details from the events listed above.${messageHistoryContext}`;
      }
      console.log('No relevant events found for this query');
      return `You are a helpful assistant for a cultural chatbot. The user is asking about events, but there are no upcoming events matching their query at this time. Please inform them politely.${messageHistoryContext}`;
    } catch (error) {
      console.error('❌ [ChatService] Error handling event query:', error);
      return `You are a helpful assistant for a cultural chatbot. Unable to retrieve event information at this time, but please try to help with general event-related questions.${messageHistoryContext}`;
    }
  }

  /**
   * Handle ornament-related queries using ornaments RAG service
   * @param {Object} categoryData - Single category data object
   * @param {string} messageHistoryContext - Previous conversation context
   * @returns {Promise<string>} System message for ornament queries
   */
  async handleOrnamentQuery(categoryData, messageHistoryContext) {
    try {
      console.log('👑 [ChatService] Getting ornament context...');
      const contextData = await ornamentsService.getOrnamentContext(
        supabase,
        categoryData.semantic_query,
        categoryData.parameters,
      );

      return ornamentsService.generateSystemMessage(
        contextData,
        messageHistoryContext,
      );
    } catch (error) {
      console.error('❌ [ChatService] Error handling ornament query:', error);
      return `You are a helpful assistant for a Kathakali cultural chatbot specializing in traditional ornaments and costumes. Please provide general information about Kathakali ornaments and their cultural significance.${messageHistoryContext}`;
    }
  }

  /**
   * Handle music-related queries using music RAG service
   * @param {Object} categoryData - Single category data object
   * @param {string} messageHistoryContext - Previous conversation context
   * @returns {Promise<string>} System message for music queries
   */
  async handleMusicQuery(categoryData, messageHistoryContext) {
    try {
      console.log('🎵 [ChatService] Getting music context...');
      const contextData = await musicService.getMusicContext(
        supabase,
        categoryData.semantic_query,
        categoryData.parameters,
      );

      return musicService.generateSystemMessage(
        contextData,
        messageHistoryContext,
      );
    } catch (error) {
      console.error('❌ [ChatService] Error handling music query:', error);
      return `You are a helpful assistant for a Kathakali cultural chatbot specializing in traditional music, ragams, and rhythmic elements. Please provide general information about Kathakali music and its cultural significance.${messageHistoryContext}`;
    }
  }

  /**
   * Handle general Kathakali queries
   * @param {Object} categoryData - Single category data object
   * @param {string} messageHistoryContext - Previous conversation context
   * @returns {Promise<string>} System message for general queries
   */
  async handleGeneralQuery(categoryData, messageHistoryContext) {
    try {
      console.log('💬 [ChatService] Handling general Kathakali query...');

      // For general queries, we could potentially search the knowledge base
      // or provide a comprehensive cultural context
      const topic = categoryData.parameters.topic || 'general';

      let systemMessage = `You are a helpful assistant for a Kathakali cultural chatbot. You specialize in providing accurate, educational information about:

- Kathakali performance art and history
- Traditional stories and characters
- Cultural significance and traditions
- Performance techniques and expressions
- Regional variations and styles
- Educational resources and learning

Please provide comprehensive, culturally sensitive, and educational responses about Kathakali and related Indian classical performing arts.`;

      if (topic !== 'general') {
        systemMessage += ` The user is particularly interested in: ${topic}.`;
      }

      systemMessage += messageHistoryContext;

      return systemMessage;
    } catch (error) {
      console.error('❌ [ChatService] Error handling general query:', error);
      return `You are a helpful assistant for a Kathakali cultural chatbot. Please provide accurate information about Kathakali performances, culture, and traditions.${messageHistoryContext}`;
    }
  }

  /**
   * Handle multi-category queries by combining contexts from multiple sources
   * @param {Object} queryCategory - Full query categorization result
   * @param {string} messageHistoryContext - Previous conversation context
   * @returns {Promise<string>} Combined system message for multi-category queries
   */
  async handleMultiCategoryQuery(queryCategory, messageHistoryContext) {
    try {
      console.log(
        `🎯 [ChatService] Processing ${queryCategory.categories.length} categories: ${queryCategory.categories.map((c) => c.category).join(', ')}`,
      );

      const contexts = [];
      const categoryNames = [];

      // Process each category and collect contexts in parallel
      const contextPromises = queryCategory.categories.map(
        async (categoryData) => {
          categoryNames.push(categoryData.category);

          try {
            switch (categoryData.category) {
              case 'event': {
                console.log(
                  '📅 [ChatService] Getting event context for multi-category query...',
                );
                const eventContext =
                  await this.getEventContextOnly(categoryData);
                if (eventContext) {
                  return {
                    category: 'event',
                    title: 'Cultural Events',
                    content: eventContext,
                  };
                }
                break;
              }

              case 'ornament': {
                console.log(
                  '👑 [ChatService] Getting ornament context for multi-category query...',
                );
                const ornamentData = await ornamentsService.getOrnamentContext(
                  supabase,
                  categoryData.semantic_query,
                  categoryData.parameters,
                );
                if (ornamentData.hasContext) {
                  return {
                    category: 'ornament',
                    title: 'Kathakali Ornaments',
                    content: ornamentData.contextMessage,
                  };
                }
                break;
              }

              case 'music': {
                console.log(
                  '🎵 [ChatService] Getting music context for multi-category query...',
                );
                const musicData = await musicService.getMusicContext(
                  supabase,
                  categoryData.semantic_query,
                  categoryData.parameters,
                );
                if (musicData.hasContext) {
                  return {
                    category: 'music',
                    title: 'Kathakali Music & Ragams',
                    content: musicData.contextMessage,
                  };
                }
                break;
              }

              default:
                // General context is handled in the base system message
                break;
            }
          } catch (categoryError) {
            console.error(
              `❌ [ChatService] Error processing ${categoryData.category} in multi-category query:`,
              categoryError,
            );
          }

          return null;
        },
      );

      // Wait for all context retrieval operations to complete
      const contextResults = await Promise.all(contextPromises);

      // Filter out null results and add to contexts array
      contextResults.forEach((result) => {
        if (result) {
          contexts.push(result);
        }
      });

      // Build combined system message
      let systemMessage = `You are a helpful assistant for a Kathakali cultural chatbot. The user's query spans multiple areas of Kathakali culture: ${categoryNames.join(', ')}.`;

      if (contexts.length > 0) {
        systemMessage += `\n\nHere is relevant information from our databases:\n\n`;

        contexts.forEach((context) => {
          systemMessage += `=== ${context.title} ===\n${context.content}\n\n`;
        });

        systemMessage += `Please use this comprehensive information to provide a well-rounded answer that addresses all aspects of the user's query. Connect the different elements (${categoryNames.join(', ')}) where relevant and provide educational insights about how they relate to each other in Kathakali performances.`;
      } else {
        systemMessage += ` Please provide comprehensive information covering all these aspects of Kathakali culture.`;
      }

      systemMessage += messageHistoryContext;

      console.log(
        `✅ [ChatService] Generated multi-category system message with ${contexts.length} context sources`,
      );
      return systemMessage;
    } catch (error) {
      console.error(
        '❌ [ChatService] Error handling multi-category query:',
        error,
      );
      return `You are a helpful assistant for a Kathakali cultural chatbot. Please provide comprehensive information about Kathakali culture, covering multiple aspects as requested by the user.${messageHistoryContext}`;
    }
  }

  /**
   * Get event context without full system message formatting (for multi-category use)
   * @param {Object} categoryData - Event category data
   * @returns {Promise<string|null>} Event context string or null
   */
  async getEventContextOnly(categoryData) {
    try {
      const eventParams = {
        semantic_query: categoryData.semantic_query,
        date_filter: categoryData.parameters.date_filter || 'upcoming',
        venue: categoryData.parameters.venue || null,
      };

      const searchUpcomingOnly = eventParams.date_filter !== 'past';
      const searchAllEvents = eventParams.date_filter === 'all';

      let similarEvents = await embeddingService.searchSimilarEvents(
        supabase,
        eventParams.semantic_query,
        5, // Fewer results for multi-category
        searchUpcomingOnly && !searchAllEvents,
        0.3,
      );

      if (eventParams.venue && similarEvents.length > 0) {
        const venueLower = eventParams.venue.toLowerCase();
        similarEvents = similarEvents.filter((event) =>
          event.location?.toLowerCase().includes(venueLower),
        );
      }

      if (similarEvents.length === 0) {
        // Simplified fallback for multi-category
        const currentDateTime = new Date().toISOString();
        let fetchQuery = supabase.from('events').select('*').limit(3);

        if (searchUpcomingOnly && !searchAllEvents) {
          fetchQuery = fetchQuery
            .gte('start_time', currentDateTime)
            .order('start_time', { ascending: true });
        } else {
          fetchQuery = fetchQuery.order('start_time', { ascending: false });
        }

        const { data: events } = await fetchQuery;
        similarEvents = events || [];
      }

      if (similarEvents.length > 0) {
        const eventsContext = similarEvents
          .map((event, index) => {
            const startDate = new Date(event.start_time);
            return `
Event ${index + 1}:
- Title: ${event.title}
- Start Time: ${startDate.toLocaleString()}
- Location: ${event.location || 'Location not specified'}
- Description: ${event.description || 'No description available'}`;
          })
          .join('\n');

        return eventsContext;
      }

      return null;
    } catch (error) {
      console.error('❌ [ChatService] Error getting event context:', error);
      return null;
    }
  }

  /**
   * Asynchronously assess and update user proficiency based on their message
   * @param {string} userId - User identifier
   * @param {string} message - User's message content
   * @param {string} sessionId - Session ID for context
   * @returns {Promise<void>}
   */
  async updateUserProficiency(userId, message, sessionId) {
    try {
      console.log(`🎓 [ChatService] Assessing proficiency for user: ${userId}`);

      // Use the proficiency assessment service to analyze the message
      const proficiencyUpdates =
        await this.proficiencyService.assessUserProficiency(
          userId,
          message,
          sessionId,
        );

      if (proficiencyUpdates && proficiencyUpdates.length > 0) {
        console.log(
          `📈 [ChatService] Applying ${proficiencyUpdates.length} proficiency updates`,
        );
        await this.proficiencyService.applyProficiencyUpdates(
          userId,
          proficiencyUpdates,
        );
      } else {
        console.log('📊 [ChatService] No proficiency updates needed');
      }
    } catch (error) {
      console.error('❌ [ChatService] Error in proficiency assessment:', error);
      // Don't throw - this is an async background task
    }
  }

  /**
   * Check if a session needs conversation compression
   * Uses a more sophisticated approach: compress when >50 messages OR >30 days old
   * @param {string} sessionId - Session identifier
   * @returns {Promise<boolean>} True if compression is needed
   */
  async shouldCompressConversation(sessionId) {
    try {
      // Check message count (>50 messages = compress)
      const { count, error: countError } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('is_summary', false);

      if (countError) {
        console.error(
          '❌ [ChatService] Error checking message count:',
          countError,
        );
        return false;
      }

      // Check for old messages (>30 days = compress)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { count: oldCount, error: oldError } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('is_summary', false)
        .lt('created_at', thirtyDaysAgo.toISOString());

      if (oldError) {
        console.error(
          '❌ [ChatService] Error checking old messages:',
          oldError,
        );
      }

      const shouldCompressByCount = count > 25; // Increased from 10 - need enough messages for meaningful compression
      const shouldCompressByAge = (oldCount || 0) > 3; // Compress if >3 messages older than 30 days (lowered from 10)

      const shouldCompress = shouldCompressByCount || shouldCompressByAge;

      if (shouldCompress) {
        console.log(
          `📦 [ChatService] Session ${sessionId} needs compression:`,
          `${count} total messages (${shouldCompressByCount ? 'EXCEEDS LIMIT' : 'OK'}),`,
          `${oldCount || 0} old messages (${shouldCompressByAge ? 'EXCEEDS AGE LIMIT' : 'OK'})`,
        );
      }

      return shouldCompress;
    } catch (error) {
      console.error(
        '❌ [ChatService] Error in shouldCompressConversation:',
        error,
      );
      return false;
    }
  }

  /**
   * Compress older conversation messages into a memory block
   * @param {string} sessionId - Session identifier
   * @returns {Promise<void>}
   */
  async compressConversationHistory(sessionId) {
    try {
      console.log(
        `🗜️ [ChatService] Starting conversation compression for session: ${sessionId}`,
      );

      // Get all non-summary messages that haven't been summarized yet for this session, ordered by creation time
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('session_id', sessionId)
        .eq('is_summary', false)
        .eq('has_been_summarised', false)
        .order('created_at', { ascending: true });

      if (error) {
        throw error;
      }

      if (!messages || messages.length <= 20) {
        console.log(
          `ℹ️ [ChatService] Not enough messages to compress (${messages?.length || 0})`,
        );
        return;
      }

      // Intelligent compression strategy:
      // 1. Always keep the 8 most recent messages (matches AI context window)
      // 2. From the older messages, keep important Q&A pairs
      // 3. Compress the rest into summaries

      const recentMessages = messages.slice(-8); // Keep last 8 messages (matches AI context)
      const olderMessages = messages.slice(0, -8);

      // Identify important Q&A pairs from older messages
      const importantMessages = this.identifyImportantMessages(olderMessages);
      const messagesToCompress = olderMessages.filter(
        (msg) => !importantMessages.some((imp) => imp.id === msg.id),
      );

      console.log(
        `📊 [ChatService] Intelligent compression: ${messages.length} total → ${recentMessages.length} recent + ${importantMessages.length} important + ${messagesToCompress.length} to compress`,
      );

      if (messagesToCompress.length === 0) {
        console.log(
          'ℹ️ [ChatService] No messages to compress after intelligent filtering',
        );
        return;
      }

      // Generate a summary of messages to compress
      const conversationSummary =
        await this.generateConversationSummary(messagesToCompress);

      // Insert summary message
      const { error: insertError } = await supabase.from('messages').insert({
        session_id: sessionId,
        role: 'system',
        content: conversationSummary,
        metadata: {
          compressed: true,
          original_message_count: messagesToCompress.length,
          compression_type: 'intelligent',
          kept_recent: recentMessages.length,
          kept_important: importantMessages.length,
        },
        response_for: null,
        is_summary: true,
      });

      if (insertError) {
        throw insertError;
      }

      // Mark compressed messages as summarized instead of deleting them
      const { error: updateError } = await supabase
        .from('messages')
        .update({ has_been_summarised: true })
        .in(
          'id',
          messagesToCompress.map((m) => m.id),
        );

      if (updateError) {
        console.error(
          '❌ [ChatService] Error marking messages as summarized:',
          updateError,
        );
        // Don't throw here to avoid breaking the conversation
      }

      console.log(
        `✅ [ChatService] Successfully compressed conversation for session: ${sessionId}`,
      );
    } catch (error) {
      console.error('❌ [ChatService] Error compressing conversation:', error);
      // Don't throw - compression failure shouldn't break chat
    }
  }

  /**
   * Identify important messages that should be preserved during compression
   * Keeps Q&A pairs and user questions to maintain conversation context
   * @param {Array} messages - Array of message objects
   * @returns {Array} Array of important messages to keep
   */
  identifyImportantMessages(messages) {
    const importantMessages = [];

    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const isUserQuestion =
        message.role === 'user' && message.content.includes('?'); // Only explicit questions with ?

      // Keep Q&A pairs
      if (
        isUserQuestion &&
        i + 1 < messages.length &&
        messages[i + 1].role === 'assistant'
      ) {
        importantMessages.push(message); // User question
        importantMessages.push(messages[i + 1]); // Assistant answer
        i += 1; // Skip the next message since we already added it
      }
      // Keep standalone important user messages
      else if (isUserQuestion) {
        importantMessages.push(message);
      }
    }

    // Limit important messages to ensure some compression happens
    // Keep at most 50% of older messages as important
    const maxImportant = Math.max(5, Math.floor(messages.length * 0.5));
    if (importantMessages.length > maxImportant) {
      importantMessages.splice(maxImportant); // Keep only the first maxImportant messages
    }

    return importantMessages;
  }

  /**
   * Generate a summary of older conversation messages
   * @param {Array} messages - Array of message objects to summarize
   * @returns {Promise<string>} Conversation summary
   */
  async generateConversationSummary(messages) {
    try {
      // Extract key topics and themes from the conversation
      const fullConversationText = messages
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join('\n');

      // Truncate to prevent AI token limits (keep last 10000 chars for recent context)
      const conversationText =
        fullConversationText.length > 10000
          ? fullConversationText.substring(fullConversationText.length - 10000)
          : fullConversationText;

      console.log(
        `📝 [ChatService] Generating summary for ${messages.length} messages`,
      );
      console.log(
        `📝 [ChatService] Conversation text length: ${conversationText.length} chars`,
      );
      console.log(
        `📝 [ChatService] Conversation text preview: ${conversationText.substring(
          0,
          200,
        )}...`,
      );

      const client = huggingFaceClient.getInstance();

      const summaryMessages = [
        {
          role: 'system',
          content: `You are a conversation summarizer. Your task is to create a concise summary of the provided conversation about Kathakali culture. Focus on key topics discussed, questions asked, and important information shared. Keep the summary under 200 words and make it suitable for providing context to continue the conversation naturally.

IMPORTANT: Respond with valid JSON in this exact format:
{
  "summary": "Your concise summary text here"
}`,
        },
        {
          role: 'user',
          content: `Please summarize this conversation history and respond with JSON:\n\n${conversationText}`,
        },
      ];

      const chatCompletion = await client.chatCompletion({
        provider: 'together',
        model: 'openai/gpt-oss-120b',
        messages: summaryMessages,
        max_tokens: 450, // Increased from 150 to allow complete JSON responses
        temperature: 0.3, // More focused summary
      });

      const rawResponse =
        chatCompletion.choices[0]?.message?.content?.trim() || '';

      console.log(
        `📝 [ChatService] Raw AI response: ${rawResponse.substring(0, 200)}...`,
      );

      // Parse JSON response
      let summary = '';
      try {
        const jsonResponse = JSON.parse(rawResponse);
        summary = jsonResponse.summary?.trim() || '';

        console.log(`📝 [ChatService] Successfully parsed JSON summary`);
      } catch (parseError) {
        console.warn(
          `📝 [ChatService] Failed to parse JSON response: ${parseError.message}`,
        );
        console.warn(`📝 [ChatService] Raw response was: ${rawResponse}`);

        // Try to extract summary from raw response as fallback
        const summaryMatch = rawResponse.match(/"summary"\s*:\s*"([^"]+)"/);
        if (summaryMatch) {
          summary = summaryMatch[1].trim();
          console.log(
            `📝 [ChatService] Extracted summary from raw JSON string`,
          );
        } else {
          console.warn(
            `📝 [ChatService] Could not extract summary, using fallback`,
          );
        }
      }

      console.log(
        `📝 [ChatService] Generated summary length: ${summary.length} chars`,
      );
      console.log(
        `📝 [ChatService] Summary preview: ${summary.substring(0, 100)}...`,
      );

      if (!summary || summary.length < 10) {
        console.warn('📝 [ChatService] Summary too short, using fallback');
        return `📝 Previous Conversation Summary:\nThis conversation covered various topics related to Kathakali culture, including discussions about characters, performances, and traditional elements.\n\n--- End of Summary ---\n\nContinuing the conversation...`;
      }

      return `📝 Previous Conversation Summary:\n${summary}\n\n--- End of Summary ---\n\nContinuing the conversation...`;
    } catch (error) {
      console.error(
        '❌ [ChatService] Error generating conversation summary:',
        error,
      );
      // Fallback summary
      return `📝 Previous Conversation Summary:\nThis conversation covered various topics related to Kathakali culture, including discussions about characters, performances, and traditional elements.\n\n--- End of Summary ---\n\nContinuing the conversation...`;
    }
  }

  /**
   * Trigger asynchronous conversation compression if needed
   * @param {string} sessionId - Session identifier
   */
  async triggerConversationCompression(sessionId) {
    // Run compression asynchronously to not block the chat response
    setImmediate(async () => {
      try {
        const needsCompression =
          await this.shouldCompressConversation(sessionId);

        if (needsCompression) {
          await this.compressConversationHistory(sessionId);
        }
      } catch (error) {
        console.error(
          '❌ [ChatService] Error in conversation compression trigger:',
          error,
        );
      }
    });
  }
}

module.exports = ChatService;
