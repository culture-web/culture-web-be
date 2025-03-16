const axios = require('axios');
// uploadDataController.js
const AWS = require('aws-sdk');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

// AWS S3 Configuration
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// PostgreSQL Configuration
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST, // RDS endpoint
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Function to generate a unique file name
const generateFileName = (originalName, predicted, actual) => {
  const ext = path.extname(originalName);
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  return `${Date.now()}-${uniqueSuffix}-predicted-${predicted}-actual-${actual}${ext}`;
};

exports.uploadTrainingData = async (req, res) => {
  // Allow all origins temporarily
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  // Retrieve the predicted and actual strings from the request body
  const { predicted, actual } = req.body;
  const { type } = req.body;

  const fileName = generateFileName(req.file.originalname, predicted, actual);

  // Define parameters for the S3 upload
  const params = {
    Bucket: `kathakalai/${type}`, // Replace with your actual bucket and folder path
    Key: fileName,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
    ACL: 'public-read',
  };

  try {
    // Upload image to S3
    const data = await s3.upload(params).promise();
    const imageUrl = data.Location; // URL of the uploaded image

    // Send a message to Telegram channel
    const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const capitalizedType = type.charAt(0).toUpperCase() + type.slice(1);
    const telegramMessage = `New Upload For Training Data for ${capitalizedType}:\nImage URL: ${imageUrl}\nPredicted by Model: ${predicted}\nActual: ${actual}`;

    await axios.post(telegramUrl, {
      chat_id: TELEGRAM_CHAT_ID,
      text: telegramMessage,
    });

    // Prepare data for database insertion
    // Replace with req.body values if needed (e.g., const { text1, text2 } = req.body)
    const query = `INSERT INTO "character_images" (image_url, predicted, actual) VALUES ($1, $2, $3)`;
    const values = [imageUrl, predicted, actual];

    // Insert record into PostgreSQL
    await pool.query(query, values);

    return res.status(200).send({
      imageUrl,
      message: 'Image uploaded and data inserted into DB!',
    });
  } catch (error) {
    console.error('Error uploading image to S3:', error);
    return res
      .status(500)
      .send('Error uploading image to S3 or inserting data into database.');
  }
};

// Test the connection to the database
// const testConnection = async () => {
//   try {
//     const res = await pool.query('SELECT NOW()'); // Simple query to test connection
//     console.log('Connection successful:', res.rows[0]); // Should print current timestamp
//   } catch (err) {
//     console.error('Error connecting to database:', err); // Log any error
//   }
// };

// // Run the connection test
// testConnection();
