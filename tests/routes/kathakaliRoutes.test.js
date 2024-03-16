const request = require('supertest');
const express = require('express');
// const multer = require('multer');
const make = require('../../middleware/makeMulterMiddleware');
const kathakaliController = require('../../controllers/kathakaliController');
const kathakaliRoutes = require('../../routes/kathakaliRoutes');

jest.mock('../../controllers/kathakaliController');
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
    kathakaliController.classifyCharacter.mockImplementation((req, res, next) =>
      res.sendStatus(200),
    );
  });

  it('should call classifyCharacter', async () => {
    const res = await request(app).post('/').send();
    expect(res.statusCode).toBe(200);
    expect(kathakaliController.classifyCharacter).toHaveBeenCalled();
  });
});
