const express = require('express');
const multer = require('multer');
const make = require('../middleware/makeMulterMiddleware');
const {
  authenticateToken,
  optionalAuth,
} = require('../middleware/authMiddleware');

// Multer setup for handling file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const router = express.Router();

const chatController = require('../controllers/chatController');

const multerUploadErrorMiddleware = make(upload.single('image'));

// POST /api/chat/messages - Add a message (authentication optional)
router.post(
  '/messages',
  optionalAuth,
  multerUploadErrorMiddleware,
  chatController.addMessage,
);

// GET /api/chat/sessions/:sessionId - Get conversation history for a session (requires auth)
router.get(
  '/sessions/:sessionId',
  authenticateToken,
  chatController.getConversationHistory,
);

// GET /api/chat/users/recent - Get recent history for authenticated user
router.get(
  '/users/recent',
  authenticateToken,
  chatController.getUserRecentHistory,
);

// DELETE /api/chat/sessions/:sessionId - Delete session history (requires auth)
router.delete(
  '/sessions/:sessionId',
  authenticateToken,
  chatController.deleteSessionHistory,
);

// DELETE /api/chat/users - Delete all user history (requires auth)
router.delete('/users', authenticateToken, chatController.deleteUserHistory);

// GET /api/chat/stats - Get conversation statistics (requires auth)
router.get('/stats', authenticateToken, chatController.getConversationStats);

module.exports = router;
