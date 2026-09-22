const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const ProficiencyAssessmentService = require('../services/proficiencyAssessmentService');
const kathakaliController = require('../controllers/kathakaliController');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

const TEST_USER_ID = '80762c54-056f-4540-9165-e7c81546d91b';

// Helper to wrap express-style controller call into a Promise
function callController(fn, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        if (statusCode >= 400) {
          const err = new Error(`HTTP ${statusCode}: ${JSON.stringify(data)}`);
          err.statusCode = statusCode;
          err.data = data;
          reject(err);
          return null;
        }
        resolve({ statusCode, data });
        return null;
      },
    };
    Promise.resolve(fn(req, res)).catch(reject);
  });
}

async function runE2ETest() {
  console.log('====================================================');
  console.log('🧪 [E2E TEST] Starting Adbhuta Misconception Lifecycle Test');
  console.log('====================================================');

  const assessmentService = new ProficiencyAssessmentService();

  // STEP 1: Send a misconception message through ProficiencyAssessmentService
  console.log('\n--- STEP 1: Assessing User Misconception Utterance ---');
  const userMessage =
    'In Kathakali, Adbhuta is the rasa of fear and disgust when fighting demons.';
  console.log(`User says: "${userMessage}"`);

  const updates = await assessmentService.assessUserProficiency(
    TEST_USER_ID,
    userMessage,
  );
  console.log(`Proficiency updates generated: ${updates.length}`);

  const adbhutaUpdate = updates.find((u) => u.conceptId === 'adbhuta');
  if (!adbhutaUpdate?.misconceptionFlag) {
    throw new Error('Expected adbhuta to be flagged with a misconception!');
  }
  console.log('✅ Adbhuta correctly identified with misconception_flag: true');
  console.log(`   Evidence: ${adbhutaUpdate.evidence}`);
  console.log(`   Reasoning: ${adbhutaUpdate.reasoning}`);

  // Apply the updates to Supabase
  await assessmentService.applyProficiencyUpdates(TEST_USER_ID, updates);
  console.log('✅ Updates applied to Supabase database');

  // STEP 2: Verify Supabase state directly
  console.log('\n--- STEP 2: Verifying Supabase Proficiency State ---');
  const { data: stateRow, error: stateError } = await supabase
    .from('user_proficiency_state')
    .select('node_id, bloom_level, misconception_flag, last_evidence')
    .eq('user_id', TEST_USER_ID)
    .eq('node_id', 'adbhuta')
    .single();

  if (stateError) throw stateError;
  console.log('Supabase State for adbhuta:', stateRow);
  if (!stateRow.misconception_flag) {
    throw new Error('Supabase row misconception_flag should be TRUE!');
  }
  console.log('✅ Supabase confirms misconception_flag is TRUE for adbhuta');

  // STEP 3: Create an Adaptive Quiz Session via Controller
  console.log('\n--- STEP 3: Creating Adaptive Quiz Session ---');
  const reqStart = {
    user: { id: TEST_USER_ID },
    body: {},
  };
  const { data: startData } = await callController(
    kathakaliController.startAdaptiveQuiz,
    reqStart,
  );

  const { quizId, question, progress } = startData;
  console.log(`Session created: Quiz ID ${quizId}`);
  console.log('Progress initial state:', progress);
  console.log(
    'Active concept selected by Adaptive Engine:',
    progress.activeConcept,
  );
  console.log('First Question ID:', question?.backendQuestionId);
  console.log('First Question Text:', question?.question);

  if (progress.activeConcept !== 'adbhuta') {
    throw new Error(
      `Expected active concept to be 'adbhuta' due to misconception priority, but got '${progress.activeConcept}'`,
    );
  }
  console.log(
    '✅ Adaptive Engine gave #1 priority to adbhuta in remediation mode!',
  );

  // STEP 4: Submit 3 consecutive correct answers to achieve mastery & clear misconception
  console.log(
    '\n--- STEP 4: Submitting 3 Consecutive Correct Answers to Clear Misconception ---',
  );

  async function submitStepAnswer(currentQ, stepIndex) {
    const qBackendId = currentQ.backendQuestionId;
    console.log(
      `\nAnswering Question ${stepIndex}/3... (Question ID: ${qBackendId})`,
    );
    console.log(`Question prompt: "${currentQ.question}"`);

    const { data: qRow, error: qErr } = await supabase
      .from('quiz_question')
      .select('id, correct_answer')
      .eq('id', qBackendId)
      .single();

    if (qErr) throw qErr;

    console.log(`Submitting correct answer: "${qRow.correct_answer}"`);

    const answerReq = {
      user: { id: TEST_USER_ID },
      params: { quizId },
      body: {
        questionId: qBackendId,
        answer: qRow.correct_answer,
        responseMs: 2500,
      },
    };

    const { data: answerData } = await callController(
      kathakaliController.answerAdaptiveQuizQuestion,
      answerReq,
    );

    console.log(
      `Question ${stepIndex} Answered correctly: ${answerData.result.correct}`,
    );
    console.log(
      `Current streak: ${answerData.progress.currentStreak}/${answerData.progress.masteryStreak}`,
    );
    console.log(
      'Proficiency updates applied:',
      answerData.proficiencyUpdatesApplied,
    );

    return answerData.nextQuestion;
  }

  const q2 = await submitStepAnswer(question, 1);
  const q3 = await submitStepAnswer(q2, 2);
  await submitStepAnswer(q3, 3);

  // STEP 5: Verify that adbhuta is mastered and misconception_flag is CLEARED in Supabase
  console.log(
    '\n--- STEP 5: Verifying Misconception Resolution in Supabase ---',
  );
  const { data: clearedRow, error: clearErr } = await supabase
    .from('user_proficiency_state')
    .select('node_id, bloom_level, misconception_flag, last_evidence')
    .eq('user_id', TEST_USER_ID)
    .eq('node_id', 'adbhuta')
    .single();

  if (clearErr) throw clearErr;
  console.log('Final Supabase state for adbhuta:', clearedRow);

  if (clearedRow.misconception_flag !== false) {
    throw new Error('Expected misconception_flag to be cleared to false!');
  }
  console.log('✅ Confirmed: misconception_flag is now false (cleared)!');
  console.log('✅ Evidence updated to:', clearedRow.last_evidence);

  console.log('\n====================================================');
  console.log('🎉 [E2E TEST PASSED] Full Misconception Lifecycle Verified!');
  console.log('====================================================\n');
  process.exit(0);
}

runE2ETest().catch((err) => {
  console.error('\n❌ [E2E TEST FAILED]:', err);
  process.exit(1);
});
