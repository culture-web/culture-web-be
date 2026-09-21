const {
  createAdaptiveSessionState,
  getActiveConcept,
  recordAdaptiveAnswer,
  selectAdaptiveConcepts,
  shuffleGeneratedQuestionOptions,
  validateGeneratedQuestion,
} = require('../../services/adaptiveQuizService');

const policy = {
  version: 'test-policy',
  conceptLimit: 2,
  masteryStreak: 3,
  maxQuestions: 8,
};

const proficiencyStates = [
  {
    node_id: 'advanced_concept',
    bloom_level: '3_apply',
    misconception_flag: false,
    last_confidence: 0.9,
  },
  {
    node_id: 'misconception_concept',
    bloom_level: '2_understand',
    misconception_flag: true,
    last_confidence: 0.8,
  },
  {
    node_id: 'unseen_concept',
    bloom_level: '0_unseen',
    misconception_flag: false,
    last_confidence: 0.1,
  },
];

describe('adaptiveQuizService', () => {
  it('prioritizes misconceptions and then lower-evidence concepts', () => {
    const selected = selectAdaptiveConcepts(proficiencyStates, 2);

    expect(selected.map((state) => state.node_id)).toEqual([
      'misconception_concept',
      'unseen_concept',
    ]);
  });

  it('keeps the same concept active and resets its streak after an error', () => {
    const initial = createAdaptiveSessionState(proficiencyStates, policy);
    const concept = getActiveConcept(initial);
    const firstCorrect = recordAdaptiveAnswer(
      initial,
      concept.conceptId,
      true,
    ).sessionState;
    const afterError = recordAdaptiveAnswer(
      firstCorrect,
      concept.conceptId,
      false,
    ).sessionState;

    expect(afterError.activeConceptId).toBe(concept.conceptId);
    expect(getActiveConcept(afterError).consecutiveCorrect).toBe(0);
    expect(afterError.answeredCount).toBe(2);
    expect(afterError.correctCount).toBe(1);
  });

  it('moves to the next concept only after the configured evidence streak', () => {
    let state = createAdaptiveSessionState(proficiencyStates, policy);
    const firstConcept = getActiveConcept(state);

    for (let index = 0; index < policy.masteryStreak; index += 1) {
      state = recordAdaptiveAnswer(
        state,
        firstConcept.conceptId,
        true,
      ).sessionState;
    }

    expect(
      state.concepts.find(
        (concept) => concept.conceptId === firstConcept.conceptId,
      ).mastered,
    ).toBe(true);
    expect(state.activeConceptId).not.toBe(firstConcept.conceptId);
    expect(state.status).toBe('active');
  });

  it('completes when every selected concept meets the evidence streak', () => {
    let state = createAdaptiveSessionState(proficiencyStates, policy);

    state.concepts.forEach((concept) => {
      for (let index = 0; index < policy.masteryStreak; index += 1) {
        state = recordAdaptiveAnswer(
          state,
          concept.conceptId,
          true,
        ).sessionState;
      }
    });

    expect(state.status).toBe('completed');
    expect(state.completionReason).toBe('mastery_criterion_met');
  });

  it('stops at the safety limit without marking unmet concepts mastered', () => {
    const limitedPolicy = {
      version: policy.version,
      conceptLimit: policy.conceptLimit,
      masteryStreak: policy.masteryStreak,
      maxQuestions: 3,
    };
    let state = createAdaptiveSessionState(proficiencyStates, limitedPolicy);
    const { conceptId } = getActiveConcept(state);

    state = recordAdaptiveAnswer(state, conceptId, false).sessionState;
    state = recordAdaptiveAnswer(state, conceptId, false).sessionState;
    state = recordAdaptiveAnswer(state, conceptId, false).sessionState;

    expect(state.status).toBe('completed');
    expect(state.completionReason).toBe('maximum_questions_reached');
    expect(state.concepts.some((concept) => concept.mastered)).toBe(false);
  });

  it('rejects generated answers that do not exactly match an option', () => {
    const descriptor = {
      conceptId: 'paccha',
      targetLevel: '2_understand',
    };
    const result = validateGeneratedQuestion(
      {
        concept_id: 'paccha',
        target_level: '2_understand',
        question: 'What does Paccha represent?',
        options: ['A', 'B', 'C', 'D'],
        correctAnswer: 'E',
        explanation: 'Explanation',
      },
      descriptor,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/match an option/);
  });

  it('shuffles generated options without changing the authoritative answer', () => {
    const question = {
      question: 'Which option is correct?',
      options: ['Correct', 'Distractor 1', 'Distractor 2', 'Distractor 3'],
      correctAnswer: 'Correct',
      explanation: 'Correct is the keyed response.',
    };

    const shuffled = shuffleGeneratedQuestionOptions(question, () => 0);

    expect(shuffled.options).toEqual([
      'Distractor 1',
      'Distractor 2',
      'Distractor 3',
      'Correct',
    ]);
    expect(shuffled.correctAnswer).toBe('Correct');
    expect(shuffled.options).toContain(shuffled.correctAnswer);
    expect(question.options[0]).toBe('Correct');
  });
});
