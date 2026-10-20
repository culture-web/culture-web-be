const groqClient = require('../../client/groqClient');

describe('GroqClientSingleton / LLM Client Multi-Provider Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line prefer-object-spread
    process.env = Object.assign({}, originalEnv);
    delete process.env.SOCLAAS_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_PROVIDER;
    groqClient.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
    groqClient.reset();
  });

  test('prioritizes SoC LaaS in production when all keys are present (OpenAI as last resort)', () => {
    process.env.NODE_ENV = 'production';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('soclaas');
    expect(groqClient.getModel()).toBe('default');
  });

  test('prioritizes Groq over OpenAI when SoC LaaS key is absent', () => {
    process.env.NODE_ENV = 'production';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('groq');
    expect(groqClient.getModel()).toBe('openai/gpt-oss-120b');
  });

  test('uses OpenAI as last resort when only OPENAI_API_KEY is available', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const instance = groqClient.getInstance();
    expect(instance).toBeDefined();
    expect(groqClient.getProvider()).toBe('openai');
    expect(groqClient.getModel()).toBe('gpt-6-luna');
  });

  test('respects explicit LLM_PROVIDER override when its key is present', () => {
    process.env.NODE_ENV = 'development';
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';

    groqClient.getInstance();
    expect(groqClient.getProvider()).toBe('openai');
  });

  test('falls back to default priority if explicit LLM_PROVIDER key is missing', () => {
    process.env.NODE_ENV = 'production';
    process.env.LLM_PROVIDER = 'openai';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';

    groqClient.getInstance();
    expect(groqClient.getProvider()).toBe('soclaas');
  });

  test('automatically falls back to next provider at runtime when primary provider fails', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SOCLAAS_API_KEY = 'test-soclaas-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';

    const client = groqClient.getInstance();
    client.raw.chat.completions.create = jest
      .fn()
      .mockRejectedValue(new Error('Connection timeout'));

    const fallbackSpy = jest
      .spyOn(groqClient, '_createProviderRunner')
      .mockReturnValue({
        raw: {
          chat: {
            completions: {
              create: jest.fn().mockResolvedValue({
                model: 'gpt-6-luna',
                choices: [{ message: { content: 'fallback response' } }],
              }),
            },
          },
        },
        activeModel: 'gpt-6-luna',
        normalize: (p) => p,
      });

    const result = await client.chat.completions.create({
      model: 'default',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(fallbackSpy).toHaveBeenCalledWith('openai');
    expect(result.choices[0].message.content).toBe('fallback response');
    fallbackSpy.mockRestore();
  });

  const runMockCompletion = async (model, inputParams, envOverrides = {}) => {
    // eslint-disable-next-line prefer-object-spread
    process.env = Object.assign(
      {},
      originalEnv,
      {
        NODE_ENV: 'production',
        LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-openai-key',
        OPENAI_MODEL: model,
      },
      envOverrides,
    );
    delete process.env.SOCLAAS_API_KEY;
    delete process.env.GROQ_API_KEY;

    const client = groqClient.getInstance();
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'test response' } }],
    });
    client.raw.chat.completions.create = mockCreate;

    // eslint-disable-next-line prefer-object-spread
    const requestPayload = Object.assign(
      { model, messages: [{ role: 'user', content: 'test' }] },
      inputParams,
    );
    await client.chat.completions.create(requestPayload);
    return mockCreate.mock.calls[0][0];
  };

  test('normalizes parameters for reasoning models (e.g., gpt-6-luna)', async () => {
    const passed = await runMockCompletion('gpt-6-luna', {
      max_tokens: 100,
      temperature: 0.7,
      top_p: 0.9,
    });

    expect(passed.temperature).toBeUndefined();
    expect(passed.top_p).toBeUndefined();
    expect(passed.max_tokens).toBeUndefined();
    expect(passed.max_completion_tokens).toBe(300);
  });

  test('preserves temperature and maps max_tokens for non-reasoning models (e.g. gpt-4o-mini)', async () => {
    const passed = await runMockCompletion('gpt-4o-mini', {
      max_tokens: 1500,
      temperature: 0.7,
    });

    expect(passed.temperature).toBe(0.7);
    expect(passed.max_tokens).toBeUndefined();
    expect(passed.max_completion_tokens).toBe(1500);
  });

  test('enforces default 600 max_completion_tokens in production when unspecified', async () => {
    const passed = await runMockCompletion('gpt-4o-mini', {});
    expect(passed.max_completion_tokens).toBe(600);
  });

  test('respects custom OPENAI_MAX_TOKENS in production when unspecified by caller', async () => {
    const passed = await runMockCompletion(
      'gpt-4o-mini',
      {},
      { OPENAI_MAX_TOKENS: '850' },
    );
    expect(passed.max_completion_tokens).toBe(850);
  });

  test('preserves explicit caller max_tokens in production without overriding with 600', async () => {
    const passed = await runMockCompletion('gpt-4o-mini', {
      max_tokens: 2000,
    });
    expect(passed.max_completion_tokens).toBe(2000);
  });

  test('does not enforce completion token cap when not in production environment', async () => {
    const passed = await runMockCompletion(
      'gpt-4o-mini',
      {},
      { NODE_ENV: 'development', LLM_PROVIDER: 'openai' },
    );
    expect(passed.max_completion_tokens).toBeUndefined();
  });
});
