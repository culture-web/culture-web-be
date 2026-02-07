/**
 * Authentication Controller
 * Handles admin login and token generation
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/authMiddleware');

// Admin credentials from environment variables
const KB_USERNAME = process.env.KB_USERNAME || 'admin';
const KB_PASSWORD = process.env.KB_PASSWORD || 'kathakalai2026'; // Change in production!

/**
 * Admin login endpoint
 * POST /api/auth/login
 * Body: { username, password }
 */
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate credentials
    if (username !== KB_USERNAME || password !== KB_PASSWORD) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect'
      });
    }

    // Generate JWT token (expires in 24 hours)
    const token = jwt.sign(
      { username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token,
      expiresIn: '24h',
      user: { username, role: 'admin' }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: error.message
    });
  }
};

/**
 * Verify token endpoint
 * GET /api/auth/verify
 * Headers: Authorization: Bearer <token>
 */
exports.verify = async (req, res) => {
  // If we reach here, the token is valid (middleware already verified it)
  res.json({
    success: true,
    user: req.user
  });
};
