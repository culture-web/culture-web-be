/* eslint-disable node/no-unsupported-features/es-syntax */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

// Mock @xenova/transformers to avoid ES module issues
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn(() =>
    Promise.resolve({
      encode: jest.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
    }),
  ),
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
  },
}));

jest.mock('../../client/supabaseClient', () => ({
  from: jest.fn(),
}));

jest.mock('../../client/groqClient', () => ({
  getInstance: jest.fn(),
  getModel: jest.fn(() => 'test-model'),
  getProvider: jest.fn(() => 'groq'),
}));

const httpMocks = require('node-mocks-http');
const supabase = require('../../client/supabaseClient');
const groqClient = require('../../client/groqClient');
const {
  startAdaptiveQuiz,
  answerAdaptiveQuizQuestion,
  getAdaptiveQuizCurrent,
} = require('../../controllers/kathakaliController');

describe('Adaptive Quiz Controller Endpoints', () => {
  let req;
  let res;
  let mockGroqInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    res = httpMocks.createResponse();
    mockGroqInstance = {
      chat: {
        completions: {
          create: jest.fn(),
        },
      },
    };
    groqClient.getInstance.mockReturnValue(mockGroqInstance);
  });

  const createChainableUpdate = () => {
    const chain = {};
    chain.eq = jest.fn().mockReturnValue(chain);
    chain.then = (resolve) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  };

  const buildQuizFixtures = ({
    answeredCount = 0,
    consecutiveCorrect = 0,
    questionId = 'question-uuid-1',
    userAnswer = 'Paccha',
    responseMs = 1200,
  } = {}) => {
    const sessionRow = {
      id: 'session-uuid-1',
      user_id: 'user-123',
      status: 'active',
      session_state: {
        status: 'active',
        answeredCount,
        correctCount: answeredCount,
        masteryStreak: 3,
        maxQuestions: 12,
        activeConceptId: 'paccha_concept',
        policyVersion: 'sequential-mastery-v1',
        concepts: [
          {
            conceptId: 'paccha_concept',
            currentLevel: '1_remember',
            targetLevel: '2_understand',
            attempts: answeredCount,
            correct: answeredCount,
            consecutiveCorrect,
            mastered: false,
            misconception: false,
          },
        ],
      },
    };

    const questionRow = {
      id: questionId,
      quiz_id: 'session-uuid-1',
      concept_id: 'paccha_concept',
      target_level: '2_understand',
      misconception_target: false,
      question: 'Which character type features green makeup?',
      options: ['Paccha', 'Kathi', 'Thaadi', 'Minukku'],
      correct_answer: 'Paccha',
      explanation: 'Paccha characters portray divine virtues.',
      answered_at: null,
    };

    const answeredQuestionRow = {
      ...questionRow,
      selected_answer: userAnswer,
      is_correct: userAnswer === questionRow.correct_answer,
      response_ms: responseMs,
      answered_at: '2026-09-30T10:00:00.000Z',
    };

    return { sessionRow, questionRow, answeredQuestionRow };
  };

  const mockSupabaseAnswerFlow = ({
    sessionRow,
    questionRow,
    answeredQuestionRow,
    nextQuestionRow = null,
    proficiencyRow = null,
    upsertFn = jest.fn(),
  }) => {
    supabase.from.mockImplementation((tableName) => {
      if (tableName === 'quiz_session') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: sessionRow,
            error: null,
          }),
          update: jest.fn().mockImplementation(() => createChainableUpdate()),
        };
      }
      if (tableName === 'quiz_question') {
        const query = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: questionRow,
            error: null,
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: answeredQuestionRow,
              error: null,
            }),
          }),
        };
        if (nextQuestionRow) {
          query.insert = jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
              data: nextQuestionRow,
              error: null,
            }),
          });
        }
        return query;
      }
      if (tableName === 'user_proficiency_state') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: proficiencyRow,
            error: null,
          }),
          upsert: upsertFn,
        };
      }
      return {};
    });
  };

  describe('POST /kathakali/generate-adaptive-quiz', () => {
    beforeEach(() => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'user-123' },
        body: {},
      });
    });

    test('returns 404 when user has no tracked proficiency profile', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ data: [], error: null }),
      };
      supabase.from.mockReturnValue(mockQuery);

      await startAdaptiveQuiz(req, res);

      expect(res.statusCode).toBe(404);
      const data = res._getJSONData();
      expect(data.error).toMatch(/No proficiency data found/i);
    });

    test('returns 500 when database error occurs during proficiency lookup', async () => {
      const mockQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest
          .fn()
          .mockResolvedValue({ data: null, error: new Error('DB timeout') }),
      };
      supabase.from.mockReturnValue(mockQuery);

      await startAdaptiveQuiz(req, res);

      expect(res.statusCode).toBe(500);
      const data = res._getJSONData();
      expect(data.error).toBe('Failed to fetch proficiency data');
    });

    test('returns 201 with public question (correct answer redacted) and progress tracking', async () => {
      const proficiencyData = [
        {
          node_id: 'paccha_concept',
          bloom_level: '1_remember',
          misconception_flag: false,
          last_confidence: 0.9,
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ];

      mockGroqInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                concept_id: 'paccha_concept',
                target_level: '2_understand',
                question: 'Which character type features green makeup?',
                options: ['Paccha', 'Kathi', 'Thaadi', 'Minukku'],
                correctAnswer: 'Paccha',
                explanation: 'Paccha characters portray divine virtues.',
              }),
            },
          },
        ],
      });

      supabase.from.mockImplementation((tableName) => {
        if (tableName === 'user_proficiency_state') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest
              .fn()
              .mockResolvedValue({ data: proficiencyData, error: null }),
          };
        }
        if (tableName === 'quiz_session') {
          return {
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
              data: {
                id: 'session-uuid-1',
                created_at: '2026-09-30T10:00:00.000Z',
              },
              error: null,
            }),
          };
        }
        if (tableName === 'quiz_question') {
          return {
            insert: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({
              data: {
                id: 'question-uuid-1',
                sequence_no: 1,
                concept_id: 'paccha_concept',
                target_level: '2_understand',
                misconception_target: false,
                question: 'Which character type features green makeup?',
                options: ['Paccha', 'Kathi', 'Thaadi', 'Minukku'],
                correct_answer: 'Paccha',
                explanation: 'Paccha characters portray divine virtues.',
                selected_answer: null,
                is_correct: null,
                response_ms: null,
                answered_at: null,
              },
              error: null,
            }),
          };
        }
        return {};
      });

      await startAdaptiveQuiz(req, res);

      expect(res.statusCode).toBe(201);
      const data = res._getJSONData();
      expect(data.quizId).toBe('session-uuid-1');
      expect(data.question.backendQuestionId).toBe('question-uuid-1');
      expect(data.question.question).toBe(
        'Which character type features green makeup?',
      );
      expect(data.question.correct_answer).toBeUndefined();
      expect(data.question.correctAnswer).toBeUndefined();
      expect(data.question.explanation).toBeUndefined();
      expect(data.progress.activeConcept).toBe('paccha_concept');
      expect(data.progress.currentStreak).toBe(0);
    });
  });

  describe('POST /kathakali/quiz/:quizId/answer', () => {
    test('returns 400 when required payload parameters are missing', async () => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'user-123' },
        params: { quizId: 'session-uuid-1' },
        body: {},
      });

      await answerAdaptiveQuizQuestion(req, res);

      expect(res.statusCode).toBe(400);
      const data = res._getJSONData();
      expect(data.error).toMatch(
        /questionId and a non-empty answer are required/i,
      );
    });

    test('returns 403 when session belongs to a different authenticated user', async () => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'impostor-user' },
        params: { quizId: 'session-uuid-1' },
        body: { questionId: 'question-uuid-1', answer: 'Paccha' },
      });

      supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: { id: 'session-uuid-1', user_id: 'real-user-123' },
          error: null,
        }),
      });

      await answerAdaptiveQuizQuestion(req, res);

      expect(res.statusCode).toBe(403);
      const data = res._getJSONData();
      expect(data.error).toBe('Forbidden');
    });

    test('returns 409 when quiz session has already completed', async () => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'user-123' },
        params: { quizId: 'session-uuid-1' },
        body: { questionId: 'question-uuid-1', answer: 'Paccha' },
      });

      supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'session-uuid-1',
            user_id: 'user-123',
            status: 'completed',
            session_state: {
              status: 'completed',
              answeredCount: 3,
              correctCount: 3,
              masteryStreak: 3,
              maxQuestions: 12,
              concepts: [
                {
                  conceptId: 'paccha_concept',
                  consecutiveCorrect: 3,
                  mastered: true,
                },
              ],
            },
          },
          error: null,
        }),
      });

      await answerAdaptiveQuizQuestion(req, res);

      expect(res.statusCode).toBe(409);
      const data = res._getJSONData();
      expect(data.error).toBe('Quiz session is already completed');
    });

    test('grades correctly: intermediate streak (1/3) does NOT write to user_proficiency_state', async () => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'user-123' },
        params: { quizId: 'session-uuid-1' },
        body: {
          questionId: 'question-uuid-1',
          answer: 'Paccha',
          responseMs: 1200,
        },
      });

      const { sessionRow, questionRow, answeredQuestionRow } =
        buildQuizFixtures({
          answeredCount: 0,
          consecutiveCorrect: 0,
          questionId: 'question-uuid-1',
        });

      const nextQuestionRow = {
        id: 'question-uuid-2',
        sequence_no: 2,
        concept_id: 'paccha_concept',
        target_level: '2_understand',
        misconception_target: false,
        question: 'What emotion is expressed by Paccha?',
        options: ['Shringara', 'Raudra', 'Bibhatsa', 'Bhayanaka'],
        correct_answer: 'Shringara',
        explanation: 'Noble heroes frequently depict serene devotion.',
        selected_answer: null,
        is_correct: null,
        response_ms: null,
        answered_at: null,
      };

      mockGroqInstance.chat.completions.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                concept_id: 'paccha_concept',
                target_level: '2_understand',
                question: 'What emotion is expressed by Paccha?',
                options: ['Shringara', 'Raudra', 'Bibhatsa', 'Bhayanaka'],
                correctAnswer: 'Shringara',
                explanation: 'Noble heroes frequently depict serene devotion.',
              }),
            },
          },
        ],
      });

      const upsertSpy = jest.fn();
      mockSupabaseAnswerFlow({
        sessionRow,
        questionRow,
        answeredQuestionRow,
        nextQuestionRow,
        upsertFn: upsertSpy,
      });

      await answerAdaptiveQuizQuestion(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.result.correct).toBe(true);
      expect(data.result.correctAnswer).toBe('Paccha');
      expect(data.progress.currentStreak).toBe(1);
      expect(data.proficiencyUpdatesApplied).toHaveLength(0);
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    test('mastery streak (3/3) writes elevated level to user_proficiency_state', async () => {
      req = httpMocks.createRequest({
        method: 'POST',
        user: { id: 'user-123' },
        params: { quizId: 'session-uuid-1' },
        body: {
          questionId: 'question-uuid-3',
          answer: 'Paccha',
          responseMs: 1500,
        },
      });

      const { sessionRow, questionRow, answeredQuestionRow } =
        buildQuizFixtures({
          answeredCount: 2,
          consecutiveCorrect: 2,
          questionId: 'question-uuid-3',
          responseMs: 1500,
        });

      const upsertMock = jest
        .fn()
        .mockResolvedValue({ data: null, error: null });

      mockSupabaseAnswerFlow({
        sessionRow,
        questionRow,
        answeredQuestionRow,
        proficiencyRow: {
          bloom_level: '1_remember',
          misconception_flag: false,
        },
        upsertFn: upsertMock,
      });

      await answerAdaptiveQuizQuestion(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.result.correct).toBe(true);
      expect(data.progress.completed).toBe(true);
      expect(data.progress.masteredConcepts).toBe(1);
      expect(data.proficiencyUpdatesApplied).toEqual([
        {
          conceptId: 'paccha_concept',
          previousLevel: '1_remember',
          newLevel: '2_understand',
          misconceptionCleared: false,
        },
      ]);
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          node_id: 'paccha_concept',
          bloom_level: '2_understand',
          misconception_flag: false,
        }),
        { onConflict: 'user_id,node_id' },
      );
    });
  });

  describe('GET /kathakali/quiz/:quizId/current', () => {
    test('returns question: null when session is completed', async () => {
      req = httpMocks.createRequest({
        method: 'GET',
        user: { id: 'user-123' },
        params: { quizId: 'session-uuid-1' },
      });

      supabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: {
            id: 'session-uuid-1',
            user_id: 'user-123',
            status: 'completed',
            session_state: {
              status: 'completed',
              completionReason: 'mastery_criterion_met',
              answeredCount: 3,
              correctCount: 3,
              masteryStreak: 3,
              maxQuestions: 12,
              concepts: [
                {
                  conceptId: 'paccha_concept',
                  consecutiveCorrect: 3,
                  mastered: true,
                },
              ],
            },
          },
          error: null,
        }),
      });

      await getAdaptiveQuizCurrent(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.quizId).toBe('session-uuid-1');
      expect(data.question).toBeNull();
      expect(data.progress.completed).toBe(true);
    });
  });
});
