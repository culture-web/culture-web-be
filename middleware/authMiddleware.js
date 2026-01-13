/**
 * Authentication Middleware
 * Protects admin routes with JWT token validation
 */
const jwt = require('jsonwebtoken');

// Use environment variable for secret, fallback for development
const JWT_SECRET = process.env.JWT_SECRET || 'kathakalai-secret-key-change-in-production';

/**
 * Verify JWT token from Authorization header
 */
const verifyAdminToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'No token provided' 
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Attach user info to request
    req.user = decoded;
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Token expired' 
      });
    }
    
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid token' 
    });
  }
};

module.exports = { verifyAdminToken, JWT_SECRET };
