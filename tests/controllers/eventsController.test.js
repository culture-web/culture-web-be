const httpMocks = require('node-mocks-http');
const { getEvents } = require('../../controllers/eventsController');

// Mock the supabase client
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

const supabase = require('../../client/supabaseClient');

describe('getEvents Controller', () => {
  let req;
  let res;
  let mockQuery;

  beforeEach(() => {
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();

    // Reset all mocks
    jest.clearAllMocks();

    // Create a mock query chain
    mockQuery = {
      gte: jest.fn().mockReturnThis(),
    };

    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        order: jest.fn().mockReturnValue({
          range: jest.fn().mockReturnValue(mockQuery),
        }),
      }),
    });
  });

  describe('Parameter Validation', () => {
    it('should return 400 for invalid limit (non-numeric)', async () => {
      req.query = { limit: 'abc' };

      await getEvents(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: 'Invalid limit parameter. Must be a number between 1 and 100.',
      });
    });

    it('should return 400 for limit less than 1', async () => {
      req.query = { limit: '0' };

      await getEvents(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: 'Invalid limit parameter. Must be a number between 1 and 100.',
      });
    });

    it('should return 400 for limit greater than 100', async () => {
      req.query = { limit: '101' };

      await getEvents(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: 'Invalid limit parameter. Must be a number between 1 and 100.',
      });
    });

    it('should return 400 for invalid offset (non-numeric)', async () => {
      req.query = { offset: 'xyz' };

      await getEvents(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: 'Invalid offset parameter. Must be a non-negative number.',
      });
    });

    it('should return 400 for negative offset', async () => {
      req.query = { offset: '-1' };

      await getEvents(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: 'Invalid offset parameter. Must be a non-negative number.',
      });
    });
  });

  describe('Successful Requests', () => {
    it('should return events with default parameters', async () => {
      const mockData = [
        {
          id: 1,
          title: 'Test Event',
          description: 'Test Description',
          start_time: '2025-12-01T10:00:00Z',
          end_time: '2025-12-01T12:00:00Z',
          location: 'Test Location',
          url: 'https://example.com/event1',
          category: 'Test',
          scraped_at: '2025-10-12T07:25:58.989155+00:00',
        },
      ];

      mockQuery.data = mockData;
      mockQuery.error = null;

      await getEvents(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        success: true,
        data: mockData,
        pagination: {
          limit: 50,
          offset: 0,
          count: 1,
        },
      });
    });

    it('should return events with custom limit and offset', async () => {
      req.query = { limit: '10', offset: '5' };
      const mockData = [
        {
          id: 6,
          title: 'Event 6',
          description: 'Description 6',
          start_time: '2025-12-06T10:00:00Z',
          end_time: '2025-12-06T12:00:00Z',
          location: 'Location 6',
          url: 'https://example.com/event6',
          category: 'Test',
          scraped_at: '2025-10-12T07:25:58.989155+00:00',
        },
      ];

      mockQuery.data = mockData;
      mockQuery.error = null;

      await getEvents(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        success: true,
        data: mockData,
        pagination: {
          limit: 10,
          offset: 5,
          count: 1,
        },
      });

      // Verify the range was called with correct parameters
      const rangeCall = supabase.from().select().order().range;
      expect(rangeCall).toHaveBeenCalledWith(5, 14); // offset to offset + limit - 1
    });

    it('should filter upcoming events when upcoming=true', async () => {
      req.query = { upcoming: 'true' };
      const mockData = [
        {
          id: 2,
          title: 'Future Event',
          description: 'Future Description',
          start_time: '2025-12-01T10:00:00Z',
          end_time: '2025-12-01T12:00:00Z',
          location: 'Future Location',
          url: 'https://example.com/future',
          category: 'Future',
          scraped_at: '2025-10-12T07:25:58.989155+00:00',
        },
      ];

      mockQuery.data = mockData;
      mockQuery.error = null;

      await getEvents(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expect(res._getJSONData()).toEqual({
        success: true,
        data: mockData,
        pagination: {
          limit: 50,
          offset: 0,
          count: 1,
        },
      });
    });

    it('should filter upcoming events when upcoming=1', async () => {
      req.query = { upcoming: '1' };
      const mockData = [];

      mockQuery.data = mockData;
      mockQuery.error = null;

      await getEvents(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expect(res._getJSONData()).toEqual({
        success: true,
        data: mockData,
        pagination: {
          limit: 50,
          offset: 0,
          count: 0,
        },
      });
    });

    it('should not filter when upcoming is false or not provided', async () => {
      req.query = { upcoming: 'false' };
      const mockData = [
        {
          id: 3,
          title: 'All Events',
          description: 'All Description',
          start_time: '2025-01-01T10:00:00Z',
          end_time: '2025-01-01T12:00:00Z',
          location: 'All Location',
          url: 'https://example.com/all',
          category: 'All',
          scraped_at: '2025-10-12T07:25:58.989155+00:00',
        },
      ];

      mockQuery.data = mockData;
      mockQuery.error = null;

      await getEvents(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockQuery.gte).not.toHaveBeenCalled();
      expect(res._getJSONData()).toEqual({
        success: true,
        data: mockData,
        pagination: {
          limit: 50,
          offset: 0,
          count: 1,
        },
      });
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when Supabase returns an error', async () => {
      const mockError = {
        message: 'Database connection failed',
        code: 'CONNECTION_ERROR',
      };

      mockQuery.data = null;
      mockQuery.error = mockError;

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await getEvents(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: 'Failed to fetch events',
        details: 'Database connection failed',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error fetching events from Supabase:',
        mockError,
      );

      consoleSpy.mockRestore();
    });

    it('should return 500 when an unexpected error occurs', async () => {
      // Mock supabase to throw an error
      supabase.from.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await getEvents(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: 'Internal server error',
        details: 'Unexpected error',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        'Unexpected error in getEvents controller:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Query Building', () => {
    it('should build correct query chain', async () => {
      req.query = { limit: '20', offset: '10', upcoming: 'true' };

      mockQuery.data = [];
      mockQuery.error = null;

      await getEvents(req, res);

      expect(supabase.from).toHaveBeenCalledWith('events');
      expect(supabase.from().select).toHaveBeenCalledWith('*');
      expect(supabase.from().select().order).toHaveBeenCalledWith(
        'start_time',
        { ascending: true },
      );
      expect(supabase.from().select().order().range).toHaveBeenCalledWith(
        10,
        29,
      );
      expect(mockQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
    });
  });
});
