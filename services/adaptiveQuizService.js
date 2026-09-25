const {
  bloomToNumber,
  numberToBloom,
  validBloomLevels,
} = require('../utils/kathakaliUtils');

const POLICY_VERSION = 'sequential-mastery-v1';
const DEFAULT_CONCEPT_LIMIT = 2;
const DEFAULT_MASTERY_STREAK = 3;
const DEFAULT_MAX_QUESTIONS = 12;

const parseBoundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const getAdaptiveQuizPolicy = () => ({
  version: POLICY_VERSION,
  conceptLimit: parseBoundedInteger(
    process.env.ADAPTIVE_QUIZ_CONCEPT_LIMIT,
    DEFAULT_CONCEPT_LIMIT,
    1,
    5,
  ),
  masteryStreak: parseBoundedInteger(
    process.env.ADAPTIVE_QUIZ_MASTERY_STREAK,
    DEFAULT_MASTERY_STREAK,
    1,
    5,
  ),
  maxQuestions: parseBoundedInteger(
    process.env.ADAPTIVE_QUIZ_MAX_QUESTIONS,
    DEFAULT_MAX_QUESTIONS,
    3,
    30,
  ),
});

const normalizeBloomLevel = (level) =>
  validBloomLevels.has(level) ? level : '0_unseen';

const getNextBloomLevel = (level) =>
  numberToBloom(Math.min(4, bloomToNumber(normalizeBloomLevel(level)) + 1));

const selectAdaptiveConcepts = (proficiencyStates, conceptLimit) =>
  [...(proficiencyStates || [])]
    .sort((a, b) => {
      const misconceptionDifference =
        Number(Boolean(b.misconception_flag)) -
        Number(Boolean(a.misconception_flag));
      if (misconceptionDifference !== 0) return misconceptionDifference;

      const bloomDifference =
        bloomToNumber(normalizeBloomLevel(a.bloom_level)) -
        bloomToNumber(normalizeBloomLevel(b.bloom_level));
      if (bloomDifference !== 0) return bloomDifference;

      const confidenceDifference =
        Number(a.last_confidence || 0) - Number(b.last_confidence || 0);
      if (confidenceDifference !== 0) return confidenceDifference;

      return String(a.node_id).localeCompare(String(b.node_id));
    })
    .slice(0, conceptLimit);

const buildConceptState = (state) => {
  const currentLevel = normalizeBloomLevel(state.bloom_level);
  const misconception = Boolean(state.misconception_flag);

  return {
    conceptId: String(state.node_id),
    currentLevel,
    // This transition is an explicit project hypothesis. It is logged and
    // configurable at the policy level rather than delegated to the LLM.
    targetLevel: misconception ? currentLevel : getNextBloomLevel(currentLevel),
    misconception,
    priorConfidence: Number(state.last_confidence || 0),
    priorEvidence: state.last_evidence || null,
    attempts: 0,
    correct: 0,
    consecutiveCorrect: 0,
    mastered: false,
  };
};

const createAdaptiveSessionState = (proficiencyStates, policy) => {
  const selected = selectAdaptiveConcepts(
    proficiencyStates,
    policy.conceptLimit,
  );

  return {
    policyVersion: policy.version,
    masteryStreak: policy.masteryStreak,
    maxQuestions: policy.maxQuestions,
    answeredCount: 0,
    correctCount: 0,
    status: 'active',
    completionReason: null,
    activeConceptId: selected[0]?.node_id || null,
    concepts: selected.map(buildConceptState),
  };
};

const getActiveConcept = (sessionState) => {
  const concepts = sessionState?.concepts || [];
  return (
    concepts.find(
      (concept) =>
        concept.conceptId === sessionState.activeConceptId && !concept.mastered,
    ) ||
    concepts.find((concept) => !concept.mastered) ||
    null
  );
};

const recordAdaptiveAnswer = (sessionState, conceptId, isCorrect) => {
  const nextState =
    typeof structuredClone === 'function'
      ? structuredClone(sessionState)
      : JSON.parse(JSON.stringify(sessionState));
  const concept = nextState.concepts.find(
    (candidate) => candidate.conceptId === conceptId,
  );

  if (!concept) {
    throw new Error(`Concept ${conceptId} is not part of this quiz session`);
  }

  nextState.answeredCount += 1;
  concept.attempts += 1;

  if (isCorrect) {
    nextState.correctCount += 1;
    concept.correct += 1;
    concept.consecutiveCorrect += 1;
  } else {
    concept.consecutiveCorrect = 0;
  }

  const newlyMastered =
    !concept.mastered && concept.consecutiveCorrect >= nextState.masteryStreak;
  if (newlyMastered) concept.mastered = true;

  const remainingConcept = nextState.concepts.find(
    (candidate) => !candidate.mastered,
  );
  const reachedQuestionLimit =
    nextState.answeredCount >= nextState.maxQuestions;
  const allConceptsMastered = !remainingConcept;

  if (allConceptsMastered || reachedQuestionLimit) {
    nextState.status = 'completed';
    nextState.completionReason = allConceptsMastered
      ? 'mastery_criterion_met'
      : 'maximum_questions_reached';
    nextState.activeConceptId = null;
  } else if (!isCorrect) {
    // Incorrect responses receive an immediate, different question on the same
    // concept and target cognitive level.
    nextState.activeConceptId = concept.conceptId;
  } else if (!concept.mastered) {
    // Continue collecting evidence until the documented mastery criterion is met.
    nextState.activeConceptId = concept.conceptId;
  } else {
    nextState.activeConceptId = remainingConcept.conceptId;
  }

  return {
    sessionState: nextState,
    newlyMastered,
    masteredConcept: newlyMastered ? concept : null,
  };
};

const validateGeneratedQuestion = (question, descriptor) => {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return { valid: false, reason: 'Question must be a JSON object' };
  }

  const prompt = String(question.question || '').trim();
  const options = Array.isArray(question.options)
    ? question.options.map((option) => String(option).trim())
    : [];
  const correctAnswer = String(question.correctAnswer || '').trim();
  const explanation = String(question.explanation || '').trim();
  const uniqueOptions = new Set(options);

  if (!prompt) return { valid: false, reason: 'Question text is required' };
  if (
    options.length !== 4 ||
    uniqueOptions.size !== 4 ||
    options.some((o) => !o)
  ) {
    return {
      valid: false,
      reason: 'Exactly four distinct options are required',
    };
  }
  if (!options.includes(correctAnswer)) {
    return {
      valid: false,
      reason: 'Correct answer must exactly match an option',
    };
  }
  if (!explanation) {
    return { valid: false, reason: 'Explanation is required' };
  }
  if (question.concept_id !== descriptor.conceptId) {
    return { valid: false, reason: 'Concept does not match server selection' };
  }
  if (question.target_level !== descriptor.targetLevel) {
    return {
      valid: false,
      reason: 'Target level does not match server selection',
    };
  }

  return {
    valid: true,
    question: {
      question: prompt,
      options,
      correctAnswer,
      explanation,
    },
  };
};

/**
 * Randomize presentation order after validation while keeping the answer text
 * authoritative. Options are distinct strings at this point, so grading by the
 * persisted answer remains unchanged.
 */
const shuffleGeneratedQuestionOptions = (question, random = Math.random) => {
  const options = [...question.options];

  for (let index = options.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [options[index], options[swapIndex]] = [options[swapIndex], options[index]];
  }

  return {
    question: question.question,
    options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
  };
};

const toPublicQuestion = (row) => ({
  backendQuestionId: row.id,
  displayId: row.sequence_no,
  question: row.question,
  options: row.options,
});

const toProgress = (sessionState) => ({
  answered: sessionState.answeredCount,
  correct: sessionState.correctCount,
  maxQuestions: sessionState.maxQuestions,
  masteryStreak: sessionState.masteryStreak,
  completed: sessionState.status === 'completed',
  completionReason: sessionState.completionReason,
  masteredConcepts: sessionState.concepts.filter((concept) => concept.mastered)
    .length,
  totalConcepts: sessionState.concepts.length,
  activeConcept: getActiveConcept(sessionState)?.conceptId || null,
  currentStreak: getActiveConcept(sessionState)?.consecutiveCorrect || 0,
});

module.exports = {
  POLICY_VERSION,
  getAdaptiveQuizPolicy,
  getNextBloomLevel,
  selectAdaptiveConcepts,
  createAdaptiveSessionState,
  getActiveConcept,
  recordAdaptiveAnswer,
  validateGeneratedQuestion,
  shuffleGeneratedQuestionOptions,
  toPublicQuestion,
  toProgress,
};
