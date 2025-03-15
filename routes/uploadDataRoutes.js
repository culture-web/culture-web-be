// uploadDataRoutes.js
const express = require('express');
const multer = require('multer');
const make = require('../middleware/makeMulterMiddleware');
const uploadDataController = require('../controllers/uploadDataController');

const router = express.Router();

// Multer setup for handling file uploads (using memory storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const multerUploadErrorMiddleware = make(upload.single('image'));

// Define the route that handles file upload and calls the controller logic
router.post(
  '/upload-training-data',
  multerUploadErrorMiddleware,
  uploadDataController.uploadTrainingData,
);

module.exports = router;
