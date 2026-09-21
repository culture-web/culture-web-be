# Adaptive Quiz: Evidence-Based Design Decisions

Last reviewed: 2026-08-30

This document provides traceability between adaptive-quiz design decisions,
research evidence, project evidence, limitations, and planned evaluation. It is
intended to support both implementation and the final-year-project paper.

## Evidence policy

Every material design decision must record:

1. the decision and alternative considered;
2. whether its evidence is research, project data, a system requirement, or an
   engineering inference;
3. the source and the claim that the source actually supports;
4. limitations on transferring that evidence to this Kathakali application;
5. a test or evaluation criterion.

Research evidence is not treated as proof that the same effect will occur in
this application. Where direct evidence is absent, the item is labelled a
candidate hypothesis rather than a settled decision.

## DD-001: Describe the system as adaptive formative practice, not validated CAT

**Status:** Accepted terminology decision  
**Evidence type:** Research literature plus current-system evidence

**Decision:** Until its questions have empirical item parameters and its learner
estimator has been validated, describe the feature as a **rule-based adaptive
formative quiz**. Do not describe it in the paper as a psychometrically validated
computerized adaptive test (CAT).

**Justification:** Conventional CAT uses an iterative ability estimate, an item
selection rule, a stopping rule, and a calibrated item bank. The current system
generates new LLM questions on demand and labels their difficulty using Bloom
levels; it has no empirical item-difficulty or discrimination parameters. Work
on automatic item generation also evaluates generated items psychometrically
before treating them as operational assessment items [1, 2].

**Project evidence:**

- Questions are generated on demand:
  `culture-web-be/controllers/kathakaliController.js:2054-2143`
- Difficulty is requested as a Bloom label:
  `culture-web-be/controllers/kathakaliController.js:2071-2107`
- The schema contains no calibrated item parameters:
  `culture-web-be/sql/quiz_tables_setup.sql:22-40`

**Evaluation:** Report the implemented rules and outcomes explicitly. If enough
response data are later collected, estimate item difficulty/discrimination and
evaluate whether the generated difficulty labels correspond to observed data.

## DD-002: Select the next question after observing the previous answer

**Status:** Accepted architectural direction  
**Evidence type:** Established adaptive-assessment and learner-modelling methods

**Decision:** Deliver one question at a time. After each response, update the
learner/session state and use that updated state to select the next question.

**Justification:** The conventional adaptive-testing loop repeatedly updates an
interim learner estimate from observed responses and then selects the next item
using that estimate [1]. Knowledge tracing similarly models a student's changing
knowledge state from successive interactions [3]. The current batch design
cannot use answer 1 as evidence when choosing question 2.

**Limit:** These sources support sequential updating, but they do not validate
this project's particular Bloom-level transition rule. The project is borrowing
the sequential structure, not claiming equivalence to an IRT-based CAT or a
validated Bayesian Knowledge Tracing model.

**Evaluation:** Integration tests must demonstrate that two users with the same
starting state but different answers receive different subsequent targets. A
study should compare the sequential version with the existing fixed batch on
learning gain, completion rate, latency, and learner perception.

## DD-003: Keep adaptation policy in deterministic application code

**Status:** Accepted engineering inference  
**Evidence type:** Inference from assessment architecture and LLM item studies

**Decision:** Application code selects the concept, target level, content
constraints, and stopping condition. The LLM realizes a question within those
constraints; it does not decide learner progression.

**Justification:** Adaptive-testing literature separates learner estimation,
content balancing, item selection, and stopping rules so they can be specified
and evaluated [1]. Empirical LLM-question studies show that generated questions
can be useful, but also find item-writing flaws and variable distractor quality
[4, 5]. Keeping progression outside the LLM makes the policy reproducible,
auditable, and testable even when model output varies.

**Limit:** Reproducibility and auditability are engineering benefits. The cited
studies do not demonstrate that a deterministic Bloom rule improves learning in
this Kathakali domain.

**Evaluation:** Unit-test every transition rule with fixed inputs. Log the rule
version, prior state, answer evidence, selected concept, and selected target for
each transition so decisions can be reconstructed.

## DD-004: Validate generated questions before using them as evidence

**Status:** Accepted requirement  
**Evidence type:** Empirical studies of LLM-generated assessment items

**Decision:** Before presenting a generated question, validate at minimum:

- required schema and exactly four distinct options;
- correct answer is exactly one option;
- concept and target level are allowed by the server-selected descriptor;
- misconception flag matches the server state;
- question is grounded in an approved Kathakali source;
- no duplicate or near-duplicate question exists in the session.

The authoritative answer remains on the server until the response is recorded.

**Justification:** Arif, Asthana, and Collins-Thompson found frequent flaws in
LLM-generated MCQs, particularly implausible distractors, and fewer than 20% of
their automatically assessed items passed every quality check [4]. Bhandari et
al. found promising psychometric results for generated algebra questions, but
only after collecting responses from 207 participants and applying IRT linking
[5]. Together, these results support generation as feasible but do not justify
accepting unchecked model output as valid assessment evidence.

**Project evidence:** The sequential validator now enforces structural fields,
four distinct options, answer membership, and the server-selected concept and
target. It does not yet ground the answer in an approved source or detect
semantic duplicates:
`culture-web-be/services/adaptiveQuizService.js:174-226` and
`culture-web-be/controllers/kathakaliController.js:2054-2143`.

**Evaluation:** Automated validation tests plus expert review of a sampled item
set for correctness, relevance, Bloom alignment, clarity, and distractor quality.
After sufficient use, calculate observed item difficulty and discrimination.

## DD-005: Record response time, but do not initially alter difficulty with it

**Status:** Accepted initial-scope decision  
**Evidence type:** Large-scale empirical adaptive-assessment study

**Decision:** Record response time for analysis, with clear definitions and
privacy handling, but base the first adaptive policy on scored responses rather
than speed.

**Justification:** Domingue et al. found heterogeneous response acceleration and
inconsistent within-person relationships between additional time and accuracy
in a large adaptive reading assessment [6]. Consequently, a simple rule such as
"faster means more proficient" is not justified.

**Limit:** That study concerned a reading assessment, not Kathakali knowledge.
It supports caution, not the conclusion that response time is never useful.

**Evaluation:** Analyse response-time distributions, question position, accuracy,
and device conditions before proposing a time-aware model.

## DD-006: The current five-question limit is a legacy implementation choice

**Status:** Open; not accepted as the future stopping rule  
**Evidence type:** Existing implementation only; no supporting research evidence

**Current state:** The application requests five questions and the backend
hard-codes five. This documents existing behaviour; it is not a recommendation
that the adaptive version must retain that limit.

**Justification:** No reviewed source establishes that five questions are
sufficient for a reliable learner estimate in this application. Conventional
adaptive assessment requires an explicit termination criterion. That criterion
may be fixed length, but it may instead depend on measurement precision or a
classification decision [1]. Consequently, choosing five requires an explicit
study constraint or empirical justification; it cannot be inferred from adaptive
testing theory.

**Project evidence:** The retained legacy generator hard-codes five at
`culture-web-be/controllers/kathakaliController.js:2620-2631`.

**Alternatives to evaluate:**

1. fixed length, retained only to compare fairly with the existing five-question
   quiz;
2. a minimum and maximum length with early stopping after a defined mastery
   criterion;
3. a precision-based stopping rule, if a validated probabilistic learner model
   and sufficient response data become available.

**Evaluation:** Before implementation, define the purpose of the quiz as either
formative practice, mastery classification, or proficiency measurement. Select
the stopping rule from that purpose, then report completion time, number of
questions, state uncertainty, learning gain, and learner burden. Any numerical
threshold remains a project hypothesis until validated.

## DD-007: Use response-dependent concept selection after every question

**Status:** Implemented for local evaluation  
**Evidence type:** Adaptive-assessment structure and an empirical ITS study

**Decision:** After every response, recompute the next question from current
session evidence. An incorrect response keeps the same concept active and asks a
different remedial question. A concept remains active while its configured
evidence criterion is unmet; once met, the system moves to the next selected
knowledge gap.

**Justification:** Sequential adaptive assessment updates the learner estimate
before selecting another item [1, 3]. In SQL-Tutor, Mitrovic and Martin compared
static expert-assigned complexity with problem difficulty computed from each
student's current knowledge. Their results supported dynamic problem selection
across a wider range of prior abilities, although the sample was small and the
domain was university SQL learning [8].

**Limit:** This supports using current learner evidence for selection, not the
specific priority weights used by KathakalAI. Prioritizing misconceptions, then
lower Bloom states and lower confidence, is an interpretable project heuristic
that must be evaluated separately.

**Implementation evidence:**

- Deterministic concept priority:
  `culture-web-be/services/adaptiveQuizService.js:46-65`
- Per-response transition:
  `culture-web-be/services/adaptiveQuizService.js:118-177`
- Sequential answer endpoint:
  `culture-web-be/controllers/kathakaliController.js:2298-2437`

**Evaluation:** Replay controlled answer traces and verify that changing only
the answer changes the next selection as specified. Compare adaptive and static
conditions on pre/post gain, completion, question count, and prior-proficiency
subgroups.

## DD-008: Use a configurable three-correct evidence streak for the prototype

**Status:** Implemented as a provisional mastery heuristic  
**Evidence type:** Theoretical analysis and documented operational use

**Decision:** Require three consecutive correct responses on a concept's target
before applying its persistent proficiency update. An incorrect response resets
the streak. The value is configurable through
`ADAPTIVE_QUIZ_MASTERY_STREAK`.

**Justification:** N-consecutive-correct rules are used in adaptive mastery
systems such as ASSISTments. Doroudi showed that N-consecutive-correct can be
interpreted as an optimal policy for particular variants of Bayesian Knowledge
Tracing, making its assumptions more explicit [7]. ASSISTments has evidence of
effectiveness as a broader formative-assessment intervention [9], but that study
does not isolate three-in-a-row as the causal component.

**Limit:** Doroudi also notes that a single slip resets the streak and can punish
or demotivate a learner. Neither that theoretical result nor the ASSISTments
study establishes that three is optimal for Kathakali MCQs, where guessing and
slips are plausible. The implementation therefore calls this an evidence
criterion, not a validated mastery measurement.

**Implementation evidence:**

- Policy configuration:
  `culture-web-be/services/adaptiveQuizService.js:7-39`
- Streak update and reset:
  `culture-web-be/services/adaptiveQuizService.js:118-151`
- Branch tests:
  `culture-web-be/tests/services/adaptiveQuizService.test.js`

**Evaluation:** Compare alternative streak values and report attempts, errors,
completion, and learner burden. With sufficient response histories, compare the
heuristic against a fitted BKT or another validated learner model.

## DD-009: Bound the prototype by concepts and a maximum question count

**Status:** Implemented as configurable safety constraints  
**Evidence type:** Engineering scope and learner-burden protection; numerical
values are not research validated

**Decision:** The prototype selects at most two concepts and stops after at most
12 answered questions. It can finish earlier if every selected concept meets the
evidence criterion. Both values are configurable through
`ADAPTIVE_QUIZ_CONCEPT_LIMIT` and `ADAPTIVE_QUIZ_MAX_QUESTIONS`.

**Justification:** Adaptive systems require content constraints and a stopping
rule [1]. A maximum prevents an unbounded session when the streak keeps resetting.
The defaults of two and 12 are implementation starting points chosen to make it
possible to gather repeated evidence on more than one concept; the literature
reviewed does not establish these numbers as optimal.

**Evaluation:** Report the distribution of session lengths, incomplete concepts,
completion time, abandonment, and subjective workload. Revise the defaults from
pilot data rather than treating them as pedagogical constants.

## DD-010: Randomize generated response options on the server

**Status:** Implemented after authenticated runtime defect discovery  
**Evidence type:** Project runtime evidence plus psychometric research

**Decision:** After validating a generated question, randomize all four response
options with a Fisher-Yates shuffle before persistence. Keep the authoritative
answer as its distinct option text. Persist and reuse that randomized order for
the lifetime of the question rather than reshuffling it on every request.

**Alternatives considered:** Asking the LLM to vary the answer position was
rejected as the sole control because the observed generator output already
exhibited a repeated first-position key. Assigning only the correct answer to a
balanced position was also not selected because distractor position can affect
responses; randomizing the complete option array addresses both kinds of
ordering.

**Justification:** Attali and Bar-Hillel found systematic answer-position
tendencies with psychometric consequences, including differences in difficulty
and discrimination [10]. In two experiments within a Chilean national test with
195,715 examinees, Lions et al. found small but systematic effects from both the
correct option and distractor positions and recommended randomizing response
options rather than only controlling the key position [11]. These results support
removing a predictable positional clue; they do not establish that randomization
improves the factual or distractor quality of generated questions.

**Project evidence:** During authenticated testing on 2026-08-30, the correct
response repeatedly appeared first in adaptive session
`7662c4e9-0f40-4ef3-9228-d8645c6b4000`. Before this decision, the sequential
validator returned the LLM option array unchanged and the controller persisted
it directly.

**Implementation evidence:**

- Server-side shuffle:
  `culture-web-be/services/adaptiveQuizService.js:228-247`
- Applied after validation and before persistence:
  `culture-web-be/controllers/kathakaliController.js:2129-2136`
- Regression test with an injected deterministic random source:
  `culture-web-be/tests/services/adaptiveQuizService.test.js:146-165`

**Limit:** With independent randomization, the correct answer can still appear
first with probability 1/4 for any individual four-option item, and short sessions
can contain clusters by chance. The defensible claim is that position is no
longer determined by model output, not that each session has an exactly balanced
answer key.

**Evaluation:** Record the persisted correct-option ordinal and report its
distribution across a sufficiently large generated-item sample. Test that all
positions occur, inspect for substantial departure from the expected 25% per
position, and separately review distractor plausibility and factual accuracy.

## Candidate rule CR-001: One correct advances; incorrect reduces the target

**Status:** Rejected for the first implementation; retained for comparison  
**Evidence type:** Current project logic plus design intuition; insufficient
direct evidence reviewed so far

**Candidate:** A single correct response would permit a higher target, while an
incorrect response would reduce the session target.

**Why it is not yet accepted:** Sequential learner modelling supports updating
state after a response [3], but it does not by itself validate a one-correct
promotion, one-incorrect remediation rule, nor does a Bloom category provide a
calibrated numerical difficulty scale. The retained legacy batch implementation
already promotes after one correct response, but that is project behaviour rather
than external evidence:
`culture-web-be/controllers/kathakaliController.js:2961-2968`.

**Required work:** Review evidence on mastery thresholds, corrective feedback,
and adaptive task sequencing; define a competing policy; then evaluate both with
simulated traces and, if feasible, a learner study. Until then this rule should
not be presented in the paper as evidence-based.

## Candidate rule CR-002: Use the next Bloom category as the challenge target

**Status:** Implemented project hypothesis; not externally validated  
**Evidence type:** Existing project knowledge model

**Candidate:** For a concept without a recorded misconception, the prototype
asks questions at the next stored Bloom category. For a misconception, it asks
at the current category. Persistent progression or misconception clearing occurs
only after DD-008's evidence criterion is met.

**Project basis:** The existing database and proficiency service encode Bloom
categories as the ordered states `0_unseen` through `4_analyze`. The previous
quiz generator also used the next category as a possible target:
`culture-web-be/controllers/kathakaliController.js:2579-2615` after the sequential
implementation shifted the legacy code downward.

**Limit:** A Bloom cognitive-process category is not an empirically calibrated
item-difficulty parameter. The next category must therefore be described as a
curriculum progression hypothesis, not proof that the generated item is harder
or optimally challenging.

**Implementation evidence:**
`culture-web-be/services/adaptiveQuizService.js:67-82`.

**Evaluation:** Expert-label generated items for Bloom alignment and compare
their intended category with observed correctness and discrimination. Do not
interpret a successful streak as a validated ability estimate until this
relationship is established.

## References

1. Han, K. C. T. (2018). Components of the item selection algorithm in
   computerized adaptive testing. _Journal of Educational Evaluation for Health
   Professions, 15_, 7. https://doi.org/10.3352/jeehp.2018.15.7
2. Arendasy, M. E., & Sommer, M. (2012). Using automatic item generation to
   meet the increasing item demands of high-stakes educational and occupational
   assessment. _Learning and Individual Differences, 22_(1), 112-117.
   https://doi.org/10.1016/j.lindif.2011.11.005
3. Corbett, A. T., & Anderson, J. R. (1995). Knowledge tracing: Modeling the
   acquisition of procedural knowledge. _User Modeling and User-Adapted
   Interaction, 4_, 253-278. https://doi.org/10.1007/BF01099821
4. Arif, T., Asthana, S., & Collins-Thompson, K. (2024). Generation and
   assessment of multiple-choice questions from video transcripts using large
   language models. In _Proceedings of the Eleventh ACM Conference on Learning
   @ Scale_. https://doi.org/10.1145/3657604.3664714
5. Bhandari, S., Liu, Y., Kwak, Y., & Pardos, Z. A. (2024). Evaluating the
   psychometric properties of ChatGPT-generated questions. _Computers and
   Education: Artificial Intelligence, 7_, 100284.
   https://doi.org/10.1016/j.caeai.2024.100284
6. Domingue, B. W., Kanopka, K., Stenhaug, B., Soland, J., Kuhfeld, M., Wise,
   S., & Piech, C. (2021). Variation in respondent speed and its implications:
   Evidence from an adaptive testing scenario. _Journal of Educational
   Measurement, 58_(3), 335-363. https://doi.org/10.1111/jedm.12291
7. Doroudi, S. (2020). Mastery learning heuristics and their hidden models. In
   _Artificial Intelligence in Education_ (pp. 86-91).
   https://doi.org/10.1007/978-3-030-52240-7_16
8. Mitrovic, A., & Martin, B. (2004). Evaluating adaptive problem selection. In
   _Adaptive Hypermedia and Adaptive Web-Based Systems_ (pp. 185-194).
   https://www.csse.canterbury.ac.nz/tanja.mitrovic/AH04.pdf
9. Roschelle, J., Feng, M., Murphy, R. F., & Mason, C. A. (2016). Online
   mathematics homework increases student achievement. _AERA Open, 2_(4).
   https://doi.org/10.1177/2332858416673968
10. Attali, Y., & Bar-Hillel, M. (2003). Guess where: The position of correct
    answers in multiple-choice test items as a psychometric variable. _Journal
    of Educational Measurement, 40_(2), 109-128.
    https://doi.org/10.1111/j.1745-3984.2003.tb01099.x
11. Lions, S., Dartnell, P., Toledo, G., Godoy, M. I., Córdova, N., Jiménez, D.,
    & Lemarié, J. (2023). Position of correct option and distractors impacts
    responses to multiple-choice items: Evidence from a national test.
    _Educational and Psychological Measurement, 83_(5), 861-884.
    https://doi.org/10.1177/00131644221132335
