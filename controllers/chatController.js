const ChatService = require('../services/chatService');

const chatService = new ChatService();

// POST addMessage
// DELETE deleteSession
// GET getMessagesByChatSessionId
// GET getChatSessionsByUserId

/**
 * Add a message to conversation history
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const addMessage = async (req, res) => {
  try {
    console.log('🚀 [ChatController] addMessage - Starting request processing');

    // Get user from auth middleware (optional - may be undefined for unauthenticated users)
    const { user } = req;
    console.log('🔍 [ChatController] Raw user object:', user);
    const userId = user?.id || null; // Use null for unauthenticated users
    console.log(`👤 [ChatController] User ID: ${userId || 'UNAUTHENTICATED'}`);

    const {
      message,
      role,
      metadata,
      imageAnalysis,
      characterData,
      expressionData,
    } = req.body;
    if (!message || !role) {
      console.log('❌ [ChatController] Missing required fields');
      return res.status(400).json({
        error: 'Missing required fields: message, role',
      });
    }

    if (!['user', 'assistant'].includes(role)) {
      console.log(`❌ [ChatController] Invalid role: ${role}`);
      return res.status(400).json({
        error: 'Role must be either "user" or "assistant"',
      });
    }

    // if sessionId is not provided, generate a new one
    const sessionId =
      req.body.sessionId || (await chatService.createSession(userId)).id;
    console.log(`🔗 [ChatController] Session ID: ${sessionId}`);

    // Handle uploaded image file if present
    const imageFile =
      req.file ||
      (req.files && req.files.find((file) => file.fieldname === 'image'));
    console.log(`📁 [ChatController] Has image file: ${!!imageFile}`);

    // Merge additional AI chat metadata with existing metadata
    // eslint-disable-next-line prefer-object-spread
    const enhancedMetadata = Object.assign({}, metadata, {
      imageAnalysis,
      characterData,
      expressionData,
      imageFile,
    });
    console.log(
      `🔧 [ChatController] Enhanced metadata keys: ${Object.keys(enhancedMetadata)}`,
    );

    console.log(
      `🤖 [ChatController] Calling chatService.addMessage for role: ${role}`,
    );
    const result = await chatService.addMessage(
      userId,
      sessionId,
      message,
      role,
      enhancedMetadata,
    );

    console.log(
      `✅ [ChatController] ChatService returned result with keys: ${Object.keys(result)}`,
    );

    // If it was a user message and AI response was generated
    if (role === 'user' && result.generatedResponse) {
      console.log(
        '🎯 [ChatController] User message with AI response generated - returning both',
      );
      return res.status(201).json({
        success: true,
        data: {
          userMessage: result.userMessage,
          aiMessage: result.aiResponse,
          response: result.generatedResponse, // The actual AI response content
        },
      });
    }

    // If AI response failed but user message was stored
    if (role === 'user' && result.error) {
      console.log(`⚠️ [ChatController] AI response failed: ${result.error}`);
      return res.status(201).json({
        success: true,
        data: {
          userMessage: result.userMessage,
          aiMessage: null,
        },
        warning: result.error,
      });
    }

    // For assistant messages or when no AI response is generated
    console.log('📤 [ChatController] Returning standard message response');
    return res.status(201).json({
      success: true,
      data: result.userMessage || result,
    });
  } catch (error) {
    console.error('💥 [ChatController] Error adding message:', error);

    // Handle specific AI-related errors
    if (error.message && error.message.includes('token')) {
      console.log('🔑 [ChatController] Hugging Face token error detected');
      return res.status(401).json({
        error: 'Invalid or missing Hugging Face token',
        details: error.message,
      });
    }

    console.log('🚨 [ChatController] General server error');
    return res.status(500).json({
      error: 'Failed to add message',
      details: error.message,
    });
  }
};

/**
 * Get conversation history for a session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getMessagesByChatSessionId = async (req, res) => {
  try {
    // Get user from auth middleware
    const { user } = req;
    const userId = user.id;

    const { sessionId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
      });
    }

    const parsedLimit = parseInt(limit, 10);
    const parsedOffset = parseInt(offset, 10);

    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return res.status(400).json({
        error: 'Limit must be a number between 1 and 200',
      });
    }

    if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({
        error: 'Offset must be a non-negative number',
      });
    }

    const history = await chatService.getMessagesByChatSessionId(
      sessionId,
      userId,
      parsedLimit,
      parsedOffset,
    );

    return res.status(200).json({
      success: true,
      data: history,
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: history.length, // Note: This is not the total count, just the returned count
      },
    });
  } catch (error) {
    console.error('Error getting conversation history:', error);
    return res.status(500).json({
      error: 'Failed to get conversation history',
      details: error.message,
    });
  }
};

/**
 * Get recent conversation history for a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getChatSessionsByUserId = async (req, res) => {
  try {
    // Get user from auth middleware
    const { user } = req;
    const userId = user.id;

    const { limit = 100 } = req.query;

    const parsedLimit = parseInt(limit, 10);

    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
      return res.status(400).json({
        error: 'Limit must be a number between 1 and 500',
      });
    }

    const history = await chatService.getChatSessionsByUserId(
      userId,
      parsedLimit,
    );

    return res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error('Error getting user recent history:', error);
    return res.status(500).json({
      error: 'Failed to get user recent history',
      details: error.message,
    });
  }
};

/**
 * Delete conversation history for a session
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const deleteSessionHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
      });
    }

    await chatService.deleteSessionHistory(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Session history deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting session history:', error);
    return res.status(500).json({
      error: 'Failed to delete session history',
      details: error.message,
    });
  }
};

/**
 * Delete all conversation history for a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const deleteUserHistory = async (req, res) => {
  try {
    // Get user from auth middleware
    const { user } = req;
    const userId = user.id;

    await chatService.deleteUserHistory(userId);

    return res.status(200).json({
      success: true,
      message: 'User history deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting user history:', error);
    return res.status(500).json({
      error: 'Failed to delete user history',
      details: error.message,
    });
  }
};

/**
 * Get conversation statistics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getConversationStats = async (req, res) => {
  try {
    const { userId } = req.query; // Optional query param

    const stats = await chatService.getConversationStats(userId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error getting conversation stats:', error);
    return res.status(500).json({
      error: 'Failed to get conversation stats',
      details: error.message,
    });
  }
};

module.exports = {
  addMessage,
  getConversationHistory: getMessagesByChatSessionId,
  getUserRecentHistory: getChatSessionsByUserId,
  deleteSessionHistory,
  deleteUserHistory,
  getConversationStats,
};
