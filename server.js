// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const kathakaliRoutes = require('./routes/kathakaliRoutes');
const uploadDataRoutes = require('./routes/uploadDataRoutes');

const app = express();
const port = 3001; // Choose any available port

// Secure CORS configuration with whitelisted origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://kathakali.comp.nus.edu.sg',
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    console.warn(`CORS blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true, // Allow cookies if needed
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add a simple route
app.get('/api', (req, res) => {
  res.send('Hello, this is your Express backend!');
});

app.use('/api/kathakali', kathakaliRoutes);

app.use('/api/kathakali', uploadDataRoutes);

// Start the server
const server = app.listen(port, () => {
  console.log('Server is running on port 3001');
});

const handleShutdown = () => {
  console.log('Shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

// Listen for termination signals
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

module.exports = server;
