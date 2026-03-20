const express = require('express');
const multer = require('multer');
const {
  authenticateToken,
  optionalAuth,
  verifyAdminToken,
  requireKbRoles,
} = require('../middleware/authMiddleware');
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
  optionalAuth,
  multerUploadErrorMiddleware,
  kathakaliController.chatMudras,
);

router.post(
  '/mudras/assets/upload',
  verifyAdminToken,
  requireKbRoles('admin'),
  multerUploadErrorMiddleware,
  kathakaliController.uploadMudraAsset,
);

router.get('/mudras/assets', optionalAuth, kathakaliController.listMudraAssets);

router.get(
  '/mudras/assets/:id/image',
  optionalAuth,
  kathakaliController.getMudraAssetImage,
);

router.patch(
  '/mudras/assets/:id/status',
  verifyAdminToken,
  requireKbRoles('admin'),
  express.json(),
  kathakaliController.updateMudraAssetStatus,
);

router.delete(
  '/mudras/assets/:id',
  verifyAdminToken,
  requireKbRoles('admin'),
  kathakaliController.deleteMudraAsset,
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

router.post(
  '/seed-proficiency',
  authenticateToken,
  kathakaliController.seedUserProficiency,
);

module.exports = router;
