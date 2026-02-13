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

// POST /api/chat/sessions - Create new session
router.post('/sessions', authenticateToken, chatController.addSession);

// GET /api/chat/sessions/:sessionId - Get messages for a session (requires auth)
router.get(
  '/sessions/:sessionId',
  authenticateToken,
  chatController.getMessagesByChatSessionId,
);

// GET /api/chat/sessions - Get all sessions for a user
router.get(
  '/sessions',
  authenticateToken,
  chatController.getChatSessionsByUserId,
);

router.delete(
  '/messages/:messageId',
  authenticateToken,
  chatController.deleteMessage,
);

// DELETE /api/chat/sessions/:sessionId - Delete session history (requires auth)
router.delete(
  '/sessions/:sessionId',
  authenticateToken,
  chatController.deleteSessionHistory,
);

// DELETE /api/chat/ - Delete all user history (requires auth) - DESTRUCTIVE
router.delete('/', authenticateToken, chatController.deleteUserHistory);

// GET /api/chat/stats - Get conversation statistics (requires auth)
router.get('/stats', authenticateToken, chatController.getConversationStats);

module.exports = router;
