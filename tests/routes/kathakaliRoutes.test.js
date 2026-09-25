process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.HF_TOKEN = 'test-hf-token';

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

const request = require('supertest');
const express = require('express');
// const multer = require('multer');
const kathakaliController = require('../../controllers/kathakaliController');
const kathakaliRoutes = require('../../routes/kathakaliRoutes');

jest.mock('../../controllers/kathakaliController');
jest.mock('../../middleware/authMiddleware', () => ({
  authenticateToken: (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
  verifyAdminToken: (req, res, next) => next(),
  requireKbRoles: () => (req, res, next) => next(),
}));
jest.mock('../../middleware/makeMulterMiddleware', () =>
  jest.fn(() => (req, res, next) => {
    next();
  }),
);
jest.mock('multer', () => {
  const multer = jest.fn(() => ({
    single: jest.fn(),
  }));
  multer.memoryStorage = jest.fn(() => {});
  return multer;
});

describe('POST /', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(kathakaliRoutes);
    kathakaliController.classifyCharacter.mockImplementation((req, res) =>
      res.sendStatus(200),
    );
  });

  it('should call classifyCharacter', async () => {
    const res = await request(app).post('/').send();
    expect(res.statusCode).toBe(200);
    expect(kathakaliController.classifyCharacter).toHaveBeenCalled();
  });
});

describe('POST /classify-expression', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(kathakaliRoutes);
    kathakaliController.classifyExpression.mockImplementation((req, res) =>
      res.sendStatus(200),
    );
  });

  it('should call classifyExpression', async () => {
    const res = await request(app).post('/classify-expression').send();
    expect(res.statusCode).toBe(200);
    expect(kathakaliController.classifyExpression).toHaveBeenCalled();
  });
});

describe('sequential adaptive quiz routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(kathakaliRoutes);
  });

  it('starts an adaptive quiz with POST', async () => {
    kathakaliController.startAdaptiveQuiz.mockImplementation((req, res) =>
      res.status(201).json({ quizId: 'quiz-1' }),
    );

    const res = await request(app).post('/generate-adaptive-quiz').send({});

    expect(res.statusCode).toBe(201);
    expect(kathakaliController.startAdaptiveQuiz).toHaveBeenCalled();
  });

  it('submits one adaptive answer', async () => {
    kathakaliController.answerAdaptiveQuizQuestion.mockImplementation(
      (req, res) => res.status(200).json({ quizId: req.params.quizId }),
    );

    const res = await request(app)
      .post('/quiz/quiz-1/answer')
      .send({ questionId: 'question-1', answer: 'A' });

    expect(res.statusCode).toBe(200);
    expect(kathakaliController.answerAdaptiveQuizQuestion).toHaveBeenCalled();
  });

  it('resumes the current adaptive question', async () => {
    kathakaliController.getAdaptiveQuizCurrent.mockImplementation((req, res) =>
      res.status(200).json({ quizId: req.params.quizId }),
    );

    const res = await request(app).get('/quiz/quiz-1/current');

    expect(res.statusCode).toBe(200);
    expect(kathakaliController.getAdaptiveQuizCurrent).toHaveBeenCalled();
  });
});
