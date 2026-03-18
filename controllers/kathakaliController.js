/* eslint-disable node/no-unsupported-features/es-syntax */
const axios = require('axios');
const FormData = require('form-data');
const huggingFaceClient = require('../client/huggingfaceClient');
const groqClient = require('../client/groqClient');
const supabase = require('../client/supabaseClient');
const localDb = require('../client/localDbClient');
const apiConfig = require('../apiconfig/apiConfig');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');
const {
  clampNumber,
  parseBoolean,
  bloomToNumber,
  numberToBloom,
  validBloomLevels,
} = require('../utils/kathakaliUtils');
const CurriculumService = require('../services/curriculumService');

const curriculumService = new CurriculumService();
const eventRouterService = require('../services/eventRouterService');
const embeddingService = require('../services/embeddingService');
const storageService = require('../services/minioStorageService');
const ProficiencyAssessmentService = require('../services/proficiencyAssessmentService');
const MULTI_TURN_MAX_PREVIOUS_TURNS = 2;
const MULTI_TURN_HISTORY_MESSAGE_LIMIT = MULTI_TURN_MAX_PREVIOUS_TURNS * 2;

const getLlmLogPreviewChars = () =>
  clampNumber(process.env.LLM_LOG_PROMPT_PREVIEW_CHARS, 100, 5000, 1200);

const serializeLlmMessagesForLog = (messages = []) => {
  const logFullPrompt = parseBoolean(process.env.LLM_LOG_FULL_PROMPT, false);
  const previewChars = getLlmLogPreviewChars();

  return (messages || []).map((msg) => ({
    role: msg?.role,
    content: logFullPrompt
      ? msg?.content
      : String(msg?.content || '').slice(0, previewChars),
  }));
};

const buildMultiTurnTeachingGuidance = (
  historyMessages = [],
  currentMessage = '',
) => {
  const previousUserQueries = (historyMessages || [])
    .filter((entry) => entry?.role === 'user' && entry?.content)
    .map((entry) => String(entry.content).trim())
    .filter(Boolean);

  const anchorQuery = previousUserQueries[0] || null;
  const latestUserQuery =
    previousUserQueries[previousUserQueries.length - 1] || null;
  const currentQuery = String(currentMessage || '').trim();
  const lowerCurrent = currentQuery.toLowerCase();

  const explicitTopicReset =
    lowerCurrent.includes('new sequence')
    || lowerCurrent.includes('new scene')
    || lowerCurrent.includes('change topic')
    || lowerCurrent.includes('different story')
    || lowerCurrent.includes('start over');

  const requestedExpressionRefinement =
    lowerCurrent.includes('expressive')
    || lowerCurrent.includes('emotion')
    || lowerCurrent.includes('joy')
    || lowerCurrent.includes('playful')

  const guidance = [
    `Conversation continuity is enabled for the last ${MULTI_TURN_MAX_PREVIOUS_TURNS} turn(s).`,
  ];

  if (!explicitTopicReset && anchorQuery) {
    guidance.push(
      `Treat this as iterative refinement of the same mudra sequence anchored to the earliest user intent: "${anchorQuery}".`,
    );
  } else {
    guidance.push(
      'User appears to reset topic; start a fresh sequence and do not force old context.',
    );
  }

  if (latestUserQuery) {
    guidance.push(`Most recent prior refinement request: "${latestUserQuery}".`);
  }

  guidance.push(
    'Respond like a Kathakali teacher progressively correcting a student over turns.',
    'Keep core narrative entities/actions stable unless user explicitly changes storyline/topic.',
    'When refining, return: (1) Updated sequence steps, (2) expression cues',
  );

  if (requestedExpressionRefinement) {
    guidance.push(
      'User requests stronger expressiveness; prioritize joy/playfulness accents.',
    );
  }

  return guidance.join(' ');
};

const ensureAdminAuditTrailTable = async () => {
  await localDb.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_trail (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id TEXT,
      actor_email TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await localDb.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_created_at
    ON admin_audit_trail (created_at DESC);
  `);
  await localDb.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_action
    ON admin_audit_trail (action);
  `);
  await localDb.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_actor
    ON admin_audit_trail (actor_user_id);
  `);
};

const getAuditLogRetentionDays = () =>
  clampNumber(process.env.AUDIT_LOG_RETENTION_DAYS, 1, 3650, 90);

const pruneAdminAuditTrail = async () => {
  const retentionDays = getAuditLogRetentionDays();
  await localDb.query(
    `DELETE FROM admin_audit_trail
     WHERE created_at < NOW() - ($1::int * INTERVAL '1 day');`,
    [retentionDays],
  );
};

const writeLlmAuditTrail = async (
  req,
  {
    label,
    provider,
    model,
    messages,
    responseMessage,
    status = 'success',
    error,
    extra = {},
  } = {},
) => {
  const enabled = parseBoolean(process.env.LLM_AUDIT_LOG_ENABLED, false);
  if (!enabled) return;

  try {
    await ensureAdminAuditTrailTable();
    await pruneAdminAuditTrail();

    const details = {
      label,
      provider,
      model,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      messages: serializeLlmMessagesForLog(messages || []),
      responsePreview: String(responseMessage || '').slice(
        0,
        getLlmLogPreviewChars(),
      ),
      responseLength: String(responseMessage || '').length,
      error: error ? String(error.message || error) : null,
      ...extra,
    };

    await localDb.query(
      `INSERT INTO admin_audit_trail (
        actor_user_id,
        actor_email,
        actor_role,
        action,
        resource_type,
        resource_id,
        status,
        details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);`,
      [
        req?.user?.id ? String(req.user.id) : null,
        req?.user?.email ? String(req.user.email) : null,
        req?.user?.role ? String(req.user.role).toLowerCase() : null,
        'llm.request',
        'llm',
        label || provider || model || 'unknown',
        status,
        JSON.stringify(details),
      ],
    );
  } catch (auditError) {
    console.warn('[LLM AUDIT] Failed to persist LLM audit trail:', auditError.message || auditError);
  }
};

const logLlmRequestPayload = ({
  label,
  provider,
  model,
  messages,
  extra = {},
}) => {
  const enabled = parseBoolean(process.env.LLM_LOG_REQUEST_PAYLOAD, false);
  if (!enabled) return;

  const serializedMessages = serializeLlmMessagesForLog(messages || []);

  console.log(`=== ${label} Request Payload ===`);
  console.log(
    JSON.stringify(
      {
        provider,
        model,
        messageCount: serializedMessages.length,
        messages: serializedMessages,
        ...extra,
      },
      null,
      2,
    ),
  );
  console.log(`=== End ${label} Request Payload ===\n`);
};

const validateObjectName = (name) => {
  if (!name || name.includes('..') || name.startsWith('/')) {
    throw new Error('Invalid file path');
  }
  return name;
};

// Helper function to classify based on the endpoint for single image
const classifyImageSingle = async (req, res, apiEndpoint) => {
  try {
    // Check if file is provided
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Check if the file is an image
    if (!req.file.mimetype.startsWith('image')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Create a FormData object
    const formData = new FormData();
    formData.append('image', req.file.buffer, {
      filename: req.file.originalname,
    });

    // Make a POST request to the microservice
    const microserviceResponse = await axios.post(apiEndpoint, formData);

    // Return the response with the location added
    return res
      .status(200)
      .json([{ ...microserviceResponse.data, location: [0, 0, 0, 0, 0] }]);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to detect faces using the fixed facial detection API and classify them using a configurable endpoint
const classifyImageMultiple = async (req, res, apiEndpoint) => {
  try {
    // Prepare the form data with the uploaded image
    const faceForm = new FormData();
    faceForm.append('image', req.file.buffer, {
      filename: req.file.originalname,
    });

    // The facial detection API is a fixed endpoint
    const faceDetectResponse = await axios.post(
      apiConfig.facialDetectionApi,
      faceForm,
      {
        headers: {
          ...faceForm.getHeaders(),
        },
      },
    );

    // Handle errors in face detection response
    if (faceDetectResponse.data.error) {
      return res.status(400).json({ error: faceDetectResponse.data.error });
    }

    const { faces, locations } = faceDetectResponse.data;
    if (faces.length === 0) {
      return res.status(400).json({ error: 'No faces detected' });
    }

    // Process each face for classification
    const responses = await Promise.all(
      faces.map(async (face, i) => {
        try {
          // Decode the Base64-encoded face image to a binary buffer
          const imageBuffer = Buffer.from(face, 'base64');

          // Create a FormData object for each face
          const formData = new FormData();
          formData.append('image', imageBuffer, {
            filename: `face.jpg`,
            contentType: 'image/jpeg', // Correct MIME type for the image
          });

          // Send the face image to the configurable classification API
          const microserviceResponse = await axios.post(apiEndpoint, formData, {
            headers: {
              ...formData.getHeaders(),
            },
          });

          // Return the classified data with corresponding face location
          return { ...microserviceResponse.data, location: locations[i] };
        } catch (error) {
          console.error('Error sending face to microservice:', error);
          // Return an error message for the specific face
          return { error: 'Failed to classify face' };
        }
      }),
    );

    // Return the responses for all faces as a JSON array
    return res.status(200).json(responses);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.classifyExpression = async (req, res) => {
  if (!req.body) {
    console.error('req.body is undefined');
    return res.status(400).json({ error: 'Request body is missing' });
  }
  const isMultipleRecognition = req.body.isMultipleRecognition === 'true';
  const apiEndpoint = apiConfig.expressionDetectionApi;
  try {
    // Not multiple means is just singular
    if (!isMultipleRecognition) {
      return await classifyImageSingle(req, res, apiEndpoint);
    }
    // If multiple get the faces and send to API
    return await classifyImageMultiple(req, res, apiEndpoint);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.classifyCharacter = async (req, res) => {
  if (!req.body) {
    console.error('req.body is undefined');
    return res.status(400).json({ error: 'Request body is missing' });
  }
  const isMultipleRecognition = req.body.isMultipleRecognition === 'true';
  const apiEndpoint = apiConfig.kathakaliCharacterClassificationApi;
  try {
    if (!isMultipleRecognition) {
      return await classifyImageSingle(req, res, apiEndpoint);
    }
    console.log('multiple recognition');
    return await classifyImageMultiple(req, res, apiEndpoint);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// TODO: TO BE MIGRATED TO CHAT SERVICE

exports.chat = async (req, res) => {
  let llmAuditContext = null;
  try {
    const { message, imageAnalysis, characterData, expressionData } =
      req.body || {};

    if (!message) {
      console.log('Query missing, returning 400');
      return res.status(400).json({ error: 'Query is required' });
    }

    const client = huggingFaceClient.getInstance();

    const messages = [
      {
        role: 'user',
        content: message,
      },
    ];

    // RAG: Parse query to extract event search parameters
    const eventParams = await eventRouterService.parseEventQuery(message);
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
    const imageFile =
      req.file ||
      (req.files && req.files.find((file) => file.fieldname === 'image'));
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

    const model = process.env.HF_CHAT_MODEL || 'openai/gpt-oss-120b';
    const provider = process.env.HF_CHAT_PROVIDER || 'together';
    const llmStartedAt = Date.now();
    llmAuditContext = {
      label: 'HF Chat',
      provider,
      model,
      messages,
      extra: {
        route: 'chat',
      },
      llmStartedAt,
    };

    logLlmRequestPayload({
      label: 'HF Chat',
      provider,
      model,
      messages,
    });

    const chatCompletion = await client.chatCompletion({
      provider,
      model,
      messages: messages,
    });

    const responseMessage = chatCompletion.choices[0].message.content;
    await writeLlmAuditTrail(req, {
      ...llmAuditContext,
      status: 'success',
      responseMessage,
      extra: {
        ...(llmAuditContext?.extra || {}),
        durationMs: Date.now() - llmStartedAt,
      },
    });

    const chatbotResponse = preprocessChatResponse(responseMessage);

    return res.status(200).json(chatbotResponse);
  } catch (error) {
    console.log('Error in chat:', error);

    await writeLlmAuditTrail(req, {
      ...(llmAuditContext || {}),
      status: 'failed',
      error,
      extra: {
        ...(llmAuditContext?.extra || {}),
        durationMs: llmAuditContext?.llmStartedAt
          ? Date.now() - llmAuditContext.llmStartedAt
          : null,
      },
    });

    if (error.message && error.message.includes('token')) {
      return res
        .status(401)
        .json({ error: 'Invalid or missing Hugging Face token' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.chatMudras = async (req, res) => {
  let llmAuditContext = null;
  try {
    const {
      message,
      sessionId,
      historyMessages: requestHistoryMessages,
      imageAnalysis,
      characterData,
      expressionData,
      rerankerStrategy,
      knowledgeSource,
      systemPrompt,
      similarityThreshold,
      vectorWeight,
      fullTextWeight,
      topN,
      multiTurnOptimization,
    } = req.body || {};

    if (!message) {
      console.log('Query missing, returning 400');
      return res.status(400).json({ error: 'Query is required' });
    }

    const client = groqClient.getInstance();

    // RAG: Search local knowledge base with two-stage retrieval (vector + reranking)
    const thresholdValue = clampNumber(similarityThreshold, 0, 1, 0.35);
    const resultLimit = Math.round(
      clampNumber(topN, 1, 20, Number(process.env.KB_RAG_TOP_K || 6)),
    );
    const vectorWeightValue = clampNumber(vectorWeight, 0, 1, 0.3);
    const fullTextWeightValue = clampNumber(
      fullTextWeight,
      0,
      1,
      Number((1 - vectorWeightValue).toFixed(2)),
    );
    const multiTurnOptimizationValue = parseBoolean(
      multiTurnOptimization,
      true,
    );
    const requesterUserId = req.user?.id || null;
    const requestedSessionId =
      typeof sessionId === 'string' && sessionId.trim().length > 0
        ? sessionId.trim()
        : null;

    let ownedSessionId = null;
    if (requestedSessionId && requesterUserId) {
      const { data: ownedSession, error: ownedSessionError } = await supabase
        .from('sessions')
        .select('id')
        .eq('id', requestedSessionId)
        .eq('user_id', requesterUserId)
        .single();

      if (ownedSessionError || !ownedSession) {
        console.warn(
          `[chat-mudras] Ignoring session ${requestedSessionId} - not owned by requester ${requesterUserId}`,
        );
      } else {
        ownedSessionId = ownedSession.id;
      }
    }

    let historyMessages = [];
    if (multiTurnOptimizationValue && ownedSessionId) {
      const { data: recentMessages, error: recentMessagesError } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('session_id', ownedSessionId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(MULTI_TURN_HISTORY_MESSAGE_LIMIT);

      if (recentMessagesError) {
        console.warn(
          '[chat-mudras] Failed to load recent session messages for multi-turn optimization:',
          recentMessagesError.message,
        );
      } else {
        historyMessages = (recentMessages || [])
          .reverse()
          .map((row) => ({
            role: row.role,
            content: row.content,
          }))
          .filter((row) => row.role && row.content);
      }
    } else if (multiTurnOptimizationValue && Array.isArray(requestHistoryMessages)) {
      historyMessages = requestHistoryMessages
        .map((row) => ({
          role: String(row?.role || '').trim().toLowerCase(),
          content: String(row?.content || '').trim(),
        }))
        .filter(
          (row) =>
            (row.role === 'user' || row.role === 'assistant')
            && row.content.length > 0,
        )
        .slice(-MULTI_TURN_HISTORY_MESSAGE_LIMIT);
    }

    let ragContext = '';
    let citations = [];
    let retrievalDebug = {
      knowledgeSource: knowledgeSource || 'all',
      strategy: rerankerStrategy || 'embedding-based',
      totalRetrieved: 0,
      usedInContext: 0,
      contextTokens: 0,
      confidenceAvg: null,
      chunks: [],
      settings: {
        similarityThreshold: thresholdValue,
        topN: resultLimit,
        vectorWeight: vectorWeightValue,
        fullTextWeight: fullTextWeightValue,
        multiTurnOptimization: multiTurnOptimizationValue,
        maxPreviousTurns: MULTI_TURN_MAX_PREVIOUS_TURNS,
        historyMessagesIncluded: historyMessages.length,
        sessionId: ownedSessionId,
      },
    };
    try {
      // Use provided strategy or default to 'embedding-based'
      const strategy = rerankerStrategy || 'embedding-based';

      const similarChunks =
        await embeddingService.searchLocalKnowledgeBaseWithReranking(
          localDb,
          message,
          resultLimit, // Final result limit
          thresholdValue, // similarity threshold for stage 1
          true, // Enable reranking
          strategy, // Pass selected reranking strategy
          {
            vectorWeight: vectorWeightValue,
            fullTextWeight: fullTextWeightValue,
          },
          {
            deployTarget: 'mudras',
          },
        );

      let filteredChunks = similarChunks || [];
      if (knowledgeSource && knowledgeSource !== 'all') {
        filteredChunks = filteredChunks.filter((chunk) => {
          const source = chunk.source_file || '';
          if (knowledgeSource.endsWith('/')) {
            return source.startsWith(knowledgeSource);
          }
          return (
            source === knowledgeSource ||
            source.startsWith(`${knowledgeSource}/`)
          );
        });
      }

      // De-duplicate by source + page to reduce repetitive citations
      const seenSourcePage = new Set();
      filteredChunks = filteredChunks.filter((chunk) => {
        const source = chunk.source_file || 'unknown';
        const page = chunk.metadata?.page || 'na';
        const key = `${source}::${page}`;
        if (seenSourcePage.has(key)) return false;
        seenSourcePage.add(key);
        return true;
      });

      if (filteredChunks && filteredChunks.length > 0) {
        console.log(
          `Local RAG found ${filteredChunks.length} relevant chunk(s) (strategy: ${strategy}, source: ${knowledgeSource || 'all'})`,
        );

        // Build context with smart truncation to avoid token limit
        const MAX_CONTEXT_LENGTH = 2000; // Approximate token limit to stay safe
        const ragContextParts = [];
        let currentContextLength = 0;

        // Take top chunks up to context length limit
        const selectedChunks = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const chunk of filteredChunks) {
          const pageInfo = chunk.metadata?.page
            ? ` (Page ${chunk.metadata.page})`
            : '';
          const chunkText = `[Source: ${chunk.source_file}${pageInfo}]\n${chunk.content}`;

          // Estimate tokens (rough: 1 word = 1.3 tokens)
          const chunkTokens = Math.ceil(chunkText.split(/\s+/).length * 1.3);

          if (currentContextLength + chunkTokens <= MAX_CONTEXT_LENGTH) {
            ragContextParts.push(chunkText);
            selectedChunks.push(chunk);
            currentContextLength += chunkTokens;
          } else {
            break; // Stop adding chunks if we exceed limit
          }
        }

        ragContext = ragContextParts.join('\n\n');

        console.log(
          `Using ${selectedChunks.length} chunks (context ~${currentContextLength} tokens)`,
        );

        const queryTerms = (message || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((term) => term && term.length > 2);

        retrievalDebug = {
          knowledgeSource: knowledgeSource || 'all',
          strategy,
          totalRetrieved: filteredChunks.length,
          usedInContext: selectedChunks.length,
          contextTokens: currentContextLength,
          confidenceAvg: selectedChunks.length
            ? Number(
                (
                  selectedChunks.reduce((sum, chunk) => {
                    const score =
                      chunk.combined_score ||
                      chunk.similarity ||
                      chunk.base_similarity ||
                      0;
                    return sum + score;
                  }, 0) / selectedChunks.length
                ).toFixed(4),
              )
            : null,
          chunks: selectedChunks.map((chunk, index) => {
            const content = chunk.content || '';
            const lowered = content.toLowerCase();
            const matchedTerms = queryTerms.filter((term) =>
              lowered.includes(term),
            );
            return {
              id: index + 1,
              source: chunk.source_file,
              page: chunk.metadata?.page || null,
              excerpt: content.slice(0, 320),
              matchedTerms: [...new Set(matchedTerms)].slice(0, 8),
              baseSimilarity: chunk.base_similarity || null,
              rerankerScore: chunk.reranker_score || null,
              combinedScore: chunk.combined_score || chunk.similarity || null,
              keywordBoost: chunk.keyword_boost || 0,
              questionBoost: chunk.question_boost || 0,
            };
          }),
        };

        // Build citations array with boost information
        citations = selectedChunks.map((chunk, index) => ({
          id: index + 1,
          source: chunk.source_file,
          page: chunk.metadata?.page || null,
          similarity: chunk.base_similarity || chunk.similarity || null,
          keywordBoost: chunk.keyword_boost || 0,
          questionBoost: chunk.question_boost || 0,
          totalScore: chunk.similarity || null,
          // Add reranking scores if available
          rerankerScore: chunk.reranker_score || null,
          originalSimilarity: chunk.original_similarity || null,
          combinedScore: chunk.combined_score || null,
        }));

        // Log boost and reranking information for debugging
        selectedChunks.forEach((chunk, idx) => {
          if (chunk.keyword_boost > 0 || chunk.question_boost > 0) {
            console.log(
              `Chunk ${idx + 1} boosted - Keyword: ${chunk.keyword_boost}, Question: ${chunk.question_boost}`,
            );
          }
        });
      } else {
        console.log('No relevant chunks found in local knowledge base');
        retrievalDebug = {
          ...retrievalDebug,
          totalRetrieved: 0,
          usedInContext: 0,
          contextTokens: 0,
          confidenceAvg: null,
          chunks: [],
        };
      }
    } catch (ragError) {
      console.error('Error searching local knowledge base:', ragError);
      // Continue with query if RAG fails
    }

    const messages = [
      ...historyMessages,
      {
        role: 'user',
        content: message,
      },
    ];

    // Build system prompt with RAG context
    let systemMessage =
      'You are a knowledgeable assistant about Kathakali and Indian classical dance forms. ';

    if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
      systemMessage = systemPrompt.trim();
    }

    if (ragContext) {
      systemMessage += `\n\nHere is relevant information from the knowledge base to help answer the user's question:\n\n${ragContext}\n\nUse this context to provide accurate, cited answers. If the context is insufficient, use your knowledge to supplement.`;
    } else {
      systemMessage +=
        'Help the user with information about Kathakali traditions, characters, expressions, and cultural significance.';
    }

    // Add image analysis if provided
    if (imageAnalysis) {
      systemMessage += `\n\nImage Analysis Context: ${imageAnalysis}`;
    }

    // Add character and expression info
    if (characterData && characterData.length > 0) {
      const characters = characterData
        .map((data) => data.character || data.predicted_class)
        .filter(Boolean);
      if (characters.length > 0) {
        systemMessage += `\nThe analyzed image contains these Kathakali character(s): ${characters.join(', ')}.`;
      }
    }

    if (expressionData && expressionData.length > 0) {
      const expressions = expressionData
        .map((data) => data.expression || data.predicted_class)
        .filter(Boolean);
      if (expressions.length > 0) {
        systemMessage += `\nThe detected expression(s) are: ${expressions.join(', ')}.`;
      }
    }

    if (multiTurnOptimizationValue && historyMessages.length > 0) {
      const continuityGuidance = buildMultiTurnTeachingGuidance(
        historyMessages,
        message,
      );
      systemMessage += `\n\n${continuityGuidance}`;
    }

    messages.unshift({
      role: 'system',
      content: systemMessage,
    });

    // Estimate total tokens to prevent overflow
    const estimatedTokens = Math.ceil(
      (systemMessage.split(/\s+/).length + message.split(/\s+/).length) * 1.3,
    );

    console.log('=== LLM Request Info ===');
    console.log(
      `System Message Length: ${systemMessage.length} chars, ~${Math.ceil(systemMessage.split(/\s+/).length * 1.3)} tokens`,
    );
    console.log(
      `Query Length: ${message.length} chars, ~${Math.ceil(message.split(/\s+/).length * 1.3)} tokens`,
    );
    console.log(`Total Estimated Tokens: ${estimatedTokens}`);
    console.log(
      `RAG Context: ${ragContext ? `${Math.ceil(ragContext.split(/\s+/).length * 1.3)} tokens` : 'None'}`,
    );
    console.log(`Model: ${process.env.GROQ_MODEL || 'openai/gpt-oss-120b'}`);
    console.log(`Provider: Groq`);
    console.log('=======================\n');

    if (estimatedTokens > 3000) {
      console.warn(
        `⚠️  High token count: ${estimatedTokens} - response may be truncated`,
      );
    }

    // Use the GROQ_MODEL or default model
    const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    const llmStartedAt = Date.now();
    llmAuditContext = {
      label: 'Groq Chat Mudras',
      provider: 'groq',
      model,
      messages,
      extra: {
        route: 'chat-mudras',
        knowledgeSource: knowledgeSource || 'all',
        rerankerStrategy: rerankerStrategy || 'embedding-based',
        max_tokens: 2000,
        temperature: 0.7,
      },
      llmStartedAt,
    };

    logLlmRequestPayload({
      label: 'Groq Chat Mudras',
      provider: 'groq',
      model,
      messages,
      extra: {
        max_tokens: 2000,
        temperature: 0.7,
      },
    });

    const chatCompletion = await client.chat.completions.create({
      model,
      messages,
      max_tokens: 2000,
      temperature: 0.7,
    });

    const responseMessage = chatCompletion.choices[0].message.content;
    await writeLlmAuditTrail(req, {
      ...llmAuditContext,
      status: 'success',
      responseMessage,
      extra: {
        ...(llmAuditContext?.extra || {}),
        durationMs: Date.now() - llmStartedAt,
        retrieval: {
          totalRetrieved: retrievalDebug.totalRetrieved,
          usedInContext: retrievalDebug.usedInContext,
          contextTokens: retrievalDebug.contextTokens,
        },
      },
    });

    console.log('=== LLM Response Info ===');
    console.log(`Response Length: ${responseMessage.length} chars`);
    console.log(`Response Preview: ${responseMessage.substring(0, 200)}...`);
    console.log(`Full Response:\n${responseMessage}`);
    console.log('========================\n');

    const chatbotResponse = preprocessChatResponse(responseMessage);

    if (ownedSessionId) {
      try {
        const { error: persistError } = await supabase.from('messages').insert([
          {
            session_id: ownedSessionId,
            role: 'user',
            content: message,
            metadata: {
              source: 'chat-mudras',
              multiTurnOptimization: multiTurnOptimizationValue,
              knowledgeSource: knowledgeSource || 'all',
            },
            response_for: null,
            is_summary: false,
          },
          {
            session_id: ownedSessionId,
            role: 'assistant',
            content: responseMessage,
            metadata: {
              source: 'chat-mudras',
              generatedWithRAG: true,
              multiTurnOptimization: multiTurnOptimizationValue,
            },
            response_for: null,
            is_summary: false,
          },
        ]);
        if (persistError) {
          console.warn(
            '[chat-mudras] Failed to persist turn in session history:',
            persistError.message || persistError,
          );
        }
      } catch (persistError) {
        console.warn(
          '[chat-mudras] Failed to persist turn in session history:',
          persistError.message || persistError,
        );
      }
    }

    // Add citations to response
    chatbotResponse.citations = citations;
    chatbotResponse.retrieval = retrievalDebug;

    return res.status(200).json(chatbotResponse);
  } catch (error) {
    console.log('Error in chatMudras:', error);

    await writeLlmAuditTrail(req, {
      ...(llmAuditContext || {}),
      status: 'failed',
      error,
      extra: {
        ...(llmAuditContext?.extra || {}),
        durationMs: llmAuditContext?.llmStartedAt
          ? Date.now() - llmAuditContext.llmStartedAt
          : null,
      },
    });

    if (error.message && error.message.includes('api_key')) {
      return res.status(401).json({ error: 'Invalid or missing Groq API key' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Public download for cited knowledge-base source files (used by Learn page chat)
exports.downloadMudrasSource = async (req, res) => {
  try {
    const fileName = decodeURIComponent(req.params.fileName || '');
    validateObjectName(fileName);

    const { rows } = await localDb.query(
      'SELECT 1 FROM knowledge_base WHERE source_file = $1 LIMIT 1;',
      [fileName],
    );

    if (!rows || rows.length === 0) {
      return res
        .status(404)
        .json({ error: 'Source file not found in knowledge base' });
    }

    const exists = await storageService.objectExists(fileName);
    if (!exists) {
      return res
        .status(404)
        .json({ error: 'Source file not found in storage' });
    }

    const fileBuffer = await storageService.getObject(fileName);
    let contentType = 'application/octet-stream';
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.pdf')) contentType = 'application/pdf';
    else if (lowerName.endsWith('.txt')) contentType = 'text/plain';
    else if (lowerName.endsWith('.json')) contentType = 'application/json';

    const basename = fileName.split('/').pop() || fileName;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    return res.status(200).send(fileBuffer);
  } catch (error) {
    console.error('Error downloading mudras source file:', error);
    return res.status(500).json({ error: 'Failed to download source file' });
  }
};

/**
 * Generate quiz questions from chat history
 * POST /kathakali/generate-quiz-from-chat
 * Body: { chatHistory: Array<{role, content}>, count: number }
 */
exports.generateQuizFromChat = async (req, res) => {
  try {
    const { chatHistory, count = 5 } = req.body;

    if (
      !chatHistory ||
      !Array.isArray(chatHistory) ||
      chatHistory.length === 0
    ) {
      return res.status(400).json({ error: 'Chat history is required' });
    }

    const client = groqClient.getInstance();

    // Extract Q&A pairs from chat history
    const qaPairs = [];
    for (let i = 0; i < chatHistory.length; i += 1) {
      if (
        chatHistory[i].role === 'user' &&
        i + 1 < chatHistory.length &&
        chatHistory[i + 1].role === 'assistant'
      ) {
        qaPairs.push({
          question: chatHistory[i].content,
          answer: chatHistory[i + 1].content,
        });
      }
    }

    if (qaPairs.length === 0) {
      return res
        .status(400)
        .json({ error: 'No Q&A pairs found in chat history' });
    }
    console.log(
      `[QUIZ GEN] Extracted ${qaPairs.length} Q&A pairs from chat history:`,
    );
    qaPairs.forEach((qa, idx) => {
      console.log(`  Q${idx + 1}: ${qa.question}`);
      console.log(`  A${idx + 1}: ${qa.answer}\n`);
    });
    // Build context from Q&A pairs
    const contextText = qaPairs
      .map(
        (qa, idx) => `Q${idx + 1}: ${qa.question}\nA${idx + 1}: ${qa.answer}`,
      )
      .join('\n\n');

    // Generate quiz using LLM
    const prompt = `Based on the following conversation about Kathakali, generate ${count} multiple-choice quiz questions to test understanding.

Chat History:
${contextText}

Generate ${count} quiz questions in the following JSON format:
[
  {
    "id": 1,
    "question": "What is ...",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": "Option A",
    "explanation": "Brief explanation"
  }
]

Requirements:
- Each question should test key concepts from the conversation
- Provide 4 options per question
- Include the correct answer
- Add a brief explanation
- Questions should vary in difficulty
- Focus on Kathakali mudras, expressions, characters, or cultural knowledge discussed

Return ONLY the JSON array, no additional text.`;

    console.log(
      '[QUIZ GEN] Generating quiz from chat history with',
      qaPairs.length,
      'Q&A pairs',
    );

    const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a quiz generator expert specializing in Kathakali art form. Generate high-quality quiz questions based on conversation history. Return only valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    });

    let quizData = response.choices[0]?.message?.content || '[]';

    // Clean up response - remove markdown code blocks if present
    quizData = quizData
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    // Parse JSON
    let questions;
    try {
      questions = JSON.parse(quizData);
    } catch (parseError) {
      console.error('[QUIZ GEN] Failed to parse LLM response:', quizData);
      return res
        .status(500)
        .json({ error: 'Failed to parse quiz questions from LLM' });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res
        .status(500)
        .json({ error: 'No valid quiz questions generated' });
    }

    console.log(
      '[QUIZ GEN] Successfully generated',
      questions.length,
      'quiz questions',
    );

    return res.status(200).json({
      questions,
      sourceQAPairs: qaPairs.length,
    });
  } catch (error) {
    console.error('Error generating quiz from chat:', error);
    return res.status(500).json({ error: 'Failed to generate quiz' });
  }
};

/**
 * Generate adaptive quiz from user's proficiency gaps
 * GET /api/kathakali/generate-adaptive-quiz
 */
exports.generateAdaptiveQuiz = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;

    console.log(`[ADAPTIVE QUIZ] Generating for user: ${userId}`);

    // Fetch all proficiency states for this user from DB
    const { data: proficiencyStates, error } = await supabase
      .from('user_proficiency_state')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error('[ADAPTIVE QUIZ] Supabase error:', error);
      return res
        .status(500)
        .json({ error: 'Failed to fetch proficiency data' });
    }

    if (!proficiencyStates || proficiencyStates.length === 0) {
      return res.status(404).json({
        error:
          'No proficiency data found. Chat more to build your knowledge profile!',
      });
    }

    console.log(
      `[ADAPTIVE QUIZ] Found ${proficiencyStates.length} tracked concepts`,
    );

    // Prioritize concepts with misconceptions, then fill with random selection
    const misconceptionConcepts = proficiencyStates.filter(
      (state) => state.misconception_flag,
    );
    const nonMisconceptionConcepts = proficiencyStates.filter(
      (state) => !state.misconception_flag,
    );

    console.log(
      `[ADAPTIVE QUIZ] Misconception concepts: ${misconceptionConcepts.length}, Non-misconception: ${nonMisconceptionConcepts.length}`,
    );

    // Select up to 5: prioritize misconceptions, then random from others
    const selectedConcepts = [];
    selectedConcepts.push(...misconceptionConcepts); // Add all misconception concepts first
    if (selectedConcepts.length < 5) {
      const remainingSlots = 5 - selectedConcepts.length;
      const shuffledNonMisconception = nonMisconceptionConcepts.sort(
        () => Math.random() - 0.5,
      );
      selectedConcepts.push(
        ...shuffledNonMisconception.slice(0, remainingSlots),
      );
    }

    console.log(
      `[ADAPTIVE QUIZ] Selected ${selectedConcepts.length} concepts (prioritizing misconceptions):`,
      selectedConcepts.map(
        (g) =>
          `${g.node_id}(${g.bloom_level}, misconception: ${g.misconception_flag})`,
      ),
    );

    // Helper to get next Bloom level (mathematically controlled elevation)
    const getNextBloomLevel = (currentLevel) => {
      const levels = [
        '0_unseen',
        '1_remember',
        '2_understand',
        '3_apply',
        '4_analyze',
      ];
      const currentIndex = levels.indexOf(currentLevel);
      if (currentIndex === -1 || currentIndex >= levels.length - 1) {
        return currentLevel;
      }
      return levels[currentIndex + 1];
    };

    // Build descriptors with potential elevation (confidence-based probability)
    const conceptDescriptors = selectedConcepts.map((state) => {
      // Elevate if: no misconception, not at max level, AND confidence-based probability
      const meetsConditions =
        !state.misconception_flag && state.bloom_level !== '4_analyze';
      const confidence = state.last_confidence || 0;
      // Use confidence as probability (clamped 10%-90% to avoid extremes)
      const elevationProbability = Math.max(0.1, Math.min(0.9, confidence));
      const randomChance = Math.random() < elevationProbability;
      const canElevate = meetsConditions && randomChance;
      const targetLevel = canElevate
        ? getNextBloomLevel(state.bloom_level)
        : state.bloom_level;
      console.log(
        `[ADAPTIVE QUIZ] Concept ${state.node_id}: current=${state.bloom_level}, confidence=${confidence}, misconception=${state.misconception_flag}, meetsConditions=${meetsConditions}, elevationProb=${elevationProbability.toFixed(2)}, randomChance=${randomChance}, target=${targetLevel} (${canElevate ? 'elevated' : 'consolidation'})`,
      );
      return {
        concept: state.node_id,
        current_bloom_level: state.bloom_level,
        target_bloom_level: targetLevel, // Use this for question difficulty
        misconception: state.misconception_flag,
        evidence: state.last_evidence || null,
      };
    });

    // Generate exactly 5 questions using GROQ
    const client = groqClient.getInstance();
    const targetCount = 5;

    const prompt = `You are a Kathakali teacher. A student has the following knowledge profile. Generate exactly ${targetCount} multiple-choice questions.

STUDENT'S KNOWLEDGE PROFILE:
${JSON.stringify(conceptDescriptors, null, 2)}

RULES:
- There are ${selectedConcepts.length} concept(s). If less than ${targetCount}, generate multiple questions per concept to reach exactly ${targetCount} total.
- When generating multiple questions for the same concept, each question must ask about a DIFFERENT aspect of that concept.
- Match question difficulty strictly to target_bloom_level (not current_bloom_level):
    "0_unseen"    → Easy. Simple definition or identification. Example: "What is X?"
    "1_remember"  → Easy-Medium. Basic recall. Example: "What does X represent?"
    "2_understand"→ Medium. Explanation. Example: "Why does X have Y characteristic?"
    "3_apply"     → Medium-Hard. Scenario-based. Example: "In this situation, which would...?"
    "4_analyze"   → Hard. Critical analysis or comparison. Example: "What is the key difference between X and Y, and why does it matter?"
- If misconception = true: Write a question that directly corrects the misunderstanding shown in evidence.
- Provide exactly 4 options per question.

Return ONLY a valid JSON array, no extra text. Every item MUST include these fields:
- id (number)
- concept_id (string): must be one of the student's concept values (exactly)
- target_level (string): must match the student's target_bloom_level for that concept
- misconception_target (boolean): true if misconception=true for that concept
- question (string)
- options (array of 4 strings)
- correctAnswer (string): must exactly match one of the options
- explanation (string)

JSON format:
[
  {
    "id": 1,
    "concept_id": "paccha_characters",
    "target_level": "2_understand",
    "misconception_target": false,
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correctAnswer": "B",
    "explanation": "..."
  }
]`;

    const response = await client.chat.completions.create({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content:
            'You are a Kathakali quiz generator. Output only valid JSON arrays. No markdown, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 3000,
      temperature: 0.5,
    });

    const quizData = response.choices[0].message.content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let questions;
    try {
      questions = JSON.parse(quizData);
    } catch (parseError) {
      console.error('[ADAPTIVE QUIZ] Failed to parse AI response:', quizData);
      return res
        .status(500)
        .json({ error: 'Failed to parse quiz from AI response' });
    }

    console.log(
      `[ADAPTIVE QUIZ] Generated ${questions.length} questions from ${selectedConcepts.length} concepts`,
    );

    // Persist quiz session + questions so submission can be graded deterministically
    const { data: quizSession, error: quizSessionError } = await supabase
      .from('quiz_session')
      .insert({
        user_id: userId,
        source: 'adaptive',
        selected_concepts: conceptDescriptors,
      })
      .select('id, created_at')
      .single();

    if (quizSessionError) {
      console.error(
        '[ADAPTIVE QUIZ] Failed to create quiz session:',
        quizSessionError,
      );
      return res.status(500).json({ error: 'Failed to persist quiz session' });
    }

    const questionRows = (Array.isArray(questions) ? questions : []).map(
      (q) => {
        const conceptId = q?.concept_id;
        const targetLevel = q?.target_level;

        if (!conceptId || !targetLevel || !validBloomLevels.has(targetLevel)) {
          return null;
        }

        return {
          quiz_id: quizSession.id,
          display_id: Number(q.id) || null,
          concept_id: conceptId,
          target_level: targetLevel,
          misconception_target: Boolean(q.misconception_target),
          question: String(q.question || ''),
          options: Array.isArray(q.options) ? q.options : [],
          correct_answer: String(q.correctAnswer || ''),
          explanation: String(q.explanation || ''),
        };
      },
    );

    const filteredQuestionRows = questionRows.filter(
      (row) =>
        row &&
        row.question &&
        Array.isArray(row.options) &&
        row.options.length === 4 &&
        row.correct_answer,
    );

    if (filteredQuestionRows.length === 0) {
      console.error(
        '[ADAPTIVE QUIZ] No valid questions to persist:',
        questions,
      );
      return res
        .status(500)
        .json({ error: 'Quiz generation returned invalid questions' });
    }

    const { data: insertedQuestions, error: insertedQuestionsError } =
      await supabase
        .from('quiz_question')
        .insert(filteredQuestionRows)
        .select(
          'id, display_id, concept_id, target_level, misconception_target, question, options, explanation, correct_answer',
        );

    if (insertedQuestionsError) {
      console.error(
        '[ADAPTIVE QUIZ] Failed to persist quiz questions:',
        insertedQuestionsError,
      );
      return res
        .status(500)
        .json({ error: 'Failed to persist quiz questions' });
    }

    const responseQuestions = (insertedQuestions || [])
      .sort((a, b) => (a.display_id || 0) - (b.display_id || 0))
      .map((q) => ({
        backendQuestionId: q.id,
        displayId: q.display_id,
        correctAnswer: q.correct_answer,
        explanation: q.explanation,
        question: q.question,
        options: q.options,
      }));

    return res.json({
      quizId: quizSession.id,
      createdAt: quizSession.created_at,
      questions: responseQuestions,
      totalTracked: proficiencyStates.length,
      selectedConcepts: conceptDescriptors,
    });
  } catch (error) {
    console.error('[ADAPTIVE QUIZ] Error:', error);
    return res.status(500).json({ error: 'Failed to generate adaptive quiz' });
  }
};

/**
 * Submit answers for a quiz session and update user proficiency states.
 * POST /api/kathakali/quiz/:quizId/submit
 * Body: { answers: Array<{question_id: string, selectedAnswer: string}> }
 */
exports.submitQuiz = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;
    const { quizId } = req.params;
    const { answers } = req.body;

    console.log('[QUIZ SUBMIT] Incoming submission');
    console.log(
      '[QUIZ SUBMIT] answers length:',
      Array.isArray(answers) ? answers.length : null,
    );

    if (!quizId) {
      console.warn('[QUIZ SUBMIT] Validation failed: quizId missing');
      return res.status(400).json({ error: 'quizId is required' });
    }

    if (!Array.isArray(answers) || answers.length === 0) {
      console.warn(
        '[QUIZ SUBMIT] Validation failed: answers array is required. Received:',
        {
          answersIsArray: Array.isArray(answers),
          answersLength: Array.isArray(answers) ? answers.length : null,
          bodyKeys:
            req.body && typeof req.body === 'object'
              ? Object.keys(req.body)
              : null,
        },
      );
      return res.status(400).json({ error: 'answers array is required' });
    }

    const { data: session, error: sessionError } = await supabase
      .from('quiz_session')
      .select('id, user_id, submitted_at')
      .eq('id', quizId)
      .single();

    if (sessionError) {
      console.error(
        '[QUIZ SUBMIT] Failed to fetch quiz_session:',
        sessionError,
      );
    }

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Quiz session not found' });
    }

    if (String(session.user_id) !== String(userId)) {
      console.warn('[QUIZ SUBMIT] Forbidden: quiz belongs to different user');
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Fetch questions for grading
    const getAnswerQuestionId = (answer) => answer?.backendQuestionId;
    const getSelectedAnswer = (answer) => answer?.answer;

    const questionIds = answers
      .map((a) => getAnswerQuestionId(a))
      .filter((id) => Boolean(id));

    console.log('[QUIZ SUBMIT] Parsed questionIds:', questionIds);

    const { data: questions, error: questionsError } = await supabase
      .from('quiz_question')
      .select(
        'id, concept_id, target_level, misconception_target, question, options, correct_answer, explanation',
      )
      .eq('quiz_id', quizId)
      .in('id', questionIds);

    if (questionsError) {
      console.error(
        '[QUIZ SUBMIT] Failed to fetch quiz questions:',
        questionsError,
      );
      return res.status(500).json({ error: 'Failed to fetch quiz questions' });
    }

    console.log(
      '[QUIZ SUBMIT] Loaded questions count:',
      Array.isArray(questions) ? questions.length : 0,
    );

    const questionById = new Map((questions || []).map((q) => [q.id, q]));

    const results = answers
      .map((a) => {
        const questionId = a.backendQuestionId;
        const q = questionById.get(questionId);
        if (!q) return null;

        const selectedAnswer = String(getSelectedAnswer(a) || '');
        const correctAnswer = String(q.correct_answer || '');
        const isCorrect = selectedAnswer === correctAnswer;

        return {
          question_id: q.id,
          concept_id: q.concept_id,
          target_level: q.target_level,
          misconception_target: Boolean(q.misconception_target),
          selectedAnswer,
          correctAnswer,
          isCorrect,
          question: q.question,
          explanation: q.explanation,
        };
      })
      .filter((r) => r);

    console.log('[QUIZ SUBMIT] Graded results count:', results.length);

    if (results.length === 0) {
      console.warn(
        '[QUIZ SUBMIT] No valid answers matched quiz questions. Diagnostics:',
        {
          submittedQuestionIds: questionIds,
          loadedQuestionIds: Array.from(questionById.keys()),
        },
      );
      return res
        .status(400)
        .json({ error: 'No valid answers matched quiz questions' });
    }

    // Build proficiency updates (single-shot, sticky-progress)
    const { data: existingStates, error: statesError } = await supabase
      .from('user_proficiency_state')
      .select('node_id, bloom_level, misconception_flag')
      .eq('user_id', userId)
      .in('node_id', Array.from(new Set(results.map((r) => r.concept_id))));

    if (statesError) {
      console.error(
        '[QUIZ SUBMIT] Failed to fetch proficiency states:',
        statesError,
      );
      return res
        .status(500)
        .json({ error: 'Failed to fetch proficiency states' });
    }

    console.log(
      '[QUIZ SUBMIT] Loaded existing proficiency states count:',
      Array.isArray(existingStates) ? existingStates.length : 0,
    );

    const stateByConcept = new Map(
      (existingStates || []).map((s) => [s.node_id, s]),
    );

    const updatesByConcept = new Map();

    results.forEach((r) => {
      const existing = stateByConcept.get(r.concept_id);
      const currentLevel = bloomToNumber(existing?.bloom_level || '0_unseen');
      const targetLevel = bloomToNumber(r.target_level);

      const desiredLevel = r.isCorrect
        ? Math.max(currentLevel, targetLevel)
        : currentLevel;

      // Misconception logic: only mutate on misconception-target questions
      let desiredMisconception;
      if (r.misconception_target) {
        desiredMisconception = !r.isCorrect;
      }

      const prev = updatesByConcept.get(r.concept_id);
      const prevLevel = prev ? bloomToNumber(prev.newLevel) : currentLevel;
      const mergedLevel = Math.max(prevLevel, desiredLevel);

      const mergedMisconception =
        desiredMisconception === undefined
          ? prev?.misconceptionFlag
          : desiredMisconception;

      const evidence = `Quiz(${quizId}) Q: ${r.question}\nSelected: ${r.selectedAnswer}\nCorrect: ${r.correctAnswer}\nResult: ${r.isCorrect ? 'correct' : 'incorrect'}`;

      updatesByConcept.set(r.concept_id, {
        conceptId: r.concept_id,
        newLevel: numberToBloom(mergedLevel),
        misconceptionFlag: mergedMisconception,
        evidence,
        reasoning: r.isCorrect
          ? `Correct answer on quiz question targeting ${r.target_level}`
          : `Incorrect answer on quiz question targeting ${r.target_level}`,
        confidence: (() => {
          if (r.isCorrect) return 0.9;
          if (r.misconception_target) return 0.7;
          return 0.65;
        })(),
      });
    });

    const updates = Array.from(updatesByConcept.values());

    console.log('[QUIZ SUBMIT] Computed proficiency updates:', updates.length);
    if (updates.length > 0) {
      console.log(
        '[QUIZ SUBMIT] Updates sample (first 2):',
        updates.slice(0, 2).map((u) => ({
          conceptId: u.conceptId,
          newLevel: u.newLevel,
          misconceptionFlag: u.misconceptionFlag,
          confidence: u.confidence,
        })),
      );
    }

    // Apply updates concept-by-concept (allows clearing misconceptions)
    const updatedConcepts = [];
    await Promise.all(
      updates.map(async (u) => {
        const { data: existingState } = await supabase
          .from('user_proficiency_state')
          .select('bloom_level, misconception_flag')
          .eq('user_id', userId)
          .eq('node_id', u.conceptId)
          .single();

        const currentLevel = bloomToNumber(
          existingState?.bloom_level || '0_unseen',
        );
        const newLevel = bloomToNumber(u.newLevel);

        // Sticky progress: do not downgrade bloom level
        const effectiveLevel = Math.max(currentLevel, newLevel);
        const currentMisconception = Boolean(existingState?.misconception_flag);
        const desiredMisconception =
          typeof u.misconceptionFlag === 'boolean'
            ? u.misconceptionFlag
            : currentMisconception;

        const shouldUpdate =
          !existingState ||
          effectiveLevel > currentLevel ||
          desiredMisconception !== currentMisconception;

        if (!shouldUpdate) {
          console.log('[QUIZ SUBMIT] No-op update (skipped):', {
            conceptId: u.conceptId,
            currentLevel: numberToBloom(currentLevel),
            proposedLevel: numberToBloom(effectiveLevel),
            currentMisconception,
            desiredMisconception,
          });
          return;
        }

        const { error: upsertError } = await supabase
          .from('user_proficiency_state')
          .upsert(
            {
              user_id: userId,
              node_id: u.conceptId,
              bloom_level: numberToBloom(effectiveLevel),
              misconception_flag: desiredMisconception,
              last_evidence: u.evidence,
              last_reasoning: u.reasoning,
              last_confidence: u.confidence,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,node_id' },
          );

        if (upsertError) {
          console.error(
            '[QUIZ SUBMIT] Upsert failed for concept:',
            u.conceptId,
            upsertError,
          );
          throw upsertError;
        }

        console.log('[QUIZ SUBMIT] Upserted proficiency state:', {
          conceptId: u.conceptId,
          bloom_level: numberToBloom(effectiveLevel),
          misconception_flag: desiredMisconception,
        });

        // Track for neighbor unlocking
        updatedConcepts.push({
          conceptId: u.conceptId,
          newLevel: numberToBloom(effectiveLevel),
          newLevelNumber: effectiveLevel,
        });
      }),
    );

    // Check for neighbor unlocking
    const proficiencyService = new ProficiencyAssessmentService();
    await proficiencyService.checkAndUnlockNeighbors(userId, updatedConcepts);

    // Mark quiz as submitted
    const { error: markSubmittedError } = await supabase
      .from('quiz_session')
      .update({ submitted_at: new Date().toISOString() })
      .eq('id', quizId)
      .eq('user_id', userId);

    if (markSubmittedError) {
      console.error(
        '[QUIZ SUBMIT] Failed to mark quiz_session submitted:',
        markSubmittedError,
      );
    } else {
      console.log('[QUIZ SUBMIT] Marked quiz_session submitted');
    }

    const correctCount = results.filter((r) => r.isCorrect).length;
    return res.status(200).json({
      quizId: quizId,
      total: results.length,
      correct: correctCount,
      score: results.length ? correctCount / results.length : 0,
      results,
      proficiencyUpdatesApplied: updates.map((u) => ({
        conceptId: u.conceptId,
        newLevel: u.newLevel,
        misconceptionFlag: u.misconceptionFlag,
      })),
    });
  } catch (error) {
    console.error('[QUIZ SUBMIT] Error:', error);
    if (error && error.stack) {
      console.error('[QUIZ SUBMIT] Stack:', error.stack);
    }
    return res.status(500).json({ error: 'Failed to submit quiz' });
  }
};

/**
 * Seed user proficiency states with all curriculum concepts
 * POST /api/kathakali/seed-proficiency
 * Initializes all concepts as '0_unseen' for new users
 */
exports.seedUserProficiency = async (req, res) => {
  try {
    const { user } = req;
    const userId = user.id;

    console.log(`[SEED PROFICIENCY] Seeding proficiency for user: ${userId}`);

    const allConcepts = curriculumService.getAllConcepts();
    const conceptIds = Object.keys(allConcepts);

    if (conceptIds.length === 0) {
      return res.status(500).json({ error: 'No concepts found in curriculum' });
    }

    // Prepare proficiency states for all concepts
    const proficiencyStates = conceptIds.map((conceptId) => ({
      user_id: userId,
      node_id: conceptId,
      bloom_level: '0_unseen',
      misconception_flag: false,
      last_evidence: 'Initial seeding on account creation',
      last_reasoning:
        'User account created, initializing all concepts as unseen',
      last_confidence: 0.0,
      updated_at: new Date().toISOString(),
    }));

    // Upsert to handle existing states (though unlikely for new users)
    const { error } = await supabase
      .from('user_proficiency_state')
      .upsert(proficiencyStates, { onConflict: 'user_id,node_id' });

    if (error) {
      console.error('[SEED PROFICIENCY] Supabase error:', error);
      return res
        .status(500)
        .json({ error: 'Failed to seed proficiency states' });
    }

    console.log(
      `[SEED PROFICIENCY] Successfully seeded ${conceptIds.length} concepts for user ${userId}`,
    );

    return res.status(200).json({
      message: `Seeded proficiency for ${conceptIds.length} concepts`,
      conceptsSeeded: conceptIds.length,
    });
  } catch (error) {
    console.error('[SEED PROFICIENCY] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
