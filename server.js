// server.js
const express = require('express');
const kathakaliRoutes = require('./routes/kathakaliRoutes');

const app = express();
const port = 3001; // Choose any available port

// Add a simple route
app.get('/api', (req, res) => {
  res.send('Hello, this is your Express backend!');
});

app.use('/api/kathakali', kathakaliRoutes);

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
