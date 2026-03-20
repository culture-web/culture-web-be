const supabase = require('../client/supabaseClient');
const { ALLOWED_ROLES, normalizeRole } = require('./kbUserService');

const toIsoString = (value) => {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
};

const deriveUsername = (user) => {
  const fromMetadata =
    user?.user_metadata?.name ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')?.[0];
  return String(
    fromMetadata || `user-${String(user?.id || '').slice(0, 8)}`,
  ).trim();
};

const deriveRole = (user) => {
  const candidate =
    user?.app_metadata?.kb_role ||
    user?.app_metadata?.role ||
    user?.user_metadata?.kb_role ||
    user?.user_metadata?.role;
  return normalizeRole(candidate) || 'viewer';
};

const mapSupabaseUserToManagedUser = (user) => ({
  id: String(user.id),
  username: deriveUsername(user),
  email: String(user.email || ''),
  role: deriveRole(user),
  is_active: !user?.banned_until,
  created_at: toIsoString(user.created_at),
  updated_at: toIsoString(
    user.updated_at || user.last_sign_in_at || user.created_at,
  ),
});

const listSupabaseUsers = async () => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) {
      throw new Error(error.message || 'Failed to list Supabase users');
    }
    if (Array.isArray(data?.users)) {
      return data.users;
    }
  } catch (error) {
    // continue with paginated fallback for SDKs that require page/perPage
  }

  const users = [];
  let page = 1;
  const perPage = 200;
  let hasMore = true;

  while (hasMore) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) {
      throw new Error(error.message || 'Failed to list Supabase users');
    }

    const pageUsers = data?.users || [];
    users.push(...pageUsers);

    if (!pageUsers.length || pageUsers.length < perPage) {
      hasMore = false;
    } else {
      page += 1;
    }
  }

  return users;
};

const listKbUsersFromSupabase = async () => {
  const users = await listSupabaseUsers();
  return users
    .map(mapSupabaseUserToManagedUser)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
};

const createKbUserInSupabase = async ({ username, email, password, role }) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    throw new Error('role must be one of: admin, editor, viewer');
  }

  const cleanUsername = String(username || '').trim();
  const cleanEmail = String(email || '')
    .trim()
    .toLowerCase();

  if (!cleanUsername || !cleanEmail || !password) {
    throw new Error('username, email and password are required');
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: cleanEmail,
    password: String(password),
    email_confirm: true,
    app_metadata: {
      role: normalizedRole,
      kb_role: normalizedRole,
    },
    user_metadata: {
      name: cleanUsername,
      full_name: cleanUsername,
    },
  });

  if (error) {
    const message = String(error.message || 'Failed to create Supabase user');
    if (
      /already\s+registered|already\s+exists|already\s+been\s+registered/i.test(
        message,
      )
    ) {
      throw new Error('User already exists');
    }
    throw new Error(message);
  }

  return mapSupabaseUserToManagedUser(data.user);
};

const updateKbUserRoleInSupabase = async (userId, role) => {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) {
    throw new Error('role must be one of: admin, editor, viewer');
  }

  const { data: existingData, error: existingError } =
    await supabase.auth.admin.getUserById(String(userId));
  if (existingError) {
    throw new Error(existingError.message || 'Failed to fetch user');
  }
  if (!existingData?.user) return null;

  const existingAppMetadata = existingData.user.app_metadata || {};

  const { data, error } = await supabase.auth.admin.updateUserById(
    String(userId),
    {
      // eslint-disable-next-line prefer-object-spread
      app_metadata: Object.assign({}, existingAppMetadata, {
        role: normalizedRole,
        kb_role: normalizedRole,
      }),
    },
  );

  if (error) {
    throw new Error(error.message || 'Failed to update user role');
  }

  return mapSupabaseUserToManagedUser(data.user);
};

const resetKbUserPasswordInSupabase = async (userId, newPassword) => {
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('newPassword must be at least 6 characters');
  }

  const { data, error } = await supabase.auth.admin.updateUserById(
    String(userId),
    {
      password: String(newPassword),
    },
  );

  if (error) {
    throw new Error(error.message || 'Failed to reset password');
  }

  if (!data?.user) return null;
  return mapSupabaseUserToManagedUser(data.user);
};

module.exports = {
  ALLOWED_ROLES,
  listKbUsersFromSupabase,
  createKbUserInSupabase,
  updateKbUserRoleInSupabase,
  resetKbUserPasswordInSupabase,
};
