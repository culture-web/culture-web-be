const { Pool } = require('pg');

const LOCAL_DB_HOST = process.env.LOCAL_DB_HOST || 'localhost';
const LOCAL_DB_PORT = Number(process.env.LOCAL_DB_PORT || 5432);
const LOCAL_DB_USER = process.env.LOCAL_DB_USER || 'raguser';
const LOCAL_DB_PASSWORD = process.env.LOCAL_DB_PASSWORD || 'ragpass';
const LOCAL_DB_NAME = process.env.LOCAL_DB_NAME || 'ragdb';

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
