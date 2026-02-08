const axios = require('axios');
const cheerio = require('cheerio');
const chrono = require('chrono-node');
const huggingFaceClient = require('../../../client/huggingfaceClient');
/**
 * Scraper for Bhaskar's Arts Academy website
 * Implements a standard scraper interface that can be extended to other sources
 */

class BhaskarsArtsAcademyScraperService {
  constructor() {
    this.baseUrl =
      process.env.BHASKARS_BASE_URL || 'https://www.bhaskarsartsacademy.com';
    this.sourceName = 'Bhaskars Arts Academy';
  }

  /**
   * Fetches and parses event details from a specific event URL
   * @param {string} eventUrl - Full URL to the event details page
   * @param {string|null} fallbackDate - Date string from listing page (e.g., "11 Oct 2025")
   * @returns {Promise<Object>} Parsed event object
   */
  async scrapeEventDetails(eventUrl, fallbackDate = null) {
    try {
      const response = await axios.get(eventUrl, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      const $ = cheerio.load(response.data);

      // Extract event title
      const title = $('h3').first().text().trim();

      // Extract event description - get all text content
      let description = '';
      $('p').each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 20) {
          description += `${text}\n\n`;
        }
      });
      description = description.trim();
      // Remove copyright phrase
      description = description
        .replace(
          /Copyright ©\d{4} Bhaskar's Arts Academy\. All Rights Reserved\./g,
          '',
        )
        .trim();

      // Extract dates from the content (will use chrono-node fallback parsing)

      // Parse start and end times
      let startTime = null;
      let endTime = null;

      const location = await this.extractVenueFromText(description);
      // If date/time not found, use chrono to parse free-text dates from description
      if (!startTime && description) {
        const chronoResults = chrono.parse(description);
        if (chronoResults && chronoResults.length > 0) {
          // Use the first parsed date
          const parsed = chronoResults[0];
          if (parsed && parsed.start) {
            startTime = parsed.start.date().toISOString();
            // If an end date is present
            if (parsed.end) {
              endTime = parsed.end.date().toISOString();
            } else {
              endTime = new Date(
                new Date(startTime).getTime() + 3 * 60 * 60 * 1000,
              ).toISOString();
            }
          }
        }
      }
      // If still not found, fallback to listing page date
      if (!startTime && fallbackDate) {
        startTime = this.parseDateTime(fallbackDate, '7:30pm');
        if (startTime) {
          endTime = new Date(
            new Date(startTime).getTime() + 3 * 60 * 60 * 1000,
          ).toISOString();
        }
      }

      return {
        title: title || 'Untitled Event',
        description: description || 'No description available',
        start_time: startTime,
        end_time: endTime,
        location: location,
        url: eventUrl, // Maps to your 'url' field
      };
    } catch (error) {
      console.error(`Error scraping event from ${eventUrl}:`, error.message);
      throw new Error(`Failed to scrape event: ${error.message}`);
    }
  }

  /**
   * Parse date and time strings into ISO datetime
   * @param {string} dateStr - Date string like "3 May 2025"
   * @param {string} timeStr - Time string like "7:30pm"
   * @returns {string} ISO datetime string
   */
  parseDateTime(dateStr, timeStr) {
    try {
      // Work on local copies to avoid mutating parameters
      const ds = (dateStr || '').trim();
      const ts = (timeStr || '').toLowerCase().trim();

      // Parse time
      const timeRegex = /(\d{1,2})[:.](\d{2})\s*(am|pm)/i;
      const timeMatch = ts.match(timeRegex);

      if (!timeMatch) {
        return null;
      }

      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const meridiem = timeMatch[3].toLowerCase();

      // Convert to 24-hour format
      if (meridiem === 'pm' && hours !== 12) {
        hours += 12;
      } else if (meridiem === 'am' && hours === 12) {
        hours = 0;
      }

      // Parse date
      const months = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
      };

      const dateRegex =
        /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i;
      const dateMatch = ds.match(dateRegex);

      if (!dateMatch) {
        return null;
      }

      const day = parseInt(dateMatch[1], 10);
      const month = months[dateMatch[2].toLowerCase()];
      const year = parseInt(dateMatch[3], 10);

      // Create date object (Singapore timezone UTC+8)
      const date = new Date(Date.UTC(year, month, day, hours - 8, minutes, 0));
      return date.toISOString();
    } catch (error) {
      console.error('Error parsing datetime:', error);
      return null;
    }
  }

  /**
   * Try to extract a concise venue name from free text using regex and cleanup
   * @param {string} text
   * @returns {string|null}
   */
  async extractVenueFromText(text) {
    // If no text, nothing to do
    if (!text) return null;

    // Basic HTML entity cleanup
    const decoded = text
      .replace(/&nbsp;|\u00A0/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;|&#x27;/g, "'")
      .replace(/&quot;/g, '"');

    try {
      const client = huggingFaceClient.getInstance();
      const model = process.env.HF_CHAT_MODEL || 'openai/gpt-oss-120b';
      const provider = process.env.HF_CHAT_PROVIDER || 'together';

      const prompt = `Analyze the following text and extract the full name of the place that the event will be held at, only if available. Return the result as a JSON object with the key "full_address". If no address is present, return an empty JSON object {}.\n\nText:\n${decoded}`;

      const messages = [
        {
          role: 'system',
          content:
            'You are a JSON extractor. Only reply with a single JSON object and nothing else. The JSON must have exactly one key: "full_address" whose value is the full name of the venue or full postal address including unit number if available. If no venue or address is present, return an empty JSON object {}. Do not include any extra text.',
        },
        {
          role: 'system',
          content:
            'Example 1: Input: "Venue: Victoria Theatre, 9 Empress Pl, Singapore 179556" -> Output: {"full_address":"Victoria Theatre, 9 Empress Pl, Singapore 179556"}. Example 2: Input: "Venue: Singapore Chinese Cultural Centre Auditorium, Level 9" -> Output: {"full_address":"Singapore Chinese Cultural Centre Auditorium, Level 9"}.',
        },
        { role: 'user', content: prompt },
      ];

      const chatCompletion = await client.chatCompletion({
        provider,
        model,
        messages,
      });

      const textOut = chatCompletion?.choices?.[0]?.message?.content;
      if (!textOut) return null;

      const jsonMatch = textOut.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      let parsed = null;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e) {
        const cleaned = jsonMatch[0]
          .replace(/[“”‘’]/g, '"')
          .replace(/,\s*,/g, ',');
        try {
          parsed = JSON.parse(cleaned);
        } catch (err) {
          return null;
        }
      }

      if (parsed && parsed.full_address) {
        const addr = parsed.full_address.trim();
        return addr.length > 0 ? addr : null;
      }

      return null;
    } catch (error) {
      console.error('HF chat address extraction failed:', error.message);
      return null;
    }
  }

  async scrapeMultipleEvents(events) {
    const results = [];

    const sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(), ms);
      });

    await events.reduce(
      (promiseChain, eventInfo) =>
        promiseChain.then(async () => {
          try {
            const event = await this.scrapeEventDetails(
              eventInfo.url,
              eventInfo.date,
            );
            results.push(event);

            await sleep(1000);
          } catch (error) {
            console.error(`Failed to scrape ${eventInfo.url}:`, error.message);
          }
        }),
      Promise.resolve(),
    );

    return results;
  }

  async scrapeEventListingPage() {
    try {
      console.log('Scraping events listing page...');
      const listingUrl = `${this.baseUrl}/events/past`;

      const response = await axios.get(listingUrl, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      const $ = cheerio.load(response.data);
      const events = [];

      // Find all event containers with class="col-md-4 col-sm-6"
      $('.col-md-4.col-sm-6').each((i, elem) => {
        const $elem = $(elem);

        // Find the Details link
        const detailsLink = $elem
          .find('a[href*="/event/details.cfm"]')
          .attr('href');

        // Extract date from the course-top-part div
        const dateText = $elem.find('.course-top-part').text().trim();

        // Extract just the date part (e.g., "11 Oct 2025")
        // The format is usually "Event Title\n11 Oct 2025"
        const dateMatch = dateText.match(/(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);

        if (detailsLink && dateMatch) {
          const fullUrl = detailsLink.startsWith('http')
            ? detailsLink
            : `${this.baseUrl}${detailsLink}`;

          const dateString = dateMatch[1].trim();

          events.push({
            url: fullUrl,
            date: dateString,
          });
        }
      });

      const uniqueEvents = events.filter(
        (event, index, self) =>
          index === self.findIndex((e) => e.url === event.url),
      );

      console.log(`Found ${uniqueEvents.length} event(s) on listing page`);
      return uniqueEvents;
    } catch (error) {
      console.error('Error scraping event listing page:', error.message);
      return [];
    }
  }

  async getDefaultEventUrls() {
    return this.scrapeEventListingPage();
  }
}

module.exports = BhaskarsArtsAcademyScraperService;
