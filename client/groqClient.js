const { Groq } = require('groq-sdk');
const OpenAI = require('openai');

class GroqClientSingleton {
  constructor() {
    this.client = null;
    this.provider = null;
  }

  getInstance() {
    if (!this.client) {
      const explicitProvider = process.env.LLM_PROVIDER
        ? process.env.LLM_PROVIDER.toLowerCase()
        : null;
      const isProduction = process.env.NODE_ENV === 'production';

      // Provider resolution:
      // 1. Explicit override if specified (openai, soclaas, groq)
      // 2. In production: prefer OPENAI_API_KEY -> SOCLAAS_API_KEY -> GROQ_API_KEY
      // 3. In non-production (dev/test): prefer SOCLAAS_API_KEY -> OPENAI_API_KEY -> GROQ_API_KEY
      let targetProvider = explicitProvider;
      if (!targetProvider) {
        if (isProduction) {
          if (process.env.OPENAI_API_KEY) {
            targetProvider = 'openai';
          } else if (process.env.SOCLAAS_API_KEY) {
            targetProvider = 'soclaas';
          } else if (process.env.GROQ_API_KEY) {
            targetProvider = 'groq';
          }
        } else if (process.env.SOCLAAS_API_KEY) {
          targetProvider = 'soclaas';
        } else if (process.env.OPENAI_API_KEY) {
          targetProvider = 'openai';
        } else if (process.env.GROQ_API_KEY) {
          targetProvider = 'groq';
        }
      }

      if (targetProvider === 'openai' && process.env.OPENAI_API_KEY) {
        const rawClient = new OpenAI({
          baseURL: process.env.OPENAI_BASE_URL || undefined,
          apiKey: process.env.OPENAI_API_KEY,
        });

        const activeModel = process.env.OPENAI_MODEL || 'gpt-6-luna';

        this.client = {
          chat: {
            completions: {
              create: (params) => {
                // eslint-disable-next-line prefer-object-spread
                const finalParams = Object.assign({}, params);
                if (
                  !finalParams.model ||
                  finalParams.model === 'openai/gpt-oss-120b' ||
                  finalParams.model === 'default'
                ) {
                  finalParams.model = activeModel;
                }

                // Handle reasoning models like gpt-6-luna / o-series
                const modelStr = String(finalParams.model).toLowerCase();
                const isReasoningModel =
                  modelStr.startsWith('o1') ||
                  modelStr.startsWith('o3') ||
                  modelStr.startsWith('o4') ||
                  modelStr.includes('luna') ||
                  modelStr.includes('sol');

                if (isReasoningModel) {
                  delete finalParams.temperature;
                  delete finalParams.top_p;
                }

                // Map max_tokens -> max_completion_tokens (required for reasoning models & recommended for OpenAI)
                if (
                  finalParams.max_tokens !== undefined &&
                  finalParams.max_completion_tokens === undefined
                ) {
                  finalParams.max_completion_tokens = finalParams.max_tokens;
                  delete finalParams.max_tokens;
                }

                // Ensure reasoning models have enough headroom for internal reasoning tokens
                if (
                  isReasoningModel &&
                  finalParams.max_completion_tokens &&
                  finalParams.max_completion_tokens < 300
                ) {
                  finalParams.max_completion_tokens = 300;
                }

                return rawClient.chat.completions.create(finalParams);
              },
            },
          },
          raw: rawClient,
        };
        this.provider = 'openai';
        console.log(
          `✅ [LLMClient] Initialized OpenAI client (model: ${activeModel})`,
        );
      } else if (targetProvider === 'soclaas' && process.env.SOCLAAS_API_KEY) {
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
      } else if (targetProvider === 'groq' && process.env.GROQ_API_KEY) {
        this.client = new Groq({
          apiKey: process.env.GROQ_API_KEY,
        });
        this.provider = 'groq';
        console.log('Groq client initialized');
      } else {
        throw new Error(
          'Either OPENAI_API_KEY, SOCLAAS_API_KEY, or GROQ_API_KEY environment variable is required',
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
    let currentProvider = this.provider;
    if (!currentProvider) {
      try {
        currentProvider = this.getProvider();
      } catch (_err) {
        if (
          process.env.LLM_PROVIDER === 'openai' ||
          (process.env.NODE_ENV === 'production' && process.env.OPENAI_API_KEY)
        ) {
          return process.env.OPENAI_MODEL || 'gpt-6-luna';
        }
        if (process.env.SOCLAAS_API_KEY) {
          return process.env.SOCLAAS_MODEL || defaultFallback;
        }
        if (process.env.GROQ_API_KEY) {
          return process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
        }
        return defaultFallback;
      }
    }

    if (currentProvider === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-6-luna';
    }
    if (currentProvider === 'soclaas') {
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
