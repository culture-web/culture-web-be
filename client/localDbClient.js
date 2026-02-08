const { Pool } = require('pg');

// Load environment variables with validation - no hardcoded defaults for security
const {
  LOCAL_DB_HOST,
  LOCAL_DB_USER,
  LOCAL_DB_PASSWORD,
  LOCAL_DB_NAME,
} = process.env;

const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 5432);

// Validate required credentials are set
if (!LOCAL_DB_HOST || !LOCAL_DB_USER || !LOCAL_DB_PASSWORD || !LOCAL_DB_NAME) {
  throw new Error(
    'Missing required LOCAL_DB environment variables. Please set: LOCAL_DB_HOST, LOCAL_DB_USER, LOCAL_DB_PASSWORD, LOCAL_DB_NAME',
  );
}

// Create a dedicated pool for local pgvector database
const pool = new Pool({
  host: LOCAL_DB_HOST,
  port: LOCAL_DB_PORT,
  user: LOCAL_DB_USER,
  password: LOCAL_DB_PASSWORD,
  database: LOCAL_DB_NAME,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on local DB client', err);
});

module.exports = pool;
