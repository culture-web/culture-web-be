const { Groq } = require('groq-sdk');
const OpenAI = require('openai');

class GroqClientSingleton {
  constructor() {
    this.client = null;
    this.provider = null;
  }

  getInstance() {
    if (!this.client) {
      if (process.env.SOCLAAS_API_KEY) {
        const rawClient = new OpenAI({
          baseURL:
            process.env.SOCLAAS_BASE_URL ||
            'https://soclaas-api.comp.nus.edu.sg/v1',
          apiKey: process.env.SOCLAAS_API_KEY,
        });

        const activeModel = process.env.SOCLAAS_MODEL || 'default';

        // Wrap rawClient to intercept chat.completions.create
        // Automatically map legacy Groq model identifiers (e.g., 'openai/gpt-oss-120b') to SoC LaaS model
        this.client = {
          chat: {
            completions: {
              create: (params) => {
                // eslint-disable-next-line prefer-object-spread
                const finalParams = Object.assign({}, params);
                if (
                  !finalParams.model ||
                  finalParams.model === 'openai/gpt-oss-120b'
                ) {
                  finalParams.model = activeModel;
                }
                return rawClient.chat.completions.create(finalParams);
              },
            },
          },
          raw: rawClient,
        };
        this.provider = 'soclaas';
        console.log(
          `✅ [LLMClient] Initialized NUS SoC LaaS client (model: ${activeModel})`,
        );
      } else if (process.env.GROQ_API_KEY) {
        this.client = new Groq({
          apiKey: process.env.GROQ_API_KEY,
        });
        this.provider = 'groq';
        console.log('Groq client initialized');
      } else {
        throw new Error(
          'Either SOCLAAS_API_KEY or GROQ_API_KEY environment variable is required',
        );
      }
    }
    return this.client;
  }

  getProvider() {
    if (!this.client) {
      this.getInstance();
    }
    return this.provider;
  }

  getModel(defaultFallback = 'default') {
    if (process.env.SOCLAAS_API_KEY) {
      return process.env.SOCLAAS_MODEL || defaultFallback;
    }
    return process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  }

  reset() {
    this.client = null;
    this.provider = null;
    console.log('LLM client reset');
  }
}

const groqClient = new GroqClientSingleton();
module.exports = groqClient;
