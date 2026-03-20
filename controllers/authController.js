/**
 * Authentication Controller
 * Handles token verification and Supabase bridge auth
 */
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { JWT_SECRET } = require('../middleware/authMiddleware');
const supabaseAdminClient = require('../client/supabaseClient');
const { normalizeRole } = require('../services/kbUserService');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
const supabaseAuthClient =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

/**
 * Admin login endpoint
 * POST /api/auth/login
 * Body: { username, password } or { email, password }
 */
exports.login = async (req, res) =>
  res.status(410).json({
    error: 'Deprecated',
    message:
      'Legacy KB login is disabled. Please sign in with Supabase at /sign-in.',
  });

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

    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        error: 'currentPassword and newPassword (>=6 chars) are required',
      });
    }

    if (String(req.user?.source || '').toLowerCase() === 'supabase') {
      if (!supabaseAuthClient) {
        return res.status(500).json({
          error: 'Missing Supabase configuration for password change',
        });
      }

      const email = String(req.user?.email || '')
        .trim()
        .toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'User email is required' });
      }

      const { error: verifyError } =
        await supabaseAuthClient.auth.signInWithPassword({
          email,
          password: String(currentPassword),
        });

      if (verifyError) {
        return res.status(400).json({
          error: 'Password change failed',
          message: 'Current password is invalid',
        });
      }

      const { error: updateError } =
        await supabaseAdminClient.auth.admin.updateUserById(
          String(req.user.id),
          {
            password: String(newPassword),
          },
        );

      if (updateError) {
        return res.status(500).json({
          error: updateError.message || 'Failed to update password',
        });
      }

      return res
        .status(200)
        .json({ success: true, message: 'Password updated' });
    }

    return res.status(410).json({
      error: 'Deprecated',
      message:
        'Legacy KB password change is disabled. Use Supabase login users.',
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || 'Failed to change password' });
  }
};

/**
 * Exchange Supabase-authenticated user for KB token
 * POST /api/auth/supabase-kb-login
 * Headers: Authorization: Bearer <supabase_access_token>
 */
exports.supabaseKbLogin = async (req, res) => {
  try {
    const roleCandidate =
      req.user?.app_metadata?.kb_role ||
      req.user?.app_metadata?.role ||
      req.user?.user_metadata?.kb_role ||
      req.user?.user_metadata?.role;

    const kbRole = normalizeRole(roleCandidate);
    if (!kbRole) {
      return res.status(403).json({
        error: 'Forbidden',
        message:
          'This account does not have KB access. Ask an admin to set app_metadata.role to admin/editor/viewer.',
      });
    }

    const userId = String(req.user?.id || '').trim();
    const email = String(req.user?.email || '')
      .trim()
      .toLowerCase();
    const username = email
      ? email.split('@')[0]
      : `supabase-${userId.slice(0, 8) || 'user'}`;

    const token = jwt.sign(
      {
        id: userId,
        username,
        email,
        role: kbRole,
        source: 'supabase',
      },
      JWT_SECRET,
      {
        expiresIn: '24h',
      },
    );

    return res.json({
      success: true,
      token,
      expiresIn: '24h',
      user: {
        id: userId,
        username,
        email,
        role: kbRole,
        source: 'supabase',
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message || 'Failed to establish KB access',
    });
  }
};
