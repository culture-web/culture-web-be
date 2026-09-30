const groqClient = require('../../client/groqClient');

describe('GroqClientSingleton / LLM Client Multi-Provider Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line prefer-object-spread
    process.env = Object.assign({}, originalEnv);
    groqClient.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
    groqClient.reset();
  });

  test('prioritizes OpenAI in production environment when OPENAI_API_KEY is present', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';
    delete process.env.LLM_PROVIDER;

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('openai');
    expect(groqClient.getModel()).toBe('gpt-6-luna');
  });

  test('prioritizes SoC LaaS in development environment when both keys are present', () => {
    process.env.NODE_ENV = 'development';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';
    delete process.env.LLM_PROVIDER;

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('soclaas');
  });

  test('respects explicit LLM_PROVIDER override regardless of NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';

    groqClient.getInstance();
    expect(groqClient.getProvider()).toBe('openai');
  });

  test('falls back to Groq when only GROQ_API_KEY is available', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.SOCLAAS_API_KEY;
    delete process.env.LLM_PROVIDER;
    process.env.GROQ_API_KEY = 'test-groq-key';

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('groq');
    expect(groqClient.getModel()).toBe('openai/gpt-oss-120b');
  });

  test('normalizes parameters for reasoning models (e.g., gpt-6-luna)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-6-luna';

    const client = groqClient.getInstance();

    // Mock the underlying rawClient create
    client.raw.chat.completions.create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'test response' } }],
    });

    await client.chat.completions.create({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
    });

    expect(client.raw.chat.completions.create).toHaveBeenCalledTimes(1);
    const passedParams = client.raw.chat.completions.create.mock.calls[0][0];

    // Temperature and top_p should be removed for reasoning models
    expect(passedParams.temperature).toBeUndefined();
    expect(passedParams.top_p).toBeUndefined();
    // max_tokens should be mapped to max_completion_tokens and clamped to minimum 300
    expect(passedParams.max_tokens).toBeUndefined();
    expect(passedParams.max_completion_tokens).toBe(300);
  });

  test('preserves temperature and maps max_tokens for non-reasoning models (e.g. gpt-4o-mini)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';

    const client = groqClient.getInstance();

    client.raw.chat.completions.create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'test response' } }],
    });

    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1500,
      temperature: 0.7,
    });

    expect(client.raw.chat.completions.create).toHaveBeenCalledTimes(1);
    const passedParams = client.raw.chat.completions.create.mock.calls[0][0];

    expect(passedParams.temperature).toBe(0.7);
    expect(passedParams.max_tokens).toBeUndefined();
    expect(passedParams.max_completion_tokens).toBe(1500);
  });
});
