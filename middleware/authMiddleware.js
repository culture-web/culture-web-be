const { URL } = require('url');
const jwt = require('jsonwebtoken');

// Use environment variable for secret, fallback for development
const JWT_SECRET =
  process.env.JWT_SECRET || 'kathakalai-secret-key-change-in-production';

// Supabase JWT Configuration
const { SUPABASE_JWT_ISSUER } = process.env;

// Initialize jose functions and JWKS lazily
let joseModule = null;
let SUPABASE_JWT_KEYS = null;

const initializeJose = async () => {
  if (!joseModule) {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax
    joseModule = await import('jose');
  }
  if (!SUPABASE_JWT_KEYS && SUPABASE_JWT_ISSUER) {
    SUPABASE_JWT_KEYS = joseModule.createRemoteJWKSet(
      new URL(`${SUPABASE_JWT_ISSUER}/.well-known/jwks.json`),
    );
  }
  return joseModule;
};

// JWT verification function using jose library
const verifyToken = async (token) => {
  const jose = await initializeJose();
  const { payload } = await jose.jwtVerify(token, SUPABASE_JWT_KEYS, {
    issuer: SUPABASE_JWT_ISSUER,
    audience: 'authenticated',
  });
  return payload;
};

/**
 * Middleware to verify Supabase JWT tokens using jose library
 * Used for protecting endpoints that require user authentication
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!token) {
      return res.status(401).json({
        error: 'Access token required',
      });
    }

    // Verify JWT using jose library
    const payload = await verifyToken(token);

    // Extract user information from JWT payload
    const user = {
      id: payload.sub, // User UUID from 'sub' claim
      email: payload.email,
      role: payload.role,
      aud: payload.aud, // audience
      exp: payload.exp, // expiration time
      iat: payload.iat, // issued at time
    };

    // Attach user info to request object for conversation saving
    req.user = user;
    req.token = token;

    return next();
  } catch (error) {
    console.error('JWT verification error:', error);

    // Handle different types of JWT errors based on jose library error types
    if (error.code === 'ERR_JWT_EXPIRED') {
      return res.status(401).json({
        error: 'Token expired',
        details: 'Please sign in again',
      });
    }

    // Generic JWT error
    return res.status(401).json({
      error: 'Token verification failed',
      details: error.message,
    });
  }
};

/**
 * Verify JWT token from Authorization header
 */
const verifyAdminToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided',
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    const decoded = jwt.verify(token, JWT_SECRET);

    // Attach user info to request
    req.user = decoded;

    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token expired',
      });
    }

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid token',
    });
  }
};

const requireKbRoles =
  (...allowedRoles) =>
  (req, res, next) => {
    const userRole = String(req.user?.role || '').toLowerCase();
    const normalizedAllowed = allowedRoles.map((role) =>
      String(role || '').toLowerCase(),
    );

    if (!userRole || !normalizedAllowed.includes(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions for this action',
      });
    }

    return next();
  };

/**
 * Optional authentication middleware - extracts user info if token is present
 * but doesn't block the request if no token is provided. Used for endpoints
 * that work for both authenticated and unauthenticated users.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log(
      `🔍 [OptionalAuth] Authorization header: ${authHeader ? 'Present' : 'Not present'}`,
    );

    const token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    console.log(`🔍 [OptionalAuth] Token extracted: ${token ? 'Yes' : 'No'}`);

    // If no token provided, continue without user info
    if (!token) {
      console.log('🔍 [OptionalAuth] No token - setting user to null');
      req.user = null;
      req.token = null;
      return next();
    }

    // Verify JWT using JWKS (public keys from Supabase)
    const payload = await verifyToken(token);

    // Extract user information from JWT payload
    const user = {
      id: payload.sub, // User UUID from 'sub' claim
      email: payload.email,
      role: payload.role,
      aud: payload.aud, // audience
      exp: payload.exp, // expiration time
      iat: payload.iat, // issued at time
    };

    console.log(payload);

    console.log(
      `🔍 [OptionalAuth] User authenticated: ${user.id} (${user.email})`,
    );

    // Attach user info to request object
    req.user = user;
    req.token = token;

    return next();
  } catch (error) {
    console.error('Optional JWT verification error:', error);

    // For optional auth, if token is invalid, we still continue without user
    // but we log the error for debugging
    console.warn(
      'Invalid token provided to optional auth, continuing without user',
    );
    req.user = null;
    req.token = null;

    return next();
  }
};

module.exports = {
  authenticateToken,
  optionalAuth,
  verifyAdminToken,
  requireKbRoles,
  JWT_SECRET,
};
