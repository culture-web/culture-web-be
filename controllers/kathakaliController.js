/* eslint-disable node/no-unsupported-features/es-syntax */
const axios = require('axios');
const FormData = require('form-data');
const huggingFaceClient = require('../client/huggingfaceClient');
const apiConfig = require('../apiconfig/apiConfig');
const { preprocessChatResponse } = require('../utils/chatResponseProcessor');

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
    const { query, imageAnalysis, characterData, expressionData } = req.body || {};

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

    if (imageAnalysis) {
      messages.unshift({
        role: 'system',
        content: `Context from image analysis: ${imageAnalysis}`,
      });
    }

    // Handle uploaded image file if present
    const imageFile =
      req.file ||
      (req.files && req.files.find((file) => file.fieldname === 'image'));
    if (imageFile) {
      let imageContext = 'The user has uploaded an image for Kathakali analysis.';
      
      // Add character information if available
      if (characterData && characterData.length > 0) {
        const characters = characterData.map(data => data.character || data.predicted_class).filter(Boolean);
        if (characters.length > 0) {
          imageContext += ` The image contains the following Kathakali character(s): ${characters.join(', ')}.`;
        }
      }
      
      // Add expression information if available
      if (expressionData && expressionData.length > 0) {
        const expressions = expressionData.map(data => data.expression || data.predicted_class).filter(Boolean);
        if (expressions.length > 0) {
          imageContext += ` The detected expression(s) are: ${expressions.join(', ')}.`;
        }
      }
      
      imageContext += ' Please provide information about these Kathakali elements and respond to the user\'s query in the context of this classical Indian dance form.';
      
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
