// Mock @xenova/transformers to avoid ES module issues
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn(() =>
    Promise.resolve({
      encode: jest.fn(() => Promise.resolve([0.1, 0.2, 0.3])), // Mock embedding vector
    }),
  ),
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
  },
}));

// Mock authMiddleware to avoid SUPABASE_JWT_ISSUER URL issues
jest.mock('../middleware/authMiddleware', () => ({
  authenticateToken: (req, res, next) => {
    // Mock authenticated user for tests
    req.user = { id: 'test-user-id', email: 'test@example.com' };
    next();
  },
  optionalAuth: (req, res, next) => {
    // Mock optional authentication
    req.user = { id: 'test-user-id', email: 'test@example.com' };
    next();
  },
  verifyAdminToken: (req, res, next) => {
    // Mock admin token verification
    req.user = { id: 'admin-user-id', email: 'admin@example.com', role: 'admin' };
    next();
  },
  JWT_SECRET: 'test-jwt-secret',
}));

const request = require('supertest');

jest.mock('../client/supabaseClient', () => ({
  from: jest.fn(() => ({
    select: jest.fn(() => ({
      order: jest.fn(() => ({
        range: jest.fn(() => ({
          gte: jest.fn(),
        })),
      })),
    })),
  })),
}));

const app = require('../server');

describe('GET /api', () => {
  it('should return status code 200', async () => {
    const response = await request(app).get('/api');
    expect(response.statusCode).toBe(200);
    expect(response.text).toBe('Hello, this is your Express backend!');
  });

  afterAll(() => {
    app.close();
  });
});
