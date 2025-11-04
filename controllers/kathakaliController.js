/* eslint-disable node/no-unsupported-features/es-syntax */
const axios = require('axios');
const FormData = require('form-data');
const huggingFaceClient = require('../client/huggingfaceClient');
const supabase = require('../client/supabaseClient');
const apiConfig = require('../apiconfig/apiConfig');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');
const eventRouterService = require('../services/eventRouterService');
const embeddingService = require('../services/embeddingService');

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

exports.chat = async (req, res) => {
  try {
    const { query, imageAnalysis, characterData, expressionData } =
      req.body || {};

    if (!query) {
      console.log('Query missing, returning 400');
      return res.status(400).json({ error: 'Query is required' });
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

    const chatCompletion = await client.chatCompletion({
      provider: 'together',
      model: 'openai/gpt-oss-120b',
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
