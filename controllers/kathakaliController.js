/* eslint-disable node/no-unsupported-features/es-syntax */
const axios = require('axios');
const FormData = require('form-data');
const huggingFaceClient = require('../client/huggingfaceClient');
const groqClient = require('../client/groqClient');
const supabase = require('../client/supabaseClient');
const localDb = require('../client/localDbClient');
const apiConfig = require('../apiconfig/apiConfig');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');
const eventRouterService = require('../services/eventRouterService');
const embeddingService = require('../services/embeddingService');
const storageService = require('../services/minioStorageService');

const validateObjectName = (name) => {
  if (!name || name.includes('..') || name.startsWith('/')) {
    throw new Error('Invalid file path');
  }
  return name;
};

const clampNumber = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const parseBoolean = (value, fallback = true) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
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
    const chatCompletion = await client.chatCompletion({
      provider,
      model,
      messages: messages,
    });

    const responseMessage = chatCompletion.choices[0].message.content;

    const chatbotResponse = preprocessChatResponse(responseMessage);

    return res.status(200).json(chatbotResponse);
  } catch (error) {
    console.log('Error in chat:', error);

    if (error.message && error.message.includes('token')) {
      return res
        .status(401)
        .json({ error: 'Invalid or missing Hugging Face token' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.chatMudras = async (req, res) => {
  try {
    const {
      message,
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

    const chatCompletion = await client.chat.completions.create({
      model,
      messages,
      max_tokens: 2000,
      temperature: 0.7,
    });

    const responseMessage = chatCompletion.choices[0].message.content;

    console.log('=== LLM Response Info ===');
    console.log(`Response Length: ${responseMessage.length} chars`);
    console.log(`Response Preview: ${responseMessage.substring(0, 200)}...`);
    console.log(`Full Response:\n${responseMessage}`);
    console.log('========================\n');

    const chatbotResponse = preprocessChatResponse(responseMessage);

    // Add citations to response
    chatbotResponse.citations = citations;
    chatbotResponse.retrieval = retrievalDebug;

    return res.status(200).json(chatbotResponse);
  } catch (error) {
    console.log('Error in chatMudras:', error);

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
      return res.status(500).json({ error: 'Failed to fetch proficiency data' });
    }

    if (!proficiencyStates || proficiencyStates.length === 0) {
      return res.status(404).json({
        error: 'No proficiency data found. Chat more to build your knowledge profile!'
      });
    }

    console.log(`[ADAPTIVE QUIZ] Found ${proficiencyStates.length} tracked concepts`);

    // Randomly pick up to 5 concepts from ALL tracked concepts
    const shuffled = proficiencyStates.sort(() => Math.random() - 0.5);
    const selectedConcepts = shuffled.slice(0, 5);

    console.log(`[ADAPTIVE QUIZ] Selected ${selectedConcepts.length} random concepts:`,
      selectedConcepts.map(g => `${g.node_id}(${g.bloom_level})`));

    // Build descriptors to send to AI
    const conceptDescriptors = selectedConcepts.map(state => ({
      concept: state.node_id,
      bloom_level: state.bloom_level,
      misconception: state.misconception_flag,
      evidence: state.last_evidence || null,
    }));

    // Generate exactly 5 questions using GROQ
    const client = groqClient.getInstance();
    const targetCount = 5;

    const prompt = `You are a Kathakali teacher. A student has the following knowledge profile. Generate exactly ${targetCount} multiple-choice questions.

STUDENT'S KNOWLEDGE PROFILE:
${JSON.stringify(conceptDescriptors, null, 2)}

RULES:
- There are ${selectedConcepts.length} concept(s). If less than ${targetCount}, generate multiple questions per concept to reach exactly ${targetCount} total.
- When generating multiple questions for the same concept, each question must ask about a DIFFERENT aspect of that concept.
- Match question difficulty strictly to bloom_level:
    "0_unseen"    → Easy. Simple definition or identification. Example: "What is X?"
    "1_remember"  → Easy-Medium. Basic recall. Example: "What does X represent?"
    "2_understand"→ Medium. Explanation. Example: "Why does X have Y characteristic?"
    "3_apply"     → Medium-Hard. Scenario-based. Example: "In this situation, which would...?"
    "4_analyze"   → Hard. Critical analysis or comparison. Example: "What is the key difference between X and Y, and why does it matter?"
- If misconception = true: Write a question that directly corrects the misunderstanding shown in evidence.
- Provide exactly 4 options per question.

Return ONLY a valid JSON array, no extra text:
[{"id":1,"question":"...","options":["Pacha","Kathi","Minukku","Kari"],"correctAnswer":"Pacha","explanation":"..."}]`;

    const response = await client.chat.completions.create({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: 'You are a Kathakali quiz generator. Output only valid JSON arrays. No markdown, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    });

    let quizData = response.choices[0].message.content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    let questions;
    try {
      questions = JSON.parse(quizData);
    } catch (parseError) {
      console.error('[ADAPTIVE QUIZ] Failed to parse AI response:', quizData);
      return res.status(500).json({ error: 'Failed to parse quiz from AI response' });
    }

    console.log(`[ADAPTIVE QUIZ] Generated ${questions.length} questions from ${selectedConcepts.length} concepts`);

    res.json({
      questions,
      total_tracked: proficiencyStates.length,
      selected_concepts: conceptDescriptors,
    });

  } catch (error) {
    console.error('[ADAPTIVE QUIZ] Error:', error);
    res.status(500).json({ error: 'Failed to generate adaptive quiz' });
  }
};
