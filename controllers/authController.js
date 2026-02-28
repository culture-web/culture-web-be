/**
 * Authentication Controller
 * Handles admin login and token generation
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/authMiddleware');
const {
  ensureDefaultAdmin,
  getKbUserByIdentifier,
  verifyPassword,
  changeOwnKbPassword,
} = require('../services/kbUserService');

/**
 * Admin login endpoint
 * POST /api/auth/login
 * Body: { username, password } or { email, password }
 */
exports.login = async (req, res) => {
  const { username, email, password } = req.body;
  const identifier = username || email;

  if (!identifier || !password) {
    return res.status(400).json({
      error: 'Missing credentials',
      message: 'username/email and password are required',
    });
  }

  await ensureDefaultAdmin();
  const user = await getKbUserByIdentifier(identifier);
  if (!user || !user.is_active) {
    return res.status(401).json({
      error: 'Invalid credentials',
      message: 'Username/email or password is incorrect',
    });
  }

  const passwordValid = verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return res.status(401).json({
      error: 'Invalid credentials',
      message: 'Username/email or password is incorrect',
    });
  }

  // Generate JWT token (expires in 24 hours)
  const token = jwt.sign({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  }, JWT_SECRET, {
    expiresIn: '24h',
  });

  return res.json({
    success: true,
    token,
    expiresIn: '24h',
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    },
  });
};

/**
 * Verify token endpoint
 * GET /api/auth/verify
 * Headers: Authorization: Bearer <token>
 */
exports.verify = (req, res) =>
  // If we reach here, the token is valid (middleware already verified it)
  res.json({
    success: true,
    user: req.user,
  });

/**
 * Change own password (requires valid KB token)
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const changed = await changeOwnKbPassword(req.user.id, currentPassword, newPassword);
    if (!changed) {
      return res.status(400).json({
        error: 'Password change failed',
        message: 'Current password is invalid',
      });
    }

    return res.status(200).json({ success: true, message: 'Password updated' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to change password' });
  }
};
