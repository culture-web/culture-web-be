const express = require('express');

const router = express.Router();
const authController = require('../controllers/authController');
const { verifyAdminToken } = require('../middleware/authMiddleware');

// Login endpoint (public)
router.post('/login', authController.login);

// Verify token endpoint (protected)
router.get('/verify', verifyAdminToken, authController.verify);

module.exports = router;
