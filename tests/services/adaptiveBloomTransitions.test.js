/* eslint-disable node/no-unsupported-features/es-syntax */
const {
  getNextBloomLevel,
  createAdaptiveSessionState,
  getActiveConcept,
  recordAdaptiveAnswer,
} = require('../../services/adaptiveQuizService');

describe('Adaptive Quiz Bloom Transitions & Progression Logic', () => {
  const defaultPolicy = {
    version: 'sequential-mastery-v1',
    conceptLimit: 2,
    masteryStreak: 3,
    maxQuestions: 12,
  };

  describe('getNextBloomLevel', () => {
    test('advances correctly across all Bloom levels', () => {
      expect(getNextBloomLevel('0_unseen')).toBe('1_remember');
      expect(getNextBloomLevel('1_remember')).toBe('2_understand');
      expect(getNextBloomLevel('2_understand')).toBe('3_apply');
      expect(getNextBloomLevel('3_apply')).toBe('4_analyze');
    });

    test('clamps at 4_analyze ceiling', () => {
      expect(getNextBloomLevel('4_analyze')).toBe('4_analyze');
    });

    test('falls back gracefully to 1_remember for invalid Bloom strings', () => {
      expect(getNextBloomLevel('invalid_level')).toBe('1_remember');
      expect(getNextBloomLevel(null)).toBe('1_remember');
      expect(getNextBloomLevel(undefined)).toBe('1_remember');
    });
  });

  describe('Concept Selection & Misconception Clamping', () => {
    test('clamps targetLevel to currentLevel when misconception_flag is true (remediation mode)', () => {
      const proficiency = [
        {
          node_id: 'concept_misconception',
          bloom_level: '2_understand',
          misconception_flag: true,
          last_confidence: 0.8,
        },
      ];
      const session = createAdaptiveSessionState(proficiency, defaultPolicy);
      const active = getActiveConcept(session);

      expect(active.conceptId).toBe('concept_misconception');
      expect(active.currentLevel).toBe('2_understand');
      expect(active.targetLevel).toBe('2_understand'); // clamped, not 3_apply
      expect(active.misconception).toBe(true);
    });

    test('advances targetLevel to getNextBloomLevel when misconception_flag is false', () => {
      const proficiency = [
        {
          node_id: 'concept_standard',
          bloom_level: '2_understand',
          misconception_flag: false,
          last_confidence: 0.8,
        },
      ];
      const session = createAdaptiveSessionState(proficiency, defaultPolicy);
      const active = getActiveConcept(session);

      expect(active.conceptId).toBe('concept_standard');
      expect(active.currentLevel).toBe('2_understand');
      expect(active.targetLevel).toBe('3_apply');
      expect(active.misconception).toBe(false);
    });
  });

  describe('Streak Mechanics & Reset', () => {
    test('resets streak to 0 upon incorrect answer without demoting Bloom level', () => {
      const proficiency = [
        {
          node_id: 'paccha_concept',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
      ];
      let { sessionState } = {
        sessionState: createAdaptiveSessionState(proficiency, defaultPolicy),
      };

      // Q1 Correct -> streak 1
      sessionState = recordAdaptiveAnswer(
        sessionState,
        'paccha_concept',
        true,
      ).sessionState;
      expect(getActiveConcept(sessionState).consecutiveCorrect).toBe(1);

      // Q2 Correct -> streak 2
      sessionState = recordAdaptiveAnswer(
        sessionState,
        'paccha_concept',
        true,
      ).sessionState;
      expect(getActiveConcept(sessionState).consecutiveCorrect).toBe(2);

      // Q3 Incorrect -> streak resets to 0
      sessionState = recordAdaptiveAnswer(
        sessionState,
        'paccha_concept',
        false,
      ).sessionState;
      const active = getActiveConcept(sessionState);
      expect(active.consecutiveCorrect).toBe(0);
      expect(active.currentLevel).toBe('1_remember');
      expect(active.targetLevel).toBe('2_understand');
      expect(active.mastered).toBe(false);
    });

    test('triggers mastery only after 3 consecutive correct answers', () => {
      const proficiency = [
        {
          node_id: 'paccha_concept',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
      ];
      let state = createAdaptiveSessionState(proficiency, defaultPolicy);

      // Answer 1 & 2 correct
      state = recordAdaptiveAnswer(state, 'paccha_concept', true).sessionState;
      state = recordAdaptiveAnswer(state, 'paccha_concept', true).sessionState;

      // Answer 3 correct -> mastery
      const result = recordAdaptiveAnswer(state, 'paccha_concept', true);
      expect(result.newlyMastered).toBe(true);
      expect(result.masteredConcept.conceptId).toBe('paccha_concept');
      expect(result.sessionState.status).toBe('completed');
      expect(result.sessionState.completionReason).toBe(
        'mastery_criterion_met',
      );
    });
  });

  describe('Multi-Concept Transitions & Progression Across Sessions', () => {
    test('transitions to next concept when first concept is mastered in same session', () => {
      const proficiency = [
        {
          node_id: 'concept_a',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
        {
          node_id: 'concept_b',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
      ];
      let state = createAdaptiveSessionState(proficiency, defaultPolicy);

      // Master concept_a (3 correct)
      state = recordAdaptiveAnswer(state, 'concept_a', true).sessionState;
      state = recordAdaptiveAnswer(state, 'concept_a', true).sessionState;
      const masteryA = recordAdaptiveAnswer(state, 'concept_a', true);
      expect(masteryA.newlyMastered).toBe(true);

      // Active concept now shifts to concept_b with streak 0
      state = masteryA.sessionState;
      expect(state.status).toBe('active');
      const activeB = getActiveConcept(state);
      expect(activeB.conceptId).toBe('concept_b');
      expect(activeB.consecutiveCorrect).toBe(0);

      // Master concept_b (3 correct)
      state = recordAdaptiveAnswer(state, 'concept_b', true).sessionState;
      state = recordAdaptiveAnswer(state, 'concept_b', true).sessionState;
      const masteryB = recordAdaptiveAnswer(state, 'concept_b', true);
      expect(masteryB.newlyMastered).toBe(true);
      expect(masteryB.sessionState.status).toBe('completed');
      expect(masteryB.sessionState.completionReason).toBe(
        'mastery_criterion_met',
      );
    });

    test('cross-session elevation: mastering Level 1 elevates Session 2 starting target to Level 2', () => {
      // Session 1: learner starts at 0_unseen
      const session1Initial = [
        {
          node_id: 'paccha_concept',
          bloom_level: '0_unseen',
          misconception_flag: false,
        },
      ];
      const session1State = createAdaptiveSessionState(
        session1Initial,
        defaultPolicy,
      );
      const s1Concept = getActiveConcept(session1State);
      expect(s1Concept.currentLevel).toBe('0_unseen');
      expect(s1Concept.targetLevel).toBe('1_remember');

      // Learner completes Session 1 -> DB updates paccha_concept to 1_remember
      const session2Initial = [
        {
          node_id: 'paccha_concept',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
      ];
      const session2State = createAdaptiveSessionState(
        session2Initial,
        defaultPolicy,
      );
      const s2Concept = getActiveConcept(session2State);

      // Session 2 now targets 2_understand
      expect(s2Concept.currentLevel).toBe('1_remember');
      expect(s2Concept.targetLevel).toBe('2_understand');
    });

    test('safety question ceiling terminates session without false mastery', () => {
      const policyWithLowCeiling = {
        ...defaultPolicy,
        maxQuestions: 4,
        conceptLimit: 1,
      };
      const proficiency = [
        {
          node_id: 'concept_struggling',
          bloom_level: '1_remember',
          misconception_flag: false,
        },
      ];
      let state = createAdaptiveSessionState(proficiency, policyWithLowCeiling);

      // Alternate correct and incorrect answers 4 times
      state = recordAdaptiveAnswer(
        state,
        'concept_struggling',
        true,
      ).sessionState;
      state = recordAdaptiveAnswer(
        state,
        'concept_struggling',
        false,
      ).sessionState;
      state = recordAdaptiveAnswer(
        state,
        'concept_struggling',
        true,
      ).sessionState;
      const finalResult = recordAdaptiveAnswer(
        state,
        'concept_struggling',
        false,
      );

      expect(finalResult.newlyMastered).toBe(false);
      expect(finalResult.sessionState.status).toBe('completed');
      expect(finalResult.sessionState.completionReason).toBe(
        'maximum_questions_reached',
      );
      expect(finalResult.sessionState.answeredCount).toBe(4);
    });
  });
});
