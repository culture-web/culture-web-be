// server.js
const express = require("express");
const app = express();
const port = 3001; // Choose any available port

// Define a simple route
app.get("/", (req, res) => {
  res.send("Hello, this is your Express backend!");
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = app; // Export the app for testing
