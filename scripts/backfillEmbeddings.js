/* eslint-disable node/no-unsupported-features/es-syntax */
require('dotenv').config();
const supabase = require('../client/supabaseClient');
const embeddingService = require('../services/embeddingService');

/**
 * Backfill embeddings for existing events
 * This script generates embeddings for all events where embedding is NULL
 * Processes events in batches to avoid timeouts
 */

const BATCH_SIZE = 10; // Process 10 events at a time

/**
 * Process a single batch of events
 * @param {Array} events - Array of event objects
 * @returns {Promise<Object>} - Results summary
 */
async function processBatch(events) {
  const results = {
    success: 0,
    failed: 0,
    errors: [],
  };

  await events.reduce(async (promise, event) => {
    await promise;
    try {
      console.log(`Processing event: ${event.title} (ID: ${event.id})`);

      // Generate embedding for the event
      const embedding = await embeddingService.generateEventEmbedding(event);

      // Update the event with the embedding
      const { error } = await supabase
        .from('events')
        .update({ embedding })
        .eq('id', event.id);

      if (error) {
        throw new Error(error.message);
      }

      console.log(`✓ Successfully updated event: ${event.title}`);
      results.success += 1;
    } catch (error) {
      console.error(`✗ Failed to process event ${event.title}:`, error.message);
      results.failed += 1;
      results.errors.push({
        eventId: event.id,
        eventTitle: event.title,
        error: error.message,
      });
    }
  }, Promise.resolve());

  return results;
}

/**
 * Main function to backfill all embeddings
 */
async function backfillEmbeddings() {
  console.log('Starting embedding backfill process...\n');

  try {
    console.log('Fetching events without embeddings...');
    const { data: events, error } = await supabase
      .from('events')
      .select('*')
      .is('embedding', null);

    if (error) {
      throw new Error(`Failed to fetch events: ${error.message}`);
    }

    if (!events || events.length === 0) {
      console.log('✓ No events found without embeddings. All done!');
      return;
    }

    console.log(`Found ${events.length} event(s) without embeddings\n`);

    const totalBatches = Math.ceil(events.length / BATCH_SIZE);
    const overallResults = {
      success: 0,
      failed: 0,
      errors: [],
    };

    for (let i = 0; i < totalBatches; i += 1) {
      const batchStart = i * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, events.length);
      const batch = events.slice(batchStart, batchEnd);

      console.log(
        `\nProcessing batch ${i + 1}/${totalBatches} (${batch.length} events)...`,
      );

      // eslint-disable-next-line no-await-in-loop
      const batchResults = await processBatch(batch);
      overallResults.success += batchResults.success;
      overallResults.failed += batchResults.failed;
      overallResults.errors.push(...batchResults.errors);

      console.log(
        `Batch ${i + 1} completed: ${batchResults.success} success, ${batchResults.failed} failed`,
      );
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log('BACKFILL COMPLETE');
    console.log('='.repeat(50));
    console.log(`Total events processed: ${events.length}`);
    console.log(`✓ Successfully updated: ${overallResults.success}`);
    console.log(`✗ Failed: ${overallResults.failed}`);

    if (overallResults.errors.length > 0) {
      console.log('\nErrors:');
      overallResults.errors.forEach((err) => {
        console.log(
          `  - Event "${err.eventTitle}" (ID: ${err.eventId}): ${err.error}`,
        );
      });
    }
  } catch (error) {
    console.error('Fatal error during backfill:', error);
    process.exit(1);
  }
}

backfillEmbeddings()
  .then(() => {
    console.log('\nBackfill process completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nBackfill process failed:', error);
    process.exit(1);
  });
