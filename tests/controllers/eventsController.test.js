const httpMocks = require('node-mocks-http');
const { getEvents } = require('../../controllers/eventsController');

jest.mock('../../client/supabaseClient', () => ({
  from: jest.fn(() => ({
    select: jest.fn(() => ({
      order: jest.fn(() => ({
        range: jest.fn(() => ({
          gte: jest.fn(),
        })),
      })),
      gte: jest.fn(),
    })),
  })),
}));

const supabase = require('../../client/supabaseClient');

describe('getEvents Controller', () => {
  let req;
  let res;
  let mockDataQuery;
  let mockCountQuery;

  const createEventVariant = (id, title, overrides = {}) => {
    const baseEvent = {
      id: id,
      title: title,
      description: overrides.description || 'Test Description',
      start_time: overrides.start_time || '2025-12-01T10:00:00Z',
      end_time: overrides.end_time || '2025-12-01T12:00:00Z',
      location: overrides.location || 'Test Location',
      url: overrides.url || `https://example.com/event${id}`,
      category: overrides.category || 'Test',
      scraped_at: '2025-10-12T07:25:58.989155+00:00',
    };
    return baseEvent;
  };

  const setupMockResponse = (
    data,
    total = null,
    error = null,
    countError = null,
  ) => {
    mockDataQuery.data = data;
    mockDataQuery.error = error;
    let calculatedTotal;
    if (total !== null) {
      calculatedTotal = total;
    } else if (data) {
      calculatedTotal = data.length;
    } else {
      calculatedTotal = 0;
    }
    mockCountQuery.count = calculatedTotal;
    mockCountQuery.error = countError;
  };

  const expectError = (statusCode, errorMessage) => {
    expect(res.statusCode).toBe(statusCode);
    expect(res._getJSONData()).toEqual({ error: errorMessage });
  };

  const expectSuccess = (data, pagination) => {
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      success: true,
      data,
      pagination,
    });
  };

  beforeEach(() => {
    req = httpMocks.createRequest();
    res = httpMocks.createResponse();
    jest.clearAllMocks();

    mockDataQuery = { gte: jest.fn().mockReturnThis() };
    mockCountQuery = { gte: jest.fn().mockReturnThis() };

    const mockRange = jest.fn().mockReturnValue(mockDataQuery);
    const mockOrder = jest.fn().mockReturnValue({
      range: mockRange,
    });
    const mockSelect = jest.fn((columns, options) => {
      if (options && options.count === 'exact' && options.head === true) {
        return mockCountQuery;
      }
      return {
        order: mockOrder,
      };
    });

    supabase.from.mockReturnValue({
      select: mockSelect,
    });

    supabase.from().select = mockSelect;
    supabase.from().select().order = mockOrder;
    supabase.from().select().order().range = mockRange;
  });

  describe('Parameter Validation', () => {
    const limitError =
      'Invalid limit parameter. Must be a number between 1 and 100.';
    const offsetError =
      'Invalid offset parameter. Must be a non-negative number.';

    const testCases = [
      {
        query: { limit: 'abc' },
        error: limitError,
        desc: 'invalid limit (non-numeric)',
      },
      { query: { limit: '0' }, error: limitError, desc: 'limit less than 1' },
      {
        query: { limit: '101' },
        error: limitError,
        desc: 'limit greater than 100',
      },
      {
        query: { offset: 'xyz' },
        error: offsetError,
        desc: 'invalid offset (non-numeric)',
      },
      { query: { offset: '-1' }, error: offsetError, desc: 'negative offset' },
    ];

    testCases.forEach(({ query, error, desc }) => {
      it(`should return 400 for ${desc}`, async () => {
        req.query = query;
        await getEvents(req, res);
        expectError(400, error);
      });
    });
  });

  describe('Successful Requests', () => {
    it('should return events with default parameters', async () => {
      const mockData = [createEventVariant(1, 'Test Event')];
      setupMockResponse(mockData, 5); // 5 total events

      await getEvents(req, res);

      expectSuccess(mockData, { limit: 50, offset: 0, total: 5 });
    });

    it('should return events with custom limit and offset', async () => {
      req.query = { limit: '10', offset: '5' };
      const mockData = [createEventVariant(6, 'Event 6')];
      setupMockResponse(mockData, 20); // 20 total events

      await getEvents(req, res);

      expectSuccess(mockData, { limit: 10, offset: 5, total: 20 });
      expect(supabase.from().select().order().range).toHaveBeenCalledWith(
        5,
        14,
      );
    });

    it('should filter upcoming events when upcoming=true', async () => {
      req.query = { upcoming: 'true' };
      const mockData = [createEventVariant(2, 'Future Event')];
      setupMockResponse(mockData, 3); // 3 total upcoming events

      await getEvents(req, res);

      expect(mockDataQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expect(mockCountQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expectSuccess(mockData, { limit: 50, offset: 0, total: 3 });
    });

    it('should filter upcoming events when upcoming=1', async () => {
      req.query = { upcoming: '1' };
      setupMockResponse([], 0); // 0 total upcoming events

      await getEvents(req, res);

      expect(mockDataQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expect(mockCountQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expectSuccess([], { limit: 50, offset: 0, total: 0 });
    });

    it('should not filter when upcoming is false', async () => {
      req.query = { upcoming: 'false' };
      const mockData = [createEventVariant(3, 'All Events')];
      setupMockResponse(mockData, 10); // 10 total events

      await getEvents(req, res);

      expect(mockDataQuery.gte).not.toHaveBeenCalled();
      expect(mockCountQuery.gte).not.toHaveBeenCalled();
      expectSuccess(mockData, { limit: 50, offset: 0, total: 10 });
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when Supabase returns an error', async () => {
      const mockError = { message: 'Database connection failed' };
      setupMockResponse(null, null, mockError);

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

    it('should return 500 when count query returns an error', async () => {
      const mockCountError = { message: 'Count query failed' };
      setupMockResponse([], null, null, mockCountError);

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await getEvents(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: 'Failed to fetch events',
        details: 'Count query failed',
      });

      consoleSpy.mockRestore();
    });

    it('should return 500 when an unexpected error occurs', async () => {
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

      consoleSpy.mockRestore();
    });
  });

  describe('Query Building', () => {
    it('should build correct query chain', async () => {
      req.query = { limit: '20', offset: '10', upcoming: 'true' };
      setupMockResponse([], 0);

      await getEvents(req, res);

      expect(supabase.from).toHaveBeenCalledWith('events');
      expect(supabase.from().select).toHaveBeenCalledWith('*');
      expect(supabase.from().select).toHaveBeenCalledWith('*', {
        count: 'exact',
        head: true,
      });
      expect(supabase.from().select().order).toHaveBeenCalledWith(
        'start_time',
        { ascending: true },
      );
      expect(supabase.from().select().order().range).toHaveBeenCalledWith(
        10,
        29,
      );
      expect(mockDataQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
      expect(mockCountQuery.gte).toHaveBeenCalledWith(
        'start_time',
        expect.any(String),
      );
    });
  });
});
