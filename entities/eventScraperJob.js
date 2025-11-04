const supabase = require('../client/supabaseClient');
const BhaskarsArtsAcademyScraperService = require('../services/events/scrapers/bhaskarsArtsAcademyScraperService');
const embeddingService = require('../services/embeddingService');

/**
 * Event Scraper Job
 * Orchestrates the scraping of events from various sources and updates the database
 * Designed to be extensible for multiple event sources
 */
class EventScraperJob {
  constructor() {
    this.scrapers = [new BhaskarsArtsAcademyScraperService()];
    this.results = {
      totalScraped: 0,
      totalInserted: 0,
      totalUpdated: 0,
      totalFailed: 0,
      errors: [],
    };
  }

  /**
   * Add a new scraper to the job
   * @param {Object} scraper - Scraper instance with scrapeMultipleEvents method
   */
  addScraper(scraper) {
    this.scrapers.push(scraper);
  }

  /**
   * Execute the scraping job
   * @returns {Promise<Object>} Results summary
   */
  async execute() {
    console.log(
      `Starting event scraper job with ${this.scrapers.length} scraper(s)`,
    );

    await this.scrapers.reduce(async (promise, scraper) => {
      await promise;
      try {
        await this.processScraper(scraper);
      } catch (error) {
        console.error(
          `Error processing scraper ${scraper.sourceName}:`,
          error.message,
        );
        this.results.errors.push({
          source: scraper.sourceName,
          error: error.message,
        });
      }
    }, Promise.resolve());

    console.log('Event scraper job completed:', this.results);
    return this.results;
  }

  /**
   * Process a single scraper
   * @param {Object} scraper - Scraper instance
   */
  async processScraper(scraper) {
    console.log(`Processing scraper: ${scraper.sourceName}`);

    // Get events to scrape (now returns array of {url, date} objects)
    const events = await scraper.getDefaultEventUrls();
    console.log(`Found ${events.length} event(s) to scrape`);

    // Scrape events
    const scrapedEvents = await scraper.scrapeMultipleEvents(events);
    this.results.totalScraped += scrapedEvents.length;

    console.log(
      `Scraped ${scrapedEvents.length} event(s) from ${scraper.sourceName}`,
    );

    // Process each event
    await scrapedEvents.reduce(async (promise, event) => {
      await promise;
      try {
        await this.upsertEvent(event);
      } catch (error) {
        console.error(`Error upserting event ${event.title}:`, error.message);
        this.results.totalFailed += 1;
        this.results.errors.push({
          event: event.title,
          error: error.message,
        });
      }
    }, Promise.resolve());
  }

  /**
   * Insert or update an event in the database
   * @param {Object} event - Event object to upsert
   */
  async upsertEvent(event) {
    // Check if event already exists based on url
    const { data: existingEvents, error: fetchError } = await supabase
      .from('events')
      .select('id')
      .eq('url', event.url)
      .limit(1);

    if (fetchError) {
      throw new Error(`Failed to check existing event: ${fetchError.message}`);
    }

    // Generate embedding for the event
    let embedding;
    try {
      embedding = await embeddingService.generateEventEmbedding(event);
    } catch (embeddingError) {
      console.warn(
        `Warning: Failed to generate embedding for event ${event.title}:`,
        embeddingError.message,
      );
      embedding = null; // Continue without embedding
    }

    if (existingEvents && existingEvents.length > 0) {
      // Update existing event
      const { error: updateError } = await supabase
        .from('events')
        .update({
          title: event.title,
          description: event.description,
          start_time: event.start_time,
          end_time: event.end_time,
          location: event.location,
          embedding,
          scraped_at: new Date().toISOString(),
        })
        .eq('id', existingEvents[0].id);

      if (updateError) {
        throw new Error(`Failed to update event: ${updateError.message}`);
      }

      console.log(`Updated event: ${event.title}`);
      this.results.totalUpdated += 1;
    } else {
      // Insert new event
      const { error: insertError } = await supabase.from('events').insert({
        title: event.title,
        description: event.description,
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
        url: event.url,
        embedding,
        scraped_at: new Date().toISOString(),
      });

      if (insertError) {
        throw new Error(`Failed to insert event: ${insertError.message}`);
      }

      console.log(`Inserted new event: ${event.title}`);
      this.results.totalInserted += 1;
    }
  }

  /**
   * Get the results summary
   * @returns {Object} Results object
   */
  getResults() {
    return this.results;
  }
}

module.exports = EventScraperJob;
