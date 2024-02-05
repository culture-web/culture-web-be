// server.js
const express = require('express');

const app = express();
const port = 3001; // Choose any available port

// Start the server
const server = app.listen(port, () => {
  console.log('Server is running on port 3001');
});

// Define a simple route
app.get('/', (req, res) => {
  res.send('Hello, this is your Express backend!');
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
