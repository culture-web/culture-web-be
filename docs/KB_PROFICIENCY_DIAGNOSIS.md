# KB and proficiency diagnosis

Date: 2026-09-06. Scope: current backend working tree and read-only Supabase metadata/counts. No frontend, microservices, CD, application execution, or database writes.

## Plain-language answers

- **Most likely KB-access cause:** neither development Auth account has a KB role, whereas production has seven admins. The backend rejects a role-less account's KB login with HTTP 403. This explains inability to access management; whether the frontend hides a particular settings control is unverified.
- **Matching Supabase tables is insufficient:** KB authorization lives in Auth metadata. KB documents/metadata use a separate PostgreSQL connection and MinIO. Retrieval tuning comes from request fields/defaults. There is no Supabase KB-settings table in either project's inspected inventory.
- **Quizzes require persisted proficiency:** both adaptive generation routes return 404 for no rows. The newer sequential route can advance ordinary unseen concepts; it does not initialize missing ones.
- **Normal users can acquire proficiency through authenticated chat**, after assistant persistence, through asynchronous LLM assessment. Signup initialization is not established: neither database has a custom auth.users trigger; the backend exposes an explicit seed endpoint but does not automatically call it on signup.
- **Chat affects levels in code, not reliably on every successful response.** Assessment/provider/database failures do not fail the already delivered chat. Asking a question can count as learning under the current prompt.
- **Current local backend .env targets production**, with a matching production JWT issuer. This supersedes the previous handoff's dev-target statement. Nothing was switched or started in this investigation. Active process configuration and frontend target were not checked.

## Verified project comparison

Identities independently confirmed with each connection's get_project_url before querying: development `rzokzctxdqagnmhqhrqd`; production `cxtsnupbfqqosvzhwqyw`.

| Check | Development | Production | Implication |
|---|---|---|---|
| Public application tables | events, messages, music, ornaments, quiz_question, quiz_session, sessions, user_proficiency_state | Same eight | Table names alone do not establish complete parity |
| KB/knowledge/settings-named tables/views/materialized views outside system schemas | None | None | Not an empty or RLS-filtered Supabase KB table |
| Effective Auth KB-role counts | No role: 2 | admin: 7; no role: 17 | Missing dev authorization is concrete; identities/roles do not transfer between projects |
| Non-internal auth.users triggers | None | None | No current database signup seeding trigger |
| Proficiency counts | 41 rows / 1 user | 751 rows / 22 users | Aggregate only; not proof of how any rows were created |
| Quiz/proficiency columns | Matching names, types including lengths, defaults, nullability | Same | Includes sequential quiz additions |
| Relevant constraints/indexes | Matching PKs, quiz-question FK, 13 indexes | Same | Partial unique quiz sequence exists in both |
| Quiz/proficiency RLS policies | Own-user SELECT/INSERT/UPDATE; question ownership through session | Same | Ordinary users are isolated by identity |
| Public-table grants checked | anon/authenticated/service_role SELECT/INSERT/UPDATE granted | Same | Grants do not bypass RLS for ordinary users |
| service_role bypassrls | true | true | Backend service-key requests rely on application authorization/filtering |
| RLS enablement | All eight enabled | music/ornaments disabled; remaining enabled | Deliberate baseline difference, unrelated to KB-role rejection |
| Public views | None | None | No missing public KB view |
| Public functions | Three match functions plus two timestamp functions | Same plus update_chat_session_on_message and update_chat_session_on_message_delete | Two legacy function names omitted by baseline; neither appears in active public trigger inventory |
| Active public triggers | music/ornaments timestamps, proficiency timestamp | Same | Timestamp update is not proficiency initialization |
| Migration history | 20260906052657 development_baseline | History relation absent | Cannot reconstruct production deployment history from this facility |

Catalog comparison is bounded, not a full dump or proof of function-body/storage/Auth configuration parity.

## What “KB settings” means and request paths

### 1. Access and user management

- `routes/authRoutes.js` routes POST /api/auth/supabase-kb-login through authenticateToken; `middleware/authMiddleware.js:66` verifies Supabase issuer/audience/JWKS.
- `controllers/authController.js:118` reads app_metadata.kb_role, app_metadata.role, user_metadata.kb_role, user_metadata.role in that precedence. Only normalized admin/editor/viewer values qualify. Missing role yields explicit 403, not empty settings.
- Successful exchange signs a separate 24-hour KB JWT. `server.js:80` protects /api/k-manage with verifyAdminToken; `middleware/authMiddleware.js:150` checks that JWT, while requireKbRoles and controller checks perform role authorization.
- `controllers/adminController.js:2469` onward restricts user administration to admin. `services/supabaseKbUserService.js:109` creates Auth users with app_metadata.role and kb_role; no public KB settings seed row is involved.
- Management display derives a default viewer role for missing metadata (`services/supabaseKbUserService.js:21`), unlike the login rejection. A displayed viewer label therefore does not prove access.
- Legacy local kb_users code exists (`services/kbUserService.js`), but legacy login is disabled (`controllers/authController.js:26`).
- The metadata fallback includes user_metadata; authorization should be reviewed to rely only on administrator-controlled app_metadata. JWT_SECRET is absent in the inspected .env and code has a fallback signing secret; do not reproduce that value. These are separate access-hardening issues, not evidence of the disappeared UI.

### 2. KB content, file switches and storage

`controllers/adminController.js:917` queries knowledge_base statistics through localDbClient; `:951` groups source files and metadata and lists MinIO objects. This is shared KB content, not per-Supabase-user settings. Missing metadata fields can default (for example enabled=true); SQL failures return errors rather than demonstrate an empty KB. Legitimately empty aggregate results can show zero statistics.

`client/localDbClient.js` uses LOCAL_DB_HOST/PORT/USER/PASSWORD/NAME. `client/minioClient.js` and `services/minioStorageService.js` use MINIO configuration. `sql/local_rag_setup.sql:5` defines knowledge_base with vector(384), kb_jobs, knowledge_base_versions and knowledge_base_version_snapshots. The admin controller also contains on-demand version/audit schema creation helpers. These are outside the Supabase public baseline.

Sanitized .env evidence: all inspected LOCAL_DB and MINIO credential/endpoint/bucket variables are present; LOCAL_DB_HOST is non-loopback, MINIO_ENDPOINT loopback. Connection ownership, external schema, counts, bucket existence and grants are **unverified**. No unknown remote database was contacted, no service helper imported, and no storage objects listed/copied. Missing external configuration *values* is not demonstrated; validity/reachability and dev/prod isolation remain open.

### 3. Retrieval controls

`controllers/kathakaliController.js:912` onward accepts knowledgeSource, rerankerStrategy, similarityThreshold, vectorWeight, fullTextWeight, topN and multiTurnOptimization from the request. Around `:946` it resolves defaults/clamps (threshold .35, vector .3/full-text .7, top-K environment/default 6); retrievalDebug.settings returns resolved controls. These are not fetched from a Supabase settings row. Session history is separately owner-filtered; unavailable history may fall back to empty.

**Precise frontend question:** which missing control and which network request is involved—KB token exchange, /api/k-manage, or request-side retrieval options? Backend evidence cannot determine UI conditional rendering, cached tokens, or the current browser identity.

## Proficiency lifecycle

### Representation and initialization

`supabase/migrations/20260906052657_development_baseline.sql:108` defines one row per (user_id,node_id): strings, Bloom enum 0_unseen/1_remember/2_understand/3_apply/4_analyze, misconception_flag, last_evidence, last_reasoning, last_confidence (double precision), created_at and updated_at. There is no persisted universal “knowledge score”; summaries calculate aggregates. The composite primary key prevents duplicate user/concept rows. No inspected FK ties user_id to Auth or node_id to curriculum.

The curriculum is repository YAML (`services/curriculumService.js:20`), not a Supabase seed table.
- POST /api/kathakali/seed-proficiency is authenticated (`routes/kathakaliRoutes.js:115`); `controllers/kathakaliController.js:3148` upserts all concepts as unseen.
- **Repeated seeding overwrites existing levels, flags and evidence.** Its “account creation” evidence text does not establish a signup caller.
- Targeted backend caller search found the route binding, not an automatic signup caller. Frontend onboarding invocation is outside scope.
- Chat getCurrentUserStates (`services/proficiencyAssessmentService.js:85`) supplies absent concepts as unseen in memory. Only accepted assessments get upserted; neighbor unlocking can create additional unseen rows.
- Earlier smoke explicitly seeded; it cannot establish normal initialization. Aggregate dev counts are consistent with partial account coverage but do not identify its cause.

### Chat → assessment → persistence

POST /api/chat/messages uses optionalAuth → chatController.addMessage → ChatService.addMessage. For an authenticated user message, after storing the assistant response, `services/chatService.js:110` schedules updateUserProficiency via setImmediate; `:1122` calls assessment and then persistence. Anonymous messages do not take this update path.

`services/curriculumService.js:160` actually returns **all curriculum concepts**, despite its relevance-oriented method name. `services/proficiencyAssessmentService.js:142` sends the current user message and current levels to Hugging Face's Together provider (openai/gpt-oss-120b). HF_TOKEN is present, but validity/provider availability was not tested. Session history is not assessment input.

The prompt (`:209`) deliberately treats asking “What is paccha?” as level 1 and a descriptive statement as level 2. Thus this combines exposure and inferred attainment; it is not solely demonstrated mastery.

Parser (`:310`) checks required properties, allowed levels and confidence >=.6, then transition rules; concept membership and finite numeric confidence are not strictly validated before state access. Invalid output can cause assessment failure/empty updates.

Persistence (`:594`) is asynchronous upsert by user/concept:
- Existing same-level non-misconception evidence is skipped.
- Misconception flags are ORed with existing flags, so chat cannot clear an existing flag.
- A lower proposed level with misconception=true can pass validation and be persisted: “sticky progress” is not enforced consistently.
- A higher proposed level with misconception=true is rejected entirely, including its flag.
- Level >=2 invokes neighbor creation for absent children **and prerequisites** (`:469`, `:574`), at unseen. Existing unseen rows are not promoted by unlocking.
- No durable queue/retry or transaction guarantees delivery. Assessment failures can return empty results; persistence failures are logged after chat completion.

Alternate /api/kathakali/chat-mudras does not call this assessment service in the inspected backend. Which route the frontend uses is unverified.

### Stored state → quiz

New POST /api/kathakali/generate-adaptive-quiz:
- `controllers/kathakaliController.js:2234` reads persisted rows for the authenticated user, returns 404 on none; no on-demand seed.
- `services/adaptiveQuizService.js:48` sorts misconceptions first, then lowest level/confidence, then concept ID; selects two by default.
- Ordinary unseen → target 1_remember; misconception → current level, including possible 0_unseen. Other ordinary levels target next level capped at 4.
- Partially populated state selects only present rows. No prerequisite mastery filter or curriculum-membership validation in selection.
- Default maximum 12 questions, mastery streak 3; policy bounds configurable. GROQ generates a single question at the server-selected concept/target (`kathakaliController.js:2079` onward); schema checks enforce four distinct options and matching concept/level, not factual grounding.

Retained GET of the same route (`:2525`) also requires rows. It prioritizes misconceptions then random other topics; target elevation is probabilistic, confidence clamped to 10–90% (`:2599`). Consequently unseen can still target unseen, and correct answers at that target cannot raise level. The old issue remains **possible in the local legacy route**, not an established description of deployed production code. Production commit/runtime was not inspected.

### Quiz answers → deterministic proficiency

Sequential answer (`kathakaliController.js:2301`; `adaptiveQuizService.js:117`):
1. Checks session ownership, completion, question membership and option.
2. Grades exact stored answer text; conditionally persists answer only where answered_at IS NULL. Duplicate answers return 409.
3. Wrong answer resets streak, retains concept/target. Three consecutive correct answers (default) mark that concept mastered.
4. At mastery, upsert uses max(current,target), confidence .9 and clears a targeted misconception (`:2184`). Full quiz completion is **not** required. One correct answer normally persists an answer without advancing proficiency.
5. Session state/status is written next, then next question generated. Completion occurs on all selected concepts mastered or question cap.
6. Answer, proficiency and session writes are **not one transaction**. Failure after saving the answer may prevent later progression; duplicate protection can block replay. Unique sequence index does not solve cross-write consistency. Sequential mastery does not call neighbor unlocking.

Legacy submit (`:2809`, `:2936`):
- Correct → max(current,target), incorrect → no downgrade; misconception-target correctness clears/sets flag. Confidence values .9/.7/.65 are written only when a state actually changes.
- Same-level correct with unchanged flag is a no-op, including evidence/confidence. Returned score is per-submission correctness, not persisted proficiency score.
- Neighbor unlocking runs after updates; submitted_at is written afterward, and failure to mark completion is logged.
- There is no submitted_at rejection in this handler and no sequential conditional answer-write guard. Returned proficiencyUpdatesApplied includes computed updates, including skipped no-ops. This response alone does not prove a level changed.
- Legacy completion does not update status; old completed sessions can retain active.

## Intended model versus code

| Path | Assessment | Evidence/limit |
|---|---|---|
| Conversational LLM → proficiency | Implemented, with reliability/semantic gaps | ChatService:110,1122; assessment:142,594; route-specific, asynchronous |
| Quiz → deterministic proficiency | Implemented, different legacy/sequential rules | Controller:2184,2301,2936; cross-write failures possible |
| Proficiency → adaptive questions | Implemented; prerequisite gating absent | AdaptiveQuizService:48; controller:2234,2525 |
| Misconceptions → personalized retrieval/chat | Partial | ChatService:402 injects stored misconception/evidence into response prompt; retrieval calls are not reranked by proficiency. General handler:885 only comments about potential KB search |

## Ordered follow-up tasks (not executed)

1. **Dev target and KB identity/config:** explicitly verify intended local target before starting anything; configure a dedicated dev KB administrator using trusted app_metadata, refresh Supabase/KB tokens, inspect the precise failing request. Acceptance: dev identity/issuer agree, role-less account gets 403, intended dev admin exchanges token and opens management, no production mutation. Do not copy production Auth users.
2. **Reproducible external KB setup:** identify a dedicated dev PostgreSQL/MinIO destination, audit backend setup SQL/helpers, document schema migration and a tiny approved non-sensitive fixture. Acceptance: fresh dev environment exposes expected metadata/storage with explicit isolation. Auth roles, endpoints/secrets and fixtures are configuration/seed steps; schema migration alone is insufficient.
3. **Proficiency initialization and assessment correctness:** define one idempotent onboarding path that inserts only missing concepts; add focused tests for repeat initialization, question-versus-mastery semantics, invalid LLM outputs, monotonic levels and misconception changes. Acceptance: existing learner state preserved; expected transitions durable/observable. Do not run the current seed endpoint on existing learners.
4. **Quiz persistence consistency:** make answer/mastery/session transition atomic or recoverably idempotent; clarify/retire legacy route and prerequisite policy. Acceptance: duplicate/concurrent/retried answers cannot lose mastery, unseen progression follows documented policy, actual updates distinguished from computed no-ops.
5. **KB authorization hardening:** remove untrusted role fallback and fail closed without a signing secret. Acceptance: user-editable metadata cannot grant KB permissions and absent secret cannot sign/verify KB tokens.

## Checks, evidence and limits

Pass: project identity checks; bounded SELECT inventories/counts/catalog comparisons; targeted backend caller/SQL/config inspection; documentation whitespace check. No functional test was performed.

Not run: authenticated user endpoint requests, browser/UI reproduction, provider calls, external PostgreSQL/MinIO inspection, production deployment comparison, function-body/full-schema parity, tests/builds/servers. These are intentionally outside this read-only diagnosis or require identifying the external destination. No documents, personal rows or tokens retrieved.

Exact initial aggregate SQL (executed in both projects):
```sql
SELECT json_build_object(
'tables',(SELECT json_agg(x) FROM (SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname)x),
'auth_role_counts',(SELECT json_agg(x) FROM (SELECT coalesce(raw_app_meta_data->>'kb_role',raw_app_meta_data->>'role',raw_user_meta_data->>'kb_role',raw_user_meta_data->>'role','(none)') AS kb_role,count(*) FROM auth.users GROUP BY 1)x),
'auth_triggers',(SELECT json_agg(pg_get_triggerdef(t.oid)) FROM pg_trigger t WHERE t.tgrelid='auth.users'::regclass AND NOT t.tgisinternal),
'kb_relations',(SELECT json_agg(n.nspname||'.'||c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','v','m') AND (c.relname ILIKE '%kb%' OR c.relname ILIKE '%knowledge%' OR c.relname ILIKE '%setting%')),
'proficiency_summary',(SELECT json_build_object('rows',count(*),'users',count(DISTINCT user_id)) FROM public.user_proficiency_state)
) AS inspection;
```

Additional catalog checks used information_schema.columns, pg_policies, pg_proc/pg_namespace, pg_views, has_table_privilege for anon/authenticated/service_role, pg_constraint with pg_get_constraintdef, pg_indexes, pg_trigger with pg_get_triggerdef, pg_roles. Scope: public inventory/grants/functions/triggers; quiz_session, quiz_question and user_proficiency_state for column/policy/constraint/index comparison.

Exact final type check (both projects):
```sql
SELECT a.attrelid::regclass::text AS relation,a.attname,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid IN ('public.quiz_session'::regclass,'public.quiz_question'::regclass,'public.user_proficiency_state'::regclass) AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,a.attnum;
```

Migration check: `SELECT to_regclass('supabase_migrations.schema_migrations');` on both; only dev then ran `SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version;`.

Repository checks: git status --short and git branch --show-current in culture-web-be; targeted rg/sed reads. Two guessed service filenames were absent; imports resolved the actual client/huggingfaceClient.js and services/minioStorageService.js paths. No application validation is inferred from file inspection.
