const request = require('supertest');
const express = require('express');
const eventsController = require('../../controllers/eventsController');
const eventsRoutes = require('../../routes/eventsRoutes');

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

jest.mock('../../controllers/eventsController');
jest.mock('../../entities/eventScraperJob');
jest.mock('../../client/supabaseClient', () => ({
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

describe('Events Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(eventsRoutes);
    jest.clearAllMocks();
  });

  describe('GET /', () => {
    it('should call eventsController.getEvents', async () => {
      eventsController.getEvents.mockImplementation((req, res) =>
        res.status(200).json({ success: true, data: [] }),
      );

      const res = await request(app).get('/');

      expect(res.statusCode).toBe(200);
      expect(eventsController.getEvents).toHaveBeenCalled();
      expect(res.body).toEqual({ success: true, data: [] });
    });

    it('should pass query parameters to controller', async () => {
      eventsController.getEvents.mockImplementation((req, res) => {
        expect(req.query.limit).toBe('10');
        expect(req.query.offset).toBe('5');
        expect(req.query.upcoming).toBe('true');
        res.status(200).json({ success: true, data: [] });
      });

      const res = await request(app)
        .get('/')
        .query({ limit: 10, offset: 5, upcoming: true });

      expect(res.statusCode).toBe(200);
      expect(eventsController.getEvents).toHaveBeenCalled();
    });

    it('should handle controller errors gracefully', async () => {
      eventsController.getEvents.mockImplementation((req, res) =>
        res.status(500).json({ error: 'Internal server error' }),
      );

      const res = await request(app).get('/');

      expect(res.statusCode).toBe(500);
      expect(eventsController.getEvents).toHaveBeenCalled();
      expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('should handle validation errors from controller', async () => {
      eventsController.getEvents.mockImplementation((req, res) =>
        res.status(400).json({
          error: 'Invalid limit parameter. Must be a number between 1 and 100.',
        }),
      );

      const res = await request(app).get('/').query({ limit: 'invalid' });

      expect(res.statusCode).toBe(400);
      expect(eventsController.getEvents).toHaveBeenCalled();
      expect(res.body).toEqual({
        error: 'Invalid limit parameter. Must be a number between 1 and 100.',
      });
    });

    it('should work without query parameters', async () => {
      eventsController.getEvents.mockImplementation((req, res) => {
        expect(req.query).toEqual({});
        res.status(200).json({
          success: true,
          data: [],
          pagination: { limit: 50, offset: 0, count: 0 },
        });
      });

      const res = await request(app).get('/');

      expect(res.statusCode).toBe(200);
      expect(eventsController.getEvents).toHaveBeenCalled();
    });

    it('should handle upcoming filter variations', async () => {
      eventsController.getEvents.mockImplementation((req, res) => {
        res.status(200).json({ success: true, data: [] });
      });

      // Test upcoming=true
      let res = await request(app).get('/').query({ upcoming: 'true' });
      expect(res.statusCode).toBe(200);

      // Test upcoming=1
      res = await request(app).get('/').query({ upcoming: '1' });
      expect(res.statusCode).toBe(200);

      // Test upcoming=false
      res = await request(app).get('/').query({ upcoming: 'false' });
      expect(res.statusCode).toBe(200);

      expect(eventsController.getEvents).toHaveBeenCalledTimes(3);
    });

    it('should handle pagination parameters', async () => {
      eventsController.getEvents.mockImplementation((req, res) => {
        res.status(200).json({
          success: true,
          data: [],
          pagination: {
            limit: parseInt(req.query.limit || 50, 10),
            offset: parseInt(req.query.offset || 0, 10),
            count: 0,
          },
        });
      });

      const res = await request(app).get('/').query({ limit: 25, offset: 10 });

      expect(res.statusCode).toBe(200);
      expect(eventsController.getEvents).toHaveBeenCalled();
      expect(res.body.pagination).toEqual({
        limit: 25,
        offset: 10,
        count: 0,
      });
    });

    it('should handle complex query combinations', async () => {
      eventsController.getEvents.mockImplementation((req, res) => {
        expect(req.query.upcoming).toBe('true');
        expect(req.query.limit).toBe('20');
        expect(req.query.offset).toBe('5');
        res.status(200).json({ success: true, data: [] });
      });

      const res = await request(app)
        .get('/')
        .query({ upcoming: true, limit: 20, offset: 5 });

      expect(res.statusCode).toBe(200);
      expect(eventsController.getEvents).toHaveBeenCalled();
    });
  });

  describe('POST /scrape', () => {
    it('should call eventsController.scrapeEvents and return success', async () => {
      eventsController.scrapeEvents.mockImplementation((req, res) =>
        res.status(200).json({
          success: true,
          message: 'Event scraping completed',
          results: { totalScraped: 5, totalInserted: 3, totalUpdated: 2 },
        }),
      );

      const res = await request(app).post('/scrape');

      expect(res.statusCode).toBe(200);
      expect(eventsController.scrapeEvents).toHaveBeenCalled();
      expect(res.body).toEqual({
        success: true,
        message: 'Event scraping completed',
        results: { totalScraped: 5, totalInserted: 3, totalUpdated: 2 },
      });
    });

    it('should handle errors from the scraping job', async () => {
      eventsController.scrapeEvents.mockImplementation((req, res) =>
        res.status(500).json({
          success: false,
          error: 'Failed to execute event scraping job',
          details: 'Scraper error',
        }),
      );

      const res = await request(app).post('/scrape');

      expect(res.statusCode).toBe(500);
      expect(eventsController.scrapeEvents).toHaveBeenCalled();
      expect(res.body).toEqual({
        success: false,
        error: 'Failed to execute event scraping job',
        details: 'Scraper error',
      });
    });
  });

  describe('Route not found', () => {
    it('should return 404 for non-existent routes', async () => {
      const res = await request(app).get('/nonexistent');
      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for POST requests to non-existent routes', async () => {
      const res = await request(app).post('/nonexistent');
      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for PUT requests', async () => {
      const res = await request(app).put('/');
      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for DELETE requests', async () => {
      const res = await request(app).delete('/');
      expect(res.statusCode).toBe(404);
    });
  });
});
