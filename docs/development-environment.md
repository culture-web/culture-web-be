# Shared hosted development setup

## Which environment?

Supabase organization: **KathakalAI**.

| Environment | Project reference | Purpose |
| --- | --- | --- |
| Shared development | `rzokzctxdqagnmhqhrqd` | Local frontend/backend and individual development accounts |
| Production | `cxtsnupbfqqosvzhwqyw` | Deployed application and real learner data |

Developers use the existing shared development project; no personal hosted project
or Supabase CLI is required for ordinary onboarding. Git branches and localhost
do not isolate database writes. Coordinate changes to shared development data.
An intentional production comparison is outside this quick-start; the checker
rejects production configuration.

## New developer quick-start

1. Clone `culture-web-be` and `culture-web-fe` as sibling directories. Obtain
   KathakalAI organization access using your **own Supabase account**, and obtain
   development secret/service-role key, browser key and all other required env
   values from the current maintainer through the team's secret-sharing channel.
   If nobody currently maintains the project, contact a previous maintainer for
   the configuration and access handover. Never put these values in Git.
2. Copy each repository's `.env.example` to `.env` only if no local file exists;
   preserve existing settings. Use these matching development values:

   Backend:
   ```dotenv
   SUPABASE_URL=https://rzokzctxdqagnmhqhrqd.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-development-backend-key
   SUPABASE_JWT_ISSUER=https://rzokzctxdqagnmhqhrqd.supabase.co/auth/v1
   SUPABASE_JWKS_URL=https://rzokzctxdqagnmhqhrqd.supabase.co/auth/v1/.well-known/jwks.json
   ```

   Frontend:
   ```dotenv
   VITE_BACKEND_URI=http://localhost:3001/api
   VITE_SUPABASE_URL=https://rzokzctxdqagnmhqhrqd.supabase.co
   VITE_SUPABASE_ANON_KEY=your-development-publishable-or-anon-key
   ```

   Privileged keys belong **only in the backend**. Never commit real keys,
   passwords, tokens or local environment files. Supply the backend's remaining
   provider, LOCAL_DB, MINIO and JWT_SECRET settings from the maintainer.
3. From each repository, run `npm ci`. From the backend run
   `npm run check:dev` (equivalent to `node scripts/checkDevSupabase.cjs`).
   Then run `npm run dev` in each repository in separate terminals. Default
   frontend: http://localhost:5173; backend: http://localhost:3001/api.
4. Sign up separately in the **development application** and complete any email
   confirmation required. Supabase organization membership is not an application
   account; production accounts and application roles do not transfer.
5. For KB management, ask an authorized maintainer/developer to provision your
   exact development Auth account as described below. Organization membership
   alone does not grant KB access.
6. Restart affected apps after environment changes. Sign out/back in after
   switching projects or updating roles so Supabase and KB tokens are refreshed.
   Run the checker again after changing configuration.

The checker reads local files/shell overrides, makes no network requests and
prints no keys. It checks the shared project, matching URLs/issuer/JWKS and basic
key configuration. Opaque publishable/secret key ownership and validity require
Auth verification; a local checker pass does not establish working login or
external services. It assumes Vite's standard development env files without
variable interpolation; use literal URLs/keys in those files.

## KB access: authorized maintainer only

Use the **Supabase Auth Admin API**, with the development backend credential
kept server-side. Fetch by the requested user ID and verify both ID and email
before updating. Merge into existing `app_metadata`:

```js
const { data, error } = await supabase.auth.admin.getUserById(expectedUserId);
if (error) throw error;
const user = data.user;
if (user.id !== expectedUserId || user.email !== expectedEmail) {
  throw new Error('Identity mismatch; stop');
}
const { error: updateError } = await supabase.auth.admin.updateUserById(
  expectedUserId,
  { app_metadata: { ...user.app_metadata, kb_role: 'admin', role: 'admin' } },
);
if (updateError) throw updateError;
```

First verify the client URL is exactly
`https://rzokzctxdqagnmhqhrqd.supabase.co`. Use only for an explicitly approved
KB administrator. Read the user back and verify both roles and preservation of
other metadata. Do not alter `user_metadata`, passwords or provider fields.
Have the user sign out/back in. Do not put administrator keys into browser code.

Open KB management; browser Network should show POST
`/api/auth/supabase-kb-login` returning 200 with `user.role = admin`.
Management content also needs the external dependencies below.

**User-verified, 2026-09-06:** development login and opening the KB settings page.
This does not verify uploads, retrieval, external storage isolation or a fresh clone.

## Separate setup responsibilities

- **Schema:** the existing hosted dev project has baseline migration
  `20260906052657_development_baseline.sql`; new developers do not rerun it.
- **Fixtures:** the baseline contains no production users, conversations,
  proficiency, quiz answers or KB documents. Any approved non-sensitive fixtures
  are a separate, coordinated step; no standard fixture loader is supplied here.
- **Auth:** application signup, trusted KB roles, redirect URLs, SMTP and OAuth
  settings are configured separately from SQL.
- **Environment:** each local app needs its own development configuration.
  A credential handoff file such as `.env.supabase-dev` is not automatically
  loaded by the backend; `.env` and shell settings drive it.
- **Proficiency:** do not use the overwrite-style seed-proficiency endpoint for
  onboarding. It can reset existing learner state. Adaptive quiz work is deferred.

## External KB dependencies and current limits

The backend uses separate PostgreSQL/pgvector via LOCAL_DB_HOST/PORT/USER/PASSWORD/NAME
and MinIO via MINIO_ENDPOINT/PORT/USE_SSL/ACCESS_KEY/SECRET_KEY/BUCKET.
These are not supplied by hosted Supabase. The env example lists the required
settings; the maintainer must provide an approved development destination.

`sql/local_rag_setup.sql` contains the external KB schema; it is not part of the
Supabase baseline and must not be run against an unverified destination.
Backend helpers also create some KB metadata on demand. There is no verified
complete isolated PostgreSQL/MinIO bootstrap in this guide. Do not infer isolation
from the word “local” or point uploads at production storage.
Groq/Hugging Face and other feature-specific providers require separate credentials.

Development KB settings access is user-verified; uploads, retrieval, bucket
availability and external PostgreSQL/MinIO development isolation remain unresolved.

## Maintainer migration workflow

Keep the already-applied baseline intact. It was applied through MCP on
2026-09-06, not via a validated CLI fresh-clone workflow. Its eight tables,
functions, indexes and policies are schema only.
`supabase-schema-snapshot.json` is the source catalog snapshot, not user data or
a complete project backup. Retain both for provenance/reproduction review.

For future schema changes, add a new timestamped migration. A maintainer choosing
the CLI must install it separately, record the version used, initialize project
configuration with `supabase init` if absent, then use `supabase login` and
`supabase link --project-ref rzokzctxdqagnmhqhrqd`. Check the linked project and
migration history before `supabase db push --dry-run`; apply only a separately
reviewed pending migration. CLI version/configuration is not pinned in this repo.
Generated `.temp/` and `.branches/` stay ignored; review any new config before Git.

The baseline is for an **empty replacement development project only**; it fails
when its objects already exist. Do not rerun it on shared development or push it
to production. Production's existing schema requires separate migration-history
reconciliation and release review.

Baseline differences from the captured production schema:
- Development enables music/ornaments RLS with public SELECT and service-role
  writes; production had RLS disabled for these tables.
- Two unattached legacy chat trigger functions are omitted.
- Existing quiz columns remain in the snapshot/baseline for schema fidelity;
  they do not depend on or deploy the unstaged adaptive quiz implementation.

This is not a security audit, a full project backup, or external-service setup.
Auth settings, storage objects, Edge Functions and Realtime configuration are
not reproduced by the baseline.

## Script inventory

- `scripts/checkDevSupabase.cjs` / `npm run check:dev`: retained reusable
  offline configuration guard; depends on existing `dotenv`.
- `scripts/backfillEmbeddings.js`: existing content-maintenance script, not a
  migration/onboarding requirement. It writes embeddings and calls a provider;
  do not run it as part of onboarding.
- No disposable migration scripts or generated Supabase state were found in the
  inspected repository script/Supabase directories. No artifacts were deleted.

Application deployment and database migrations are separate operations. This
onboarding change does not modify production or deploy the deferred quiz work.
