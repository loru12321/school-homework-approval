import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type BulkUserInput = {
  username?: string;
  name?: string;
  password?: string;
  role?: string;
  rowLabel?: string;
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });

const toTrimmedString = (value: unknown) => String(value ?? "").trim();

const normalizeRole = (value: unknown) => (toTrimmedString(value) === "admin" ? "admin" : "teacher");

const isValidUsername = (username: string) => /^[a-zA-Z0-9_]{3,20}$/.test(username);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("PROJECT_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization");

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json(500, {
        ok: false,
          error: "缺少 Supabase 环境变量，请确认函数环境已配置 SUPABASE_URL、SUPABASE_ANON_KEY 和 PROJECT_SERVICE_ROLE_KEY。",
      });
    }

    if (!authHeader) {
      return json(401, { ok: false, error: "未提供登录凭证。" });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return json(401, { ok: false, error: authError?.message || "登录已失效，请重新登录。" });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: requesterProfile, error: requesterProfileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (requesterProfileError) {
      return json(500, {
        ok: false,
        error: requesterProfileError.message || "查询管理员身份失败。",
      });
    }

    const requesterRole = requesterProfile?.role;
    if (requesterRole !== "admin") {
      return json(403, { ok: false, error: "只有管理员可以批量创建账号。" });
    }

    const body = await req.json().catch(() => null);
    const users = Array.isArray(body?.users) ? body.users as BulkUserInput[] : null;

    if (!users || users.length === 0) {
      return json(400, { ok: false, error: "请求体中缺少 users 数组。" });
    }

    if (users.length > 200) {
      return json(400, { ok: false, error: "单次最多导入 200 个账号，请分批导入。" });
    }

    const createdUsers: Array<Record<string, string>> = [];
    const failedUsers: Array<Record<string, string>> = [];
    const warnings: string[] = [];

    for (const [index, raw] of users.entries()) {
      const username = toTrimmedString(raw.username).toLowerCase();
      const name = toTrimmedString(raw.name);
      const password = toTrimmedString(raw.password);
      const role = normalizeRole(raw.role);
      const rowLabel = raw.rowLabel || `第${index + 1}行`;

      if (!isValidUsername(username)) {
        failedUsers.push({ rowLabel, username, name, error: "账号仅支持 3-20 位字母、数字或下划线。" });
        continue;
      }

      if (!name) {
        failedUsers.push({ rowLabel, username, name, error: "姓名不能为空。" });
        continue;
      }

      if (password.length < 6) {
        failedUsers.push({ rowLabel, username, name, error: "密码至少 6 位。" });
        continue;
      }

      const email = `${username}@school.com`;
      const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, name, role },
        app_metadata: { role },
      });

      if (error || !data.user) {
        failedUsers.push({
          rowLabel,
          username,
          name,
          error: error?.message || "创建用户失败。",
        });
        continue;
      }

      createdUsers.push({
        id: data.user.id,
        username,
        name,
        role,
      });

      const { error: profileError } = await adminClient.from("profiles").upsert(
        {
          id: data.user.id,
          username,
          full_name: name,
          role,
        },
        { onConflict: "id" },
      );

      if (profileError) {
        warnings.push(`账号 ${username} 已创建，但 profiles 同步失败：${profileError.message}`);
      }
    }

    return json(200, {
      ok: true,
      success: createdUsers.length,
      fail: failedUsers.length,
      createdUsers,
      failedUsers,
      warnings,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "批量创建账号时发生未知错误。",
    });
  }
});
