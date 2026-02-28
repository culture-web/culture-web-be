const crypto = require('crypto');
const localDbClient = require('../client/localDbClient');

const ALLOWED_ROLES = new Set(['admin', 'editor', 'viewer']);

const normalizeRole = (role) => {
  const normalized = String(role || '').trim().toLowerCase();
  return ALLOWED_ROLES.has(normalized) ? normalized : null;
};

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const verifyPassword = (password, storedHash) => {
  try {
    if (!storedHash || typeof storedHash !== 'string') return false;
    const [algo, salt, hashHex] = storedHash.split('$');
    if (algo !== 'scrypt' || !salt || !hashHex) return false;

    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    return false;
  }
};

const ensureKbUsersTable = async () => {
  await localDbClient.query(`
    CREATE TABLE IF NOT EXISTS kb_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await localDbClient.query(`
    CREATE INDEX IF NOT EXISTS idx_kb_users_role ON kb_users(role);
  `);
};

const ensureDefaultAdmin = async () => {
  await ensureKbUsersTable();

  const { rows } = await localDbClient.query(
    `SELECT COUNT(*)::int AS count FROM kb_users WHERE role = 'admin' AND is_active = TRUE;`,
  );

  if (Number(rows?.[0]?.count || 0) > 0) return;

  const defaultUsername = process.env.KB_USERNAME || 'admin';
  const defaultPassword = process.env.KB_PASSWORD || 'kathakalai2026';
  const defaultEmail = process.env.KB_ADMIN_EMAIL || 'admin@kb.local';

  await localDbClient.query(
    `INSERT INTO kb_users (username, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'admin', TRUE)
     ON CONFLICT (username) DO NOTHING;`,
    [
      String(defaultUsername).trim(),
      String(defaultEmail).trim(),
      hashPassword(defaultPassword),
    ],
  );
};

const sanitizeKbUser = (row) => ({
  id: row.id,
  username: row.username,
  email: row.email,
  role: row.role,
  is_active: row.is_active,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const getKbUserByIdentifier = async (identifier) => {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  const { rows } = await localDbClient.query(
    `SELECT id, username, email, password_hash, role, is_active, created_at, updated_at
     FROM kb_users
     WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
     LIMIT 1;`,
    [normalized],
  );
  return rows[0] || null;
};

const listKbUsers = async () => {
  await ensureKbUsersTable();
  const { rows } = await localDbClient.query(
    `SELECT id, username, email, role, is_active, created_at, updated_at
     FROM kb_users
     ORDER BY created_at DESC;`,
  );
  return rows.map(sanitizeKbUser);
};

const createKbUser = async ({ username, email, password, role }) => {
  await ensureKbUsersTable();
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    throw new Error('role must be one of: admin, editor, viewer');
  }

  const cleanUsername = String(username || '').trim();
  const cleanEmail = String(email || '').trim();
  if (!cleanUsername || !cleanEmail || !password) {
    throw new Error('username, email and password are required');
  }

  const { rows } = await localDbClient.query(
    `INSERT INTO kb_users (username, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     RETURNING id, username, email, role, is_active, created_at, updated_at;`,
    [cleanUsername, cleanEmail, hashPassword(password), normalizedRole],
  );
  return sanitizeKbUser(rows[0]);
};

const updateKbUserRole = async (userId, role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    throw new Error('role must be one of: admin, editor, viewer');
  }

  const { rows } = await localDbClient.query(
    `UPDATE kb_users
     SET role = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, username, email, role, is_active, created_at, updated_at;`,
    [userId, normalizedRole],
  );
  return rows[0] ? sanitizeKbUser(rows[0]) : null;
};

const resetKbUserPasswordByAdmin = async (userId, newPassword) => {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('newPassword must be at least 6 characters');
  }

  const { rows } = await localDbClient.query(
    `UPDATE kb_users
     SET password_hash = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, username, email, role, is_active, created_at, updated_at;`,
    [userId, hashPassword(newPassword)],
  );
  return rows[0] ? sanitizeKbUser(rows[0]) : null;
};

const changeOwnKbPassword = async (userId, currentPassword, newPassword) => {
  if (!currentPassword || !newPassword || String(newPassword).length < 6) {
    throw new Error('currentPassword and newPassword (>=6 chars) are required');
  }

  const { rows } = await localDbClient.query(
    `SELECT id, password_hash FROM kb_users WHERE id = $1 AND is_active = TRUE LIMIT 1;`,
    [userId],
  );
  if (!rows[0]) return false;

  const ok = verifyPassword(currentPassword, rows[0].password_hash);
  if (!ok) return false;

  await localDbClient.query(
    `UPDATE kb_users SET password_hash = $2, updated_at = NOW() WHERE id = $1;`,
    [userId, hashPassword(newPassword)],
  );
  return true;
};

module.exports = {
  ALLOWED_ROLES,
  normalizeRole,
  verifyPassword,
  ensureKbUsersTable,
  ensureDefaultAdmin,
  getKbUserByIdentifier,
  listKbUsers,
  createKbUser,
  updateKbUserRole,
  resetKbUserPasswordByAdmin,
  changeOwnKbPassword,
};
