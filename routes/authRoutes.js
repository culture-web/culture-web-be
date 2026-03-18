const express = require('express');

const router = express.Router();
const authController = require('../controllers/authController');
const {
  verifyAdminToken,
  authenticateToken,
} = require('../middleware/authMiddleware');

// Login endpoint (public)
router.post('/login', authController.login);

// Supabase session -> KB token exchange (Supabase authenticated)
router.post('/supabase-kb-login', authenticateToken, authController.supabaseKbLogin);

// Verify token endpoint (protected)
router.get('/verify', verifyAdminToken, authController.verify);

// Change own KB password (protected)
router.post(
  '/change-password',
  verifyAdminToken,
  authController.changePassword,
);

module.exports = router;
