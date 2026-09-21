# Adaptive Quiz: Current Behaviour and Known Issues

Last reviewed: 2026-08-30

This is a living engineering note for the adaptive quiz. Line numbers refer to
the source as it existed on the review date and should be refreshed when the
related code changes. All evidence paths are relative to the FYP workspace root.

Proposed resolutions and their research justification are tracked separately in
`culture-web-be/docs/adaptive-quiz-design-decisions.md`.

## Current behaviour

- The adaptive quiz is available only to authenticated users.
- The backend reads the user's stored `user_proficiency_state` records.
- The server deterministically selects at most two concepts by default:
  misconceptions first, then lower Bloom level, lower confidence, and concept ID.
- For a misconception, the target remains the current Bloom category. Otherwise,
  the next Bloom category is used as an explicit, unvalidated project hypothesis.
- One question is generated and returned at a time. Its authoritative answer is
  not sent to the browser before the learner responds.
- The answer endpoint grades on the server, records the selected answer,
  correctness, response time, and answer timestamp, then updates session state.
- An incorrect answer resets the concept streak and keeps the learner on the same
  concept for a different remedial question. A correct answer increments the
  streak and also stays on the concept until the configured criterion is met.
- Three consecutive correct answers is the default provisional evidence
  criterion. Meeting it applies the proficiency update and moves to the next
  selected concept. The session ends when all selected concepts meet the criterion
  or after 12 answered questions by default.
- A resume endpoint returns an existing unanswered question or regenerates one if
  answer persistence succeeded but subsequent question generation failed.
- The legacy GET batch generator and batch submission endpoint remain registered
  for compatibility, but the current frontend adaptive flow does not use them.

Primary implementation:

- Policy and transition rules:
  `culture-web-be/services/adaptiveQuizService.js:7-260`
- Start, answer, and resume endpoints:
  `culture-web-be/controllers/kathakaliController.js:2042-2509`
- Route separation: `culture-web-be/routes/kathakaliRoutes.js:84-112`
- Frontend sequential flow:
  `culture-web-fe/src/pages/QuizPage/index.tsx:68-171,300-405,577-715`
- Database additions: `culture-web-be/sql/quiz_tables_setup.sql:7-58`

Runtime status: implemented and covered by unit/route tests locally. The SQL
upgrade has not been applied to the configured remote Supabase project, so an
authenticated database end-to-end run is still pending.

## Confirmed mismatches and edge cases

### AQ-001: Resolved locally — the quiz now adapts after every response

**Resolution date:** 2026-08-30  
**Status:** Implemented locally; migration and authenticated runtime verification
remain.

The `sequential-mastery-v1` policy grades each answer before selecting and
generating the next question. Research justification and transfer limitations are
recorded in DD-002 and DD-007 through DD-009 of the design-decision log.

Evidence:

- Per-response transition: `culture-web-be/services/adaptiveQuizService.js:118-171`
- Grade, transition, and next-question generation:
  `culture-web-be/controllers/kathakaliController.js:2298-2434`
- Regression tests: `culture-web-be/tests/services/adaptiveQuizService.test.js`
- Authenticated runtime verification on 2026-08-30: after an incorrect first
  response, session `7662c4e9-0f40-4ef3-9228-d8645c6b4000` retained `adbhuta` as
  its active concept and persisted an unanswered sequence-2 `adbhuta` question.
- A continuation of that authenticated trace produced three consecutive correct
  `adbhuta` responses at sequences 2-4, followed by an unanswered sequence-5
  `advanced_analysis` question. This verifies the configured streak-to-next-
  concept transition against the deployed database.

### AQ-002: Resolved for collection — response time is recorded but not adaptive

**Resolution date:** 2026-08-30  
**Status:** Timing is collected; timing-based insights remain future evaluation.

The frontend records the time from question display to submission. The backend
bounds and stores it. The UI now explicitly states that response time is recorded
for evaluation but does not affect the policy. DD-005 documents why no
speed-to-proficiency inference is made yet.

Evidence:

- Client measurement and submission:
  `culture-web-fe/src/pages/QuizPage/index.tsx:300-319`
- Server normalization and persistence:
  `culture-web-be/controllers/kathakaliController.js:2349-2368`
- Accurate UI copy: `culture-web-fe/src/pages/QuizPage/index.tsx:110-115`
- Authenticated runtime verification on 2026-08-30: sequence 1 in session
  `7662c4e9-0f40-4ef3-9228-d8645c6b4000` persisted `response_ms = 19323` and a
  non-null answer timestamp.

### AQ-003: Resolved for the current client — no POST/GET fallback

**Resolution date:** 2026-08-30

The backend now registers a POST start route and the frontend calls it directly.
The legacy GET route remains available only for older clients.

Evidence:

- Separate legacy GET and current POST routes:
  `culture-web-be/routes/kathakaliRoutes.js:84-94`
- Direct POST with backend error parsing:
  `culture-web-fe/src/utils/invokeBackend.tsx:558-588`

### AQ-004: Resolved for sequential policy; retained in legacy batch route

**Current-path impact:** None  
**Legacy-path impact:** Medium

The sequential policy sorts all states and applies the configured concept limit.
The legacy GET route still appends every misconception despite its "up to 5"
comment, then asks for five questions.

Evidence:

- Bounded sequential selection:
  `culture-web-be/services/adaptiveQuizService.js:46-65,87-103`
- Legacy mismatch:
  `culture-web-be/controllers/kathakaliController.js:2546-2569,2620-2631`

### AQ-005: Resolved for sequential policy; retained in legacy batch route

**Current-path impact:** None  
**Legacy-path impact:** Medium

The sequential path requests, validates, persists, and returns exactly one item
per transition. The legacy route still requests five but accepts any nonempty
filtered array.

Evidence:

- Sequential parse and validation:
  `culture-web-be/controllers/kathakaliController.js:2045-2052,2109-2143`
- Legacy filtering without an exact-count assertion:
  `culture-web-be/controllers/kathakaliController.js:2684-2696,2717-2757`

### AQ-006: Partially resolved — structural validation added

**Remaining impact:** High — factual and semantic quality are not assured.

The sequential validator now enforces one nonempty question, exactly four
distinct options, answer membership, an explanation, and exact server-selected
concept and target. It does not verify claims against an approved source or
detect semantic duplicates; that remaining risk is tracked in AQ-015. The legacy
batch route retains its weaker validation.

Evidence:

- Sequential validation:
  `culture-web-be/services/adaptiveQuizService.js:174-226`
- Legacy validation: `culture-web-be/controllers/kathakaliController.js:2717-2757`

### AQ-007: Resolved for sequential policy; retained in legacy batch route

**Current-path impact:** None  
**Legacy-path impact:** Medium

The sequential start/current response strips the authoritative answer. The
answer and explanation are returned only after the response has been recorded.
The legacy batch GET still exposes answers before submission.

Evidence:

- Public projection omits answers:
  `culture-web-be/services/adaptiveQuizService.js:228-233`
- Post-answer feedback: `culture-web-be/controllers/kathakaliController.js:2421-2434`
- Legacy disclosure: `culture-web-be/controllers/kathakaliController.js:2777-2794`
- Manual UI verification on 2026-08-30 confirmed that the answer was revealed
  only after submission; the corresponding database row was unanswered before
  submission and populated afterward.

### AQ-008: Resolved for sequential policy; retained in legacy helper

**Current-path impact:** None

The current adaptive UI waits for the server result before showing correctness or
updating score. Submission failures are visible to the user. The unused legacy
batch submission helper remains for compatibility.

Evidence:

- Server-dependent adaptive feedback:
  `culture-web-fe/src/pages/QuizPage/index.tsx:300-353`
- Legacy helper retained:
  `culture-web-fe/src/utils/invokeBackend.tsx:660-710`

### AQ-009: Resolved for sequential policy; retained in legacy batch endpoint

**Current-path impact:** None  
**Legacy-path impact:** Medium

The sequential endpoint returns an applied update only after the mastery update
succeeds, and the frontend describes the event as meeting the criterion. The
legacy endpoint still returns computed updates, including possible no-ops.

Evidence:

- Sequential applied-update path:
  `culture-web-be/controllers/kathakaliController.js:2380-2389,2421-2434`
- Accurate UI feedback: `culture-web-fe/src/pages/QuizPage/index.tsx:342-346`
- Legacy no-op/response mismatch:
  `culture-web-be/controllers/kathakaliController.js:3042-3055,3118-3130`

### AQ-010: Resolved for sequential policy; retained in legacy batch endpoint

**Current-path impact:** Low residual concurrency risk covered by AQ-013  
**Legacy-path impact:** Medium

The sequential path rejects completed sessions and conditionally changes only an
unanswered question, preventing normal resubmission. The legacy submit endpoint
still fetches but does not enforce `submitted_at` before grading.

Evidence:

- Sequential guards:
  `culture-web-be/controllers/kathakaliController.js:2322-2341,2356-2373`
- Legacy fetch and overwrite:
  `culture-web-be/controllers/kathakaliController.js:2841-2855,3102-3107`

### AQ-011: Resolved for sequential policy; retained in legacy batch endpoint

**Current-path impact:** None  
**Legacy-path impact:** High

The sequential policy processes one ordered response at a time and only applies a
persistent concept update when its streak criterion is met. The legacy batch
merge still overwrites misconception state and evidence in answer-array order.

Evidence:

- Sequential transition: `culture-web-be/services/adaptiveQuizService.js:118-171`
- Legacy merge: `culture-web-be/controllers/kathakaliController.js:2959-3003`
- Legacy prompt permits repeated concepts:
  `culture-web-be/controllers/kathakaliController.js:2624-2631`

### AQ-012: Resolved — backend eligibility explanation reaches the UI

**Resolution date:** 2026-08-30

The helper now parses the backend error body and the page displays that message.

Evidence:

- Backend explanation: `culture-web-be/controllers/kathakaliController.js:2245-2249`
- Helper preserves it: `culture-web-fe/src/utils/invokeBackend.tsx:576-585`
- UI displays it: `culture-web-fe/src/pages/QuizPage/index.tsx:164-168`

### AQ-013: Sequential answer persistence is not one database transaction

**Impact:** High — a partial database failure can leave the answered question,
proficiency state, and quiz-session state inconsistent.

The endpoint conditionally marks the question answered, then separately updates
proficiency and the session JSON. The conditional question update prevents a
normal duplicate submission, but the three writes are not atomic. A failure
after the first write cannot currently be retried through the same endpoint.

Evidence:

- Question is marked answered first:
  `culture-web-be/controllers/kathakaliController.js:2356-2373`
- Proficiency and session are written separately afterward:
  `culture-web-be/controllers/kathakaliController.js:2382-2402`

Recommended resolution: move grading, answer insertion, session transition, and
proficiency mutation into one Postgres transaction/RPC, while leaving LLM
generation outside the transaction.

### AQ-014: Initial generation failure can leave an orphan active session

**Impact:** Medium — failed LLM generation after session creation leaves an
active `quiz_session` that was never returned to the user.

Evidence:

- Session is inserted before the first question is generated:
  `culture-web-be/controllers/kathakaliController.js:2257-2278`
- The outer error handler returns a generic failure without closing the session:
  `culture-web-be/controllers/kathakaliController.js:2288-2291`

### AQ-015: Sequential question validation is structural, not factual

**Impact:** High — a structurally valid LLM question may still be factually
wrong, poorly grounded, or a semantic duplicate.

The new validator enforces four distinct options, answer membership, concept,
and target-level equality. It does not verify the factual answer against an
approved source or detect semantic duplicates across the entire session.

Evidence:

- Implemented validation:
  `culture-web-be/services/adaptiveQuizService.js:174-226`
- Generation receives profile evidence but no retrieved authoritative source:
  `culture-web-be/controllers/kathakaliController.js:2054-2138`
- Authenticated runtime example on 2026-08-30: a generated item asked which
  makeup category represents a heroic, noble character but offered only
  `Minukku`, `Kari`, `Thadi`, and `Kathi`. None is correct; the required `Pacha`
  option was absent. The item also called the categories “chutti,” although
  chutti is the white border applied around the face.
- Local domain evidence identifies Paccha as noble heroes and Kathi as
  anti-heroes: `culture-web-be/curriculum.yaml:25-37`.
- External domain-authority evidence: Kerala Kalamandalam identifies Pacha with
  noble characters, Kathi with antiheroes, and chutti as the white facial border:
  https://kalamandalam.ac.in/kathakali/ and
  https://kalamandalam.ac.in/kathakali-chutty/.

### AQ-016: Equally seeded concepts fall back to alphabetical selection

**Impact:** Medium — a learner whose tracked concepts all have the same seeded
state can receive concepts based on identifier order rather than curriculum
priority, coverage, or observed learning need.

The deterministic selector ranks misconception flag, Bloom category, and
confidence before using concept ID as its final tie-breaker. In a manual
Supabase verification on 2026-08-30, session
`7662c4e9-0f40-4ef3-9228-d8645c6b4000` selected `adbhuta` followed by
`advanced_analysis`; both were `0_unseen`, confidence `0`, and had the evidence
`Initial seeding on account creation`. The policy behaved as implemented, but
the resulting initial ordering is an engineering tie-breaker rather than an
evidence-backed pedagogical decision.

Evidence:

- Deterministic sort and concept-ID tie-breaker:
  `culture-web-be/services/adaptiveQuizService.js:46-65`
- Runtime evidence: user-supplied Supabase query result for the session above,
  reviewed on 2026-08-30.

Before changing this rule, define and justify a candidate such as explicit
curriculum prerequisites, balanced coverage, or randomized assignment for an
evaluation condition. Do not claim that alphabetical selection represents
learner need.

### AQ-017: Resolved locally — generated correct answers had a positional clue

**Resolution date:** 2026-08-30  
**Impact before resolution:** High — repeated first-position correct answers
allowed a learner to obtain mastery evidence through a presentation pattern
rather than domain knowledge.

Authenticated manual testing found that the correct response repeatedly appeared
as the first option. The sequential path validated the model's option array but
previously preserved its order unchanged. It now applies a server-side
Fisher-Yates shuffle after validation and before persistence while retaining the
authoritative answer text. The research justification and limitations are
recorded in DD-010.

Evidence:

- Runtime observation: user-reported testing of session
  `7662c4e9-0f40-4ef3-9228-d8645c6b4000` on 2026-08-30.
- Shuffle implementation:
  `culture-web-be/services/adaptiveQuizService.js:228-247`
- Generation integration:
  `culture-web-be/controllers/kathakaliController.js:2129-2136`
- Regression test:
  `culture-web-be/tests/services/adaptiveQuizService.test.js:146-165`

Existing persisted questions retain their original order. Verification must use
a newly generated question after restarting or redeploying the updated backend.

## Maintenance convention

When fixing an item, keep its ID, change its heading to `Resolved`, record the
resolution date, and replace or supplement the evidence with the fixing commit
and regression-test location. Add new findings using the next `AQ-###` ID.
