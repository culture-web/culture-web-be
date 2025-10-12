const supabase = require('../client/supabaseClient');

/**
 * Get all events with optional filtering and pagination
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getEvents = async (req, res) => {
  try {
    const { upcoming, limit = 50, offset = 0 } = req.query;

    const parsedLimit = parseInt(limit, 10);
    const parsedOffset = parseInt(offset, 10);

    if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({
        error: 'Invalid limit parameter. Must be a number between 1 and 100.',
      });
    }

    if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({
        error: 'Invalid offset parameter. Must be a non-negative number.',
      });
    }

    let query = supabase
      .from('events')
      .select('*')
      .order('start_time', { ascending: true })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    if (upcoming === 'true' || upcoming === '1') {
      const currentDateTime = new Date().toISOString();
      query = query.gte('start_time', currentDateTime);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching events from Supabase:', error);
      return res.status(500).json({
        error: 'Failed to fetch events',
        details: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      data: data,
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        count: data.length,
      },
    });
  } catch (error) {
    console.error('Unexpected error in getEvents controller:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    });
  }
};

module.exports = {
  getEvents,
};
