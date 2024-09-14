/* eslint-disable node/no-unsupported-features/es-syntax */
const axios = require('axios');
const FormData = require('form-data');
const apiConfig = require('../apiconfig/apiConfig');

exports.classifyExpression = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!req.file.mimetype.startsWith('image')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Create a FormData object
    const faceForm = new FormData();
    faceForm.append('image', req.file.buffer, {
      filename: req.file.originalname,
    });

    // Make a POST request to the microservice
    const faceDetectResponse = await axios.post(
      apiConfig.facialDetectionApi,
      faceForm,
    );

    if (faceDetectResponse.data.error) {
      return res.status(400).json({ error: faceDetectResponse.data.error });
    }

    const { faces, locations } = faceDetectResponse.data;
    if (faces.length === 0) {
      return res.status(400).json({ error: 'No faces detected' });
    }

    const responses = await Promise.all(
      faces.map(async (face, i) => {
        try {
          // Decode Base64-encoded face to binary buffer
          const imageBuffer = Buffer.from(face, 'base64');

          // Create a new FormData object for each face
          const formData = new FormData();
          formData.append('image', imageBuffer, {
            filename: 'face.jpg', // You can set a different filename if needed
            contentType: 'image/jpeg', // Set the correct MIME type for the image
          });

          // Send the face image to the microservice
          const microserviceResponse = await axios.post(
            apiConfig.expressionDetectionApi,
            formData,
            {
              headers: {
                ...formData.getHeaders(),
              },
            },
          );

          // Return the response data
          return { ...microserviceResponse.data, location: locations[i] };
        } catch (error) {
          console.error('Error sending face to microservice:', error);
          // Return an error message for this face
          return { error: 'Failed to classify face' };
        }
      }),
    );

    // Return all the responses as a single JSON array
    return res.status(200).json(responses);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.classifyCharacter = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!req.file.mimetype.startsWith('image')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Create a FormData object
    const faceForm = new FormData();
    faceForm.append('image', req.file.buffer, {
      filename: req.file.originalname,
    });

    // Make a POST request to the microservice
    const faceDetectResponse = await axios.post(
      apiConfig.facialDetectionApi,
      faceForm,
    );

    if (faceDetectResponse.data.error) {
      return res.status(400).json({ error: faceDetectResponse.data.error });
    }

    const { faces, locations } = faceDetectResponse.data;
    if (faces.length === 0) {
      return res.status(400).json({ error: 'No faces detected' });
    }

    const responses = await Promise.all(
      faces.map(async (face, i) => {
        try {
          // Decode Base64-encoded face to binary buffer
          const imageBuffer = Buffer.from(face, 'base64');

          // Create a new FormData object for each face
          const formData = new FormData();
          formData.append('image', imageBuffer, {
            filename: 'face.jpg', // You can set a different filename if needed
            contentType: 'image/jpeg', // Set the correct MIME type for the image
          });

          // Send the face image to the microservice
          const microserviceResponse = await axios.post(
            apiConfig.kathakaliCharacterClassificationApi,
            formData,
            {
              headers: {
                ...formData.getHeaders(),
              },
            },
          );

          // Return the response data
          return { ...microserviceResponse.data, location: locations[i] };
        } catch (error) {
          console.error('Error sending face to microservice:', error);
          // Return an error message for this face
          return { error: 'Failed to classify face' };
        }
      }),
    );

    // Return all the responses as a single JSON array
    return res.status(200).json(responses);
  } catch (error) {
    console.log('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
