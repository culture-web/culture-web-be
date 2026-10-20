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

  _isOpenAIModel(model) {
    const modelStr = String(model || '').toLowerCase();
    return (
      this._isReasoningModel(modelStr) ||
      modelStr.startsWith('gpt-') ||
      (Boolean(process.env.OPENAI_MODEL) &&
        modelStr === String(process.env.OPENAI_MODEL).toLowerCase())
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

  _normalizeSoclaasParams(params, activeModel) {
    // eslint-disable-next-line prefer-object-spread
    const finalParams = Object.assign({}, params);
    if (
      !finalParams.model ||
      finalParams.model === 'openai/gpt-oss-120b' ||
      this._isOpenAIModel(finalParams.model)
    ) {
      finalParams.model = activeModel;
    }
    return finalParams;
  }

  _normalizeGroqParams(params, activeModel) {
    // eslint-disable-next-line prefer-object-spread
    const finalParams = Object.assign({}, params);
    if (
      !finalParams.model ||
      finalParams.model === 'default' ||
      finalParams.model === process.env.SOCLAAS_MODEL ||
      this._isOpenAIModel(finalParams.model)
    ) {
      finalParams.model = activeModel;
    }
    return finalParams;
  }

  _hasProviderKey(provider) {
    if (provider === 'soclaas') return Boolean(process.env.SOCLAAS_API_KEY);
    if (provider === 'groq') return Boolean(process.env.GROQ_API_KEY);
    if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
    return false;
  }

  _resolveProvider() {
    if (process.env.LLM_PROVIDER) {
      const explicitProvider = process.env.LLM_PROVIDER.toLowerCase();
      if (this._hasProviderKey(explicitProvider)) {
        return explicitProvider;
      }
    }

    // Default priority across all environments: SoC LaaS -> Groq -> OpenAI (last resort)
    if (process.env.SOCLAAS_API_KEY) return 'soclaas';
    if (process.env.GROQ_API_KEY) return 'groq';
    if (process.env.OPENAI_API_KEY) return 'openai';
    return null;
  }

  _getFallbackProviders(primaryProvider) {
    const priorityOrder = ['soclaas', 'groq', 'openai'];
    return priorityOrder.filter(
      (provider) =>
        provider !== primaryProvider && this._hasProviderKey(provider),
    );
  }

  _createProviderRunner(provider) {
    if (provider === 'soclaas') {
      const rawClient = new OpenAI({
        baseURL:
          process.env.SOCLAAS_BASE_URL ||
          'https://soclaas-api.comp.nus.edu.sg/v1',
        apiKey: process.env.SOCLAAS_API_KEY,
      });
      const activeModel = process.env.SOCLAAS_MODEL || 'default';
      return {
        raw: rawClient,
        activeModel,
        normalize: (params) =>
          this._normalizeSoclaasParams(params, activeModel),
      };
    }

    if (provider === 'openai') {
      const rawClient = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || undefined,
        apiKey: process.env.OPENAI_API_KEY,
      });
      const activeModel = process.env.OPENAI_MODEL || 'gpt-6-luna';
      return {
        raw: rawClient,
        activeModel,
        normalize: (params) => this._normalizeOpenAIParams(params, activeModel),
      };
    }

    const rawClient = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    const activeModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    return {
      raw: rawClient,
      activeModel,
      normalize: (params) => this._normalizeGroqParams(params, activeModel),
    };
  }

  async _attemptFallbacks(primaryProvider, params, primaryErr) {
    const fallbacks = this._getFallbackProviders(primaryProvider);
    for (let i = 0; i < fallbacks.length; i += 1) {
      const fallbackProvider = fallbacks[i];
      try {
        console.warn(
          `⚠️ [LLMClient] Primary provider '${primaryProvider}' failed (${primaryErr.message}). Falling back to '${fallbackProvider}'...`,
        );
        const fallbackRunner = this._createProviderRunner(fallbackProvider);
        // eslint-disable-next-line no-await-in-loop
        return await fallbackRunner.raw.chat.completions.create(
          fallbackRunner.normalize(params),
        );
      } catch (fallbackErr) {
        console.warn(
          `⚠️ [LLMClient] Fallback provider '${fallbackProvider}' also failed (${fallbackErr.message}).`,
        );
      }
    }
    throw primaryErr;
  }

  _buildClientWithFallback(primaryProvider) {
    const runner = this._createProviderRunner(primaryProvider);
    const clientWrapper = {
      chat: {
        completions: {
          create: async (params) => {
            try {
              return await clientWrapper.raw.chat.completions.create(
                runner.normalize(params),
              );
            } catch (primaryErr) {
              return this._attemptFallbacks(
                primaryProvider,
                params,
                primaryErr,
              );
            }
          },
        },
      },
      raw: runner.raw,
    };
    return { clientWrapper, activeModel: runner.activeModel };
  }

  _initOpenAI() {
    const { clientWrapper, activeModel } =
      this._buildClientWithFallback('openai');
    this.client = clientWrapper;
    this.provider = 'openai';
    console.log(
      `✅ [LLMClient] Initialized OpenAI client (model: ${activeModel})`,
    );
  }

  _initSoclaas() {
    const { clientWrapper, activeModel } =
      this._buildClientWithFallback('soclaas');
    this.client = clientWrapper;
    this.provider = 'soclaas';
    console.log(
      `✅ [LLMClient] Initialized NUS SoC LaaS client (model: ${activeModel})`,
    );
  }

  _initGroq() {
    const { clientWrapper } = this._buildClientWithFallback('groq');
    this.client = clientWrapper;
    this.provider = 'groq';
    console.log('Groq client initialized');
  }

  getInstance() {
    if (!this.client) {
      const targetProvider = this._resolveProvider();

      if (targetProvider === 'soclaas' && process.env.SOCLAAS_API_KEY) {
        this._initSoclaas();
      } else if (targetProvider === 'groq' && process.env.GROQ_API_KEY) {
        this._initGroq();
      } else if (targetProvider === 'openai' && process.env.OPENAI_API_KEY) {
        this._initOpenAI();
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
