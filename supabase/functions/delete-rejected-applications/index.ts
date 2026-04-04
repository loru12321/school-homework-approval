import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PDF_EXPORT_BUCKET = "pdf-export-archives";
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const ACTIVE_JOB_STOP_TIMEOUT_MS = 20000;
const ACTIVE_JOB_POLL_INTERVAL_MS = 1000;

type EnvConfig = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
};

type CleanupCandidate = {
  job_id?: string;
  archive_path?: string | null;
  status?: string;
};

type PdfExportJobCleanupRow = {
  id?: string;
  archive_path?: string | null;
  status?: string;
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getEnv = (): EnvConfig => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("PROJECT_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Missing Supabase env vars: SUPABASE_URL, SUPABASE_ANON_KEY, and PROJECT_SERVICE_ROLE_KEY.");
  }

  return { supabaseUrl, anonKey, serviceRoleKey };
};

const createUserClient = (env: EnvConfig, authHeader: string) =>
  createClient(env.supabaseUrl, env.anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

const createServiceClient = (env: EnvConfig) =>
  createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

const normalizeApplicationIds = (value: unknown) => {
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0)));
};

const deleteRejectedApplicationsWithUserContext = async (
  userClient: ReturnType<typeof createClient>,
  applicationIds: number[],
) => {
  if (!applicationIds.length) return [];

  if (applicationIds.length === 1) {
    const { data, error } = await userClient.rpc("admin_delete_rejected_application", {
      target_application_id: applicationIds[0],
    });
    if (error) throw new Error(error.message || "Failed to delete rejected application.");
    return data ? [Number(data)] : [];
  }

  const { data, error } = await userClient.rpc("admin_bulk_delete_rejected_applications", {
    target_application_ids: applicationIds,
  });
  if (error) throw new Error(error.message || "Failed to bulk delete rejected applications.");
  return Array.isArray(data)
    ? data.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
};

const loadCleanupCandidates = async (
  serviceClient: ReturnType<typeof createClient>,
  deletedApplicationIds: number[],
) => {
  const { data, error } = await serviceClient.rpc("find_pdf_export_job_cleanup_candidates", {
    target_application_ids: deletedApplicationIds,
  });

  if (error) {
    throw new Error(error.message || "Failed to load related PDF export jobs.");
  }

  return Array.isArray(data) ? data as CleanupCandidate[] : [];
};

const loadPdfExportJobsByIds = async (
  serviceClient: ReturnType<typeof createClient>,
  jobIds: string[],
) => {
  if (!jobIds.length) return [];

  const { data, error } = await serviceClient
    .from("pdf_export_jobs")
    .select("id, archive_path, status")
    .in("id", jobIds);

  if (error) {
    throw new Error(error.message || "Failed to load PDF export jobs for cleanup.");
  }

  return Array.isArray(data) ? data as PdfExportJobCleanupRow[] : [];
};

const requestActiveJobStop = async (
  serviceClient: ReturnType<typeof createClient>,
  candidates: CleanupCandidate[],
) => {
  const queuedJobIds = Array.from(new Set(candidates
    .filter((item) => toTrimmedString(item.status) === "queued")
    .map((item) => toTrimmedString(item.job_id))
    .filter(Boolean)));
  const runningJobIds = Array.from(new Set(candidates
    .filter((item) => toTrimmedString(item.status) === "running")
    .map((item) => toTrimmedString(item.job_id))
    .filter(Boolean)));

  if (queuedJobIds.length) {
    const { error } = await serviceClient
      .from("pdf_export_jobs")
      .update({
        status: "cancelled",
        finished_at: new Date().toISOString(),
        progress_text: "Job cancelled before record cleanup.",
        error_message: "",
        cancel_requested: false,
      })
      .in("id", queuedJobIds)
      .eq("status", "queued");
    if (error) {
      throw new Error(error.message || "Failed to cancel queued PDF export jobs.");
    }
  }

  if (runningJobIds.length) {
    const { error } = await serviceClient
      .from("pdf_export_jobs")
      .update({
        cancel_requested: true,
        progress_text: "Cancelling export job for record cleanup...",
      })
      .in("id", runningJobIds)
      .eq("status", "running");
    if (error) {
      throw new Error(error.message || "Failed to stop running PDF export jobs.");
    }
  }

  return Array.from(new Set([...queuedJobIds, ...runningJobIds]));
};

const waitForJobsToStop = async (
  serviceClient: ReturnType<typeof createClient>,
  activeJobIds: string[],
) => {
  const pendingIds = new Set(activeJobIds);
  if (!pendingIds.size) {
    return { remainingActiveJobIds: [] as string[] };
  }

  const deadline = Date.now() + ACTIVE_JOB_STOP_TIMEOUT_MS;
  while (pendingIds.size && Date.now() < deadline) {
    const rows = await loadPdfExportJobsByIds(serviceClient, Array.from(pendingIds));
    const rowMap = new Map(rows.map((row) => [toTrimmedString(row.id), toTrimmedString(row.status)]));

    for (const jobId of Array.from(pendingIds)) {
      const status = rowMap.get(jobId);
      if (!status || !ACTIVE_JOB_STATUSES.has(status)) {
        pendingIds.delete(jobId);
      }
    }

    if (pendingIds.size) {
      await sleep(ACTIVE_JOB_POLL_INTERVAL_MS);
    }
  }

  return { remainingActiveJobIds: Array.from(pendingIds) };
};

const cleanupPdfExportArtifacts = async (
  serviceClient: ReturnType<typeof createClient>,
  deletedApplicationIds: number[],
) => {
  if (!deletedApplicationIds.length) {
    return { cleanedExportJobCount: 0, cleanedArchiveCount: 0, cleanupWarning: "" };
  }

  const candidates = await loadCleanupCandidates(serviceClient, deletedApplicationIds);
  const jobIds = Array.from(new Set(candidates
    .map((item) => toTrimmedString(item.job_id))
    .filter(Boolean)));
  const warningParts: string[] = [];

  if (!jobIds.length) {
    return { cleanedExportJobCount: 0, cleanedArchiveCount: 0, cleanupWarning: "" };
  }

  const activeJobIds = Array.from(new Set(candidates
    .filter((item) => ACTIVE_JOB_STATUSES.has(toTrimmedString(item.status)))
    .map((item) => toTrimmedString(item.job_id))
    .filter(Boolean)));

  let remainingActiveJobIds: string[] = [];
  if (activeJobIds.length) {
    try {
      const pendingStopIds = await requestActiveJobStop(serviceClient, candidates);
      const waitResult = await waitForJobsToStop(serviceClient, pendingStopIds);
      remainingActiveJobIds = waitResult.remainingActiveJobIds;
      if (remainingActiveJobIds.length) {
        warningParts.push(`${remainingActiveJobIds.length} export jobs are still stopping. Their ZIP archives will be cleaned after those jobs finish.`);
      }
    } catch (error) {
      remainingActiveJobIds = activeJobIds;
      warningParts.push(error instanceof Error ? error.message : "Failed to stop active PDF export jobs.");
    }
  }

  const blockedJobIdSet = new Set(remainingActiveJobIds);
  const cleanupJobIds = jobIds.filter((jobId) => !blockedJobIdSet.has(jobId));
  const cleanupRows = await loadPdfExportJobsByIds(serviceClient, cleanupJobIds);
  const archivePaths = Array.from(new Set(cleanupRows
    .map((item) => toTrimmedString(item.archive_path))
    .filter(Boolean)));

  let cleanedArchiveCount = 0;
  let cleanedExportJobCount = 0;

  if (archivePaths.length) {
    const removeResult = await serviceClient.storage.from(PDF_EXPORT_BUCKET).remove(archivePaths);
    if (removeResult.error) {
      warningParts.push(removeResult.error.message || "Failed to remove related ZIP archives.");
    } else {
      cleanedArchiveCount = archivePaths.length;
    }
  }

  if (cleanupJobIds.length) {
    const deleteResult = await serviceClient.from("pdf_export_jobs").delete().in("id", cleanupJobIds);
    if (deleteResult.error) {
      warningParts.push(deleteResult.error.message || "Failed to delete related PDF export jobs.");
    } else {
      cleanedExportJobCount = cleanupJobIds.length;
    }
  }

  return {
    cleanedExportJobCount,
    cleanedArchiveCount,
    cleanupWarning: warningParts.join(" ").trim(),
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const env = getEnv();
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { ok: false, error: "Missing authorization header." });
    }

    const userClient = createUserClient(env, authHeader);
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return json(401, { ok: false, error: authError?.message || "Login session expired." });
    }

    const body = await req.json().catch(() => ({}));
    const applicationIds = normalizeApplicationIds(body?.applicationIds ?? body?.applicationId);
    if (!applicationIds.length) {
      return json(400, { ok: false, error: "Missing applicationIds." });
    }

    const deletedIds = await deleteRejectedApplicationsWithUserContext(userClient, applicationIds);
    const serviceClient = createServiceClient(env);

    let cleanedExportJobCount = 0;
    let cleanedArchiveCount = 0;
    let cleanupWarning = "";

    try {
      const cleanupResult = await cleanupPdfExportArtifacts(serviceClient, deletedIds);
      cleanedExportJobCount = cleanupResult.cleanedExportJobCount;
      cleanedArchiveCount = cleanupResult.cleanedArchiveCount;
      cleanupWarning = cleanupResult.cleanupWarning;
    } catch (cleanupError) {
      cleanupWarning = cleanupError instanceof Error ? cleanupError.message : "Related export cleanup failed.";
      console.error("Failed to clean related PDF export artifacts.", cleanupError);
    }

    return json(200, {
      ok: true,
      deletedIds,
      cleanedExportJobCount,
      cleanedArchiveCount,
      cleanupWarning,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown delete rejected applications error.",
    });
  }
});
