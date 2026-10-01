const { Groq } = require('groq-sdk');
const OpenAI = require('openai');

class GroqClientSingleton {
  constructor() {
    this.client = null;
    this.provider = null;
  }

  _isReasoningModel(model) {
    const modelStr = String(model || '').toLowerCase();
    return (
      modelStr.startsWith('o1') ||
      modelStr.startsWith('o3') ||
      modelStr.startsWith('o4') ||
      modelStr.includes('luna') ||
      modelStr.includes('sol')
    );
  }

  _normalizeOpenAIParams(params, activeModel) {
    // eslint-disable-next-line prefer-object-spread
    const finalParams = Object.assign({}, params);
    if (
      !finalParams.model ||
      finalParams.model === 'openai/gpt-oss-120b' ||
      finalParams.model === 'default'
    ) {
      finalParams.model = activeModel;
    }

    const isReasoningModel = this._isReasoningModel(finalParams.model);
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

    // Set an upper completion token limit in production to protect against credit burnout
    if (
      process.env.NODE_ENV === 'production' &&
      finalParams.max_completion_tokens === undefined
    ) {
      finalParams.max_completion_tokens = process.env.OPENAI_MAX_TOKENS
        ? Number(process.env.OPENAI_MAX_TOKENS)
        : 600;
    }

    // Ensure reasoning models have enough headroom for internal reasoning tokens
    if (
      isReasoningModel &&
      finalParams.max_completion_tokens &&
      finalParams.max_completion_tokens < 300
    ) {
      finalParams.max_completion_tokens = 300;
    }

    return finalParams;
  }

  _resolveProvider() {
    if (process.env.LLM_PROVIDER) {
      return process.env.LLM_PROVIDER.toLowerCase();
    }

    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      if (process.env.OPENAI_API_KEY) return 'openai';
      if (process.env.SOCLAAS_API_KEY) return 'soclaas';
      if (process.env.GROQ_API_KEY) return 'groq';
      return null;
    }

    if (process.env.SOCLAAS_API_KEY) return 'soclaas';
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.GROQ_API_KEY) return 'groq';
    return null;
  }

  _initOpenAI() {
    const rawClient = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      apiKey: process.env.OPENAI_API_KEY,
    });
    const activeModel = process.env.OPENAI_MODEL || 'gpt-6-luna';

    this.client = {
      chat: {
        completions: {
          create: (params) =>
            rawClient.chat.completions.create(
              this._normalizeOpenAIParams(params, activeModel),
            ),
        },
      },
      raw: rawClient,
    };
    this.provider = 'openai';
    console.log(
      `✅ [LLMClient] Initialized OpenAI client (model: ${activeModel})`,
    );
  }

  _initSoclaas() {
    const rawClient = new OpenAI({
      baseURL:
        process.env.SOCLAAS_BASE_URL ||
        'https://soclaas-api.comp.nus.edu.sg/v1',
      apiKey: process.env.SOCLAAS_API_KEY,
    });
    const activeModel = process.env.SOCLAAS_MODEL || 'default';

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
  }

  _initGroq() {
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    this.provider = 'groq';
    console.log('Groq client initialized');
  }

  getInstance() {
    if (!this.client) {
      const targetProvider = this._resolveProvider();

      if (targetProvider === 'openai' && process.env.OPENAI_API_KEY) {
        this._initOpenAI();
      } else if (targetProvider === 'soclaas' && process.env.SOCLAAS_API_KEY) {
        this._initSoclaas();
      } else if (targetProvider === 'groq' && process.env.GROQ_API_KEY) {
        this._initGroq();
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
        currentProvider = this._resolveProvider();
      }
    }

    if (currentProvider === 'openai') {
      return process.env.OPENAI_MODEL || 'gpt-6-luna';
    }
    if (currentProvider === 'soclaas') {
      return process.env.SOCLAAS_MODEL || defaultFallback;
    }
    if (currentProvider === 'groq') {
      return process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    }
    return defaultFallback;
  }

  reset() {
    this.client = null;
    this.provider = null;
    console.log('LLM client reset');
  }
}

const groqClient = new GroqClientSingleton();
module.exports = groqClient;
