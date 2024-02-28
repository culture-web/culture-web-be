const express = require('express');
const multer = require('multer');
const make = require('../middleware/makeMulterMiddleware');
// Multer setup for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const router = express.Router();
const kathakaliController = require('../controllers/kathakaliController');

const multerUploadErrorMiddleware = make(upload.single('image'));

router.post(
  '/',
  multerUploadErrorMiddleware,
  kathakaliController.classifyCharacter,
);

module.exports = router;
