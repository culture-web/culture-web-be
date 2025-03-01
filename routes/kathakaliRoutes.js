const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const make = require('../middleware/makeMulterMiddleware');
// Multer setup for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const router = express.Router();

console.log(process.env)
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
  ssl: false,
});

// Function to generate a unique file name
const generateFileName = (originalName) => {
  const ext = path.extname(originalName);
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  return `${Date.now()}-${uniqueSuffix}${ext}`;
};

const kathakaliController = require('../controllers/kathakaliController');

const multerUploadErrorMiddleware = make(upload.single('image'));

// Export function to upload training data and store it in the database
router.post(
  '/upload-training-data',
  multerUploadErrorMiddleware,
  async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Temporarily allow all origins

    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const fileName = generateFileName(req.file.originalname);

    // Upload to S3
    const params = {
      Bucket: 'kathakalai/character', // Replace with your actual bucket and folder path
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    try {
      // Upload image to S3
      const data = await s3.upload(params).promise();
      const imageUrl = data.Location; // The URL of the uploaded image on S3

      // Prepare the data to insert into the database
      const text1 = 'yo';
      const text2 = 'yo';
      // const { text1, text2 } = req.body; // Assume these are passed as form data
      const query = `INSERT INTO "character_images" (image_url, predicted, actual) VALUES ($1, $2, $3)`;
      const values = [imageUrl, text1, text2];

      // Insert into PostgreSQL database
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
  },
);

router.post(
  '/',
  multerUploadErrorMiddleware,
  kathakaliController.classifyCharacter,
);

// Define a separate route to classify only expressions
router.post(
  '/classify-expression',
  multerUploadErrorMiddleware,
  kathakaliController.classifyExpression, // Classify only expressions
);

module.exports = router;
