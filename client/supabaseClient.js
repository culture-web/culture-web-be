// supabaseClient.js (Example using Service Role Key for a secure connection)
const { createClient } = require('@supabase/supabase-js');

// Get environment variables
const supabaseUrl = process.env.SUPABASE_URL;
// NOTE: Use the Service Role Key for writing data (cron job) or sensitive server-side operations
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize the Supabase client
const supabase = createClient(supabaseUrl, supabaseKey);

// Endpoint logic will use this 'supabase' instance
module.exports = supabase;
