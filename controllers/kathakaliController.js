const axios = require('axios');
const FormData = require('form-data');
const apiConfig = require('../apiconfig/apiConfig');

exports.classifyCharacter = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!req.file.mimetype.startsWith('image')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Create a FormData object
    const formData = new FormData();
    formData.append('image', req.file.buffer, {
      filename: req.file.originalname,
    });

    // Make a POST request to the microservice
    const microserviceResponse = await axios.post(
      apiConfig.kathakaliCharacterClassificationApi,
      formData,
    );
    return res.status(200).json(microserviceResponse.data);
  } catch (error) {
    console.error('Error uploading image to microservice:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
