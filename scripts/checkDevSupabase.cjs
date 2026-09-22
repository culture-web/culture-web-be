// Read-only local configuration check. Does not log credentials or contact a server.
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const backendFile = path.join(root, '.env');
const be = fs.existsSync(backendFile)
  ? dotenv.parse(fs.readFileSync(backendFile))
  : {};
const feRoot = path.resolve(root, '../culture-web-fe');
// Vite's development-mode precedence (shell overrides are checked below).
const fe = {};
['.env', '.env.local', '.env.development', '.env.development.local'].forEach(
  (name) => {
    const file = path.join(feRoot, name);
    if (fs.existsSync(file)) {
      Object.assign(fe, dotenv.parse(fs.readFileSync(file)));
    }
  },
);
Object.assign(be, process.env);
Object.assign(fe, process.env);
const prod = 'cxtsnupbfqqosvzhwqyw.supabase.co';
const devOrigin = 'https://rzokzctxdqagnmhqhrqd.supabase.co';
const errors = [];
function parseUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.hostname === prod) errors.push(`${label} points at PRODUCTION.`);
    if (
      url.origin !== devOrigin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      errors.push(`${label} must use the shared hosted development URL.`);
    }
    if (/your-project|DEV_PROJECT_REF|placeholder/i.test(url.hostname)) {
      errors.push(`${label} is still a placeholder.`);
    }
    return url;
  } catch (err) {
    errors.push(`${label} is missing or invalid.`);
    return null;
  }
}
const backend = parseUrl(be.SUPABASE_URL, 'Backend Supabase URL');
const frontend = parseUrl(fe.VITE_SUPABASE_URL, 'Frontend Supabase URL');
if (backend && frontend && backend.origin !== frontend.origin) {
  errors.push('Frontend and backend Supabase projects do not match.');
}
if (
  backend &&
  be.SUPABASE_JWT_ISSUER &&
  be.SUPABASE_JWT_ISSUER !== `${backend.origin}/auth/v1`
) {
  errors.push('Backend JWT issuer does not match its Supabase project.');
}
if (
  backend &&
  be.SUPABASE_JWKS_URL &&
  be.SUPABASE_JWKS_URL !== `${backend.origin}/auth/v1/.well-known/jwks.json`
) {
  errors.push('Backend JWKS URL does not match its Supabase project.');
}
[
  ['Backend secret', be.SUPABASE_SERVICE_ROLE_KEY],
  ['Frontend browser key', fe.VITE_SUPABASE_ANON_KEY],
].forEach(([label, value]) => {
  if (!value || /^(your-|DEV_)/.test(value)) {
    errors.push(`${label} is missing or a placeholder.`);
  }
});
const browserKey = fe.VITE_SUPABASE_ANON_KEY || '';
if (browserKey.startsWith('sb_secret_')) {
  errors.push('A secret key is configured in the frontend.');
}
try {
  const payload = JSON.parse(
    Buffer.from(browserKey.split('.')[1], 'base64url').toString(),
  );
  if (payload.role === 'service_role') {
    errors.push('A service-role key is configured in the frontend.');
  }
  if (
    frontend &&
    payload.ref &&
    frontend.hostname !== `${payload.ref}.supabase.co`
  ) {
    errors.push('Frontend legacy key belongs to a different Supabase project.');
  }
} catch (err) {
  /* Publishable keys are not JWTs. */
}
try {
  const payload = JSON.parse(
    Buffer.from(
      (be.SUPABASE_SERVICE_ROLE_KEY || '').split('.')[1],
      'base64url',
    ).toString(),
  );
  if (payload.role !== 'service_role') {
    errors.push('Backend legacy key is not a service-role key.');
  }
  if (
    backend &&
    payload.ref &&
    backend.hostname !== `${payload.ref}.supabase.co`
  ) {
    errors.push('Backend legacy key belongs to a different Supabase project.');
  }
} catch (err) {
  /* Opaque secret keys cannot be verified offline. */
}
if ((be.SUPABASE_SERVICE_ROLE_KEY || '').startsWith('sb_publishable_')) {
  errors.push('A browser publishable key is configured as the backend secret.');
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Development configuration matches: ${backend.hostname}`);
  console.log(
    'Offline check only; key validity, login and external KB services are not verified.',
  );
}
