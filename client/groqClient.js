const Groq = require('groq-sdk');

class GroqClientSingleton {
  constructor() {
    this.client = null;
  }

  getInstance() {
    if (!this.client) {
      if (!process.env.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY environment variable is required');
      }

      this.client = new Groq({
        apiKey: process.env.GROQ_API_KEY,
      });
      console.log('Groq client initialized');
    }
    return this.client;
  }

  reset() {
    this.client = null;
    console.log('Groq client reset');
  }
}

const groqClient = new GroqClientSingleton();
module.exports = groqClient;
