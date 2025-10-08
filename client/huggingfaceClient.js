const { InferenceClient } = require('@huggingface/inference');

class HuggingFaceClientSingleton {
  constructor() {
    this.client = null;
  }

  getInstance() {
    if (!this.client) {
      if (!process.env.HF_TOKEN) {
        throw new Error('HF_TOKEN environment variable is required');
      }

      this.client = new InferenceClient(process.env.HF_TOKEN);
      console.log('HuggingFace InferenceClient initialized');
    }
    return this.client;
  }

  reset() {
    this.client = null;
    console.log('HuggingFace InferenceClient reset');
  }
}

const huggingFaceClient = new HuggingFaceClientSingleton();
module.exports = huggingFaceClient;
