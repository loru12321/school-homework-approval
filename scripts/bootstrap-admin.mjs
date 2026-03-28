const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_USERNAME", "ADMIN_PASSWORD"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  ADMIN_NAME = "系统管理员",
  ALLOW_MULTIPLE_ADMINS = "",
} = process.env;

const adminEmail = `${ADMIN_USERNAME}@school.com`;

const requestJson = async (path, init = {}) => {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.msg || data?.error_description || data?.message || text || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
};

const main = async () => {
  const existingAdmins = await requestJson("/rest/v1/profiles?select=id,username,full_name,role&role=eq.admin");
  if (Array.isArray(existingAdmins) && existingAdmins.length > 0 && ALLOW_MULTIPLE_ADMINS !== "1") {
    const adminNames = existingAdmins.map((item) => item.username || item.full_name || item.id).join(", ");
    throw new Error(`Admin profile already exists: ${adminNames}. Set ALLOW_MULTIPLE_ADMINS=1 to create another one.`);
  }

  const created = await requestJson("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: adminEmail,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: {
        username: ADMIN_USERNAME,
        name: ADMIN_NAME,
      },
      app_metadata: {
        role: "admin",
      },
    }),
  });

  const user = created?.user;
  if (!user?.id) {
    throw new Error("Admin user creation succeeded but no user id was returned.");
  }

  const profile = await requestJson("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        id: user.id,
        username: ADMIN_USERNAME,
        full_name: ADMIN_NAME,
        role: "admin",
      },
    ]),
  });

  console.log("Admin account created.");
  console.log(JSON.stringify({
    id: user.id,
    username: ADMIN_USERNAME,
    email: adminEmail,
    profile: Array.isArray(profile) ? profile[0] || null : profile,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
