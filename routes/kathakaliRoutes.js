const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/authMiddleware');
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

// Define a separate route to classify only expressions
router.post(
  '/classify-expression',
  multerUploadErrorMiddleware,
  kathakaliController.classifyExpression, // Classify only expressions
);

router.post('/chat', multerUploadErrorMiddleware, kathakaliController.chat);

router.post(
  '/chat-mudras',
  multerUploadErrorMiddleware,
  kathakaliController.chatMudras,
);

router.get(
  '/source-download/:fileName',
  kathakaliController.downloadMudrasSource,
);

router.post(
  '/generate-quiz-from-chat',
  kathakaliController.generateQuizFromChat,
);

router.get(
  '/generate-adaptive-quiz',
  authenticateToken,
  kathakaliController.generateAdaptiveQuiz,
);

router.post(
  '/quiz/:quizId/submit',
  authenticateToken,
  kathakaliController.submitQuiz,
);

module.exports = router;
