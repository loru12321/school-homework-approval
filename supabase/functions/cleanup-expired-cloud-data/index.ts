import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retention-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PDF_EXPORT_BUCKET = "pdf-export-archives";
const RETENTION_YEARS = 2;
const APPLICATION_BATCH_SIZE = 200;
const PDF_JOB_BATCH_SIZE = 100;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const FINISHED_JOB_STATUSES = ["completed", "failed", "cancelled"];
const ACTIVE_JOB_STOP_TIMEOUT_MS = 20000;
const ACTIVE_JOB_POLL_INTERVAL_MS = 1000;

type EnvConfig = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  retentionCronSecret: string;
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
  const retentionCronSecret = Deno.env.get("RETENTION_CRON_SECRET");

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !retentionCronSecret) {
    throw new Error(
      "Missing Supabase env vars: SUPABASE_URL, SUPABASE_ANON_KEY, PROJECT_SERVICE_ROLE_KEY, RETENTION_CRON_SECRET.",
    );
  }

  return { supabaseUrl, anonKey, serviceRoleKey, retentionCronSecret };
};

const createServiceClient = (env: EnvConfig) =>
  createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

const createCutoffIso = (nowValue?: unknown) => {
  const now = nowValue ? new Date(String(nowValue)) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Invalid now value.");
  }

  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  return cutoff.toISOString();
};

const loadExpiredApplicationCount = async (serviceClient: ReturnType<typeof createClient>, cutoffIso: string) => {
  const datedResult = await serviceClient
    .from("applications")
    .select("id", { head: true, count: "exact" })
    .not("date", "is", null)
    .lt("date", cutoffIso);

  if (datedResult.error) {
    throw new Error(datedResult.error.message || "Failed to count expired applications by assignment date.");
  }

  const createdResult = await serviceClient
    .from("applications")
    .select("id", { head: true, count: "exact" })
    .is("date", null)
    .lt("created_at", cutoffIso);

  if (createdResult.error) {
    throw new Error(createdResult.error.message || "Failed to count expired applications by created_at.");
  }

  return Number(datedResult.count || 0) + Number(createdResult.count || 0);
};

const loadExpiredApplicationBatch = async (
  serviceClient: ReturnType<typeof createClient>,
  cutoffIso: string,
  limit: number,
) => {
  const datedResult = await serviceClient
    .from("applications")
    .select("id")
    .not("date", "is", null)
    .lt("date", cutoffIso)
    .order("id", { ascending: true })
    .limit(limit);

  if (datedResult.error) {
    throw new Error(datedResult.error.message || "Failed to load expired applications by assignment date.");
  }

  const datedIds = Array.isArray(datedResult.data)
    ? datedResult.data.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (datedIds.length >= limit) {
    return datedIds;
  }

  const remaining = limit - datedIds.length;
  const createdResult = await serviceClient
    .from("applications")
    .select("id")
    .is("date", null)
    .lt("created_at", cutoffIso)
    .order("id", { ascending: true })
    .limit(remaining);

  if (createdResult.error) {
    throw new Error(createdResult.error.message || "Failed to load expired applications by created_at.");
  }

  const createdIds = Array.isArray(createdResult.data)
    ? createdResult.data.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  return [...datedIds, ...createdIds];
};

const loadCleanupCandidates = async (
  serviceClient: ReturnType<typeof createClient>,
  deletedApplicationIds: number[],
) => {
  if (!deletedApplicationIds.length) return [];

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
        progress_text: "Job cancelled before retention cleanup.",
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
        progress_text: "Cancelling export job for retention cleanup...",
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
    return [] as string[];
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

  return Array.from(pendingIds);
};

const cleanupPdfExportArtifacts = async (
  serviceClient: ReturnType<typeof createClient>,
  applicationIds: number[],
) => {
  if (!applicationIds.length) {
    return {
      removedJobCount: 0,
      removedArchiveCount: 0,
      warnings: [] as string[],
    };
  }

  const candidates = await loadCleanupCandidates(serviceClient, applicationIds);
  const warnings: string[] = [];
  const jobIds = Array.from(new Set(candidates
    .map((item) => toTrimmedString(item.job_id))
    .filter(Boolean)));

  if (!jobIds.length) {
    return { removedJobCount: 0, removedArchiveCount: 0, warnings };
  }

  const activeCandidates = candidates.filter((item) => ACTIVE_JOB_STATUSES.has(toTrimmedString(item.status)));
  let blockedJobIds: string[] = [];

  if (activeCandidates.length) {
    try {
      const stoppingIds = await requestActiveJobStop(serviceClient, activeCandidates);
      blockedJobIds = await waitForJobsToStop(serviceClient, stoppingIds);
      if (blockedJobIds.length) {
        warnings.push(
          `${blockedJobIds.length} related PDF export jobs are still stopping, so their archives will be removed in the next cleanup cycle.`,
        );
      }
    } catch (error) {
      blockedJobIds = activeCandidates
        .map((item) => toTrimmedString(item.job_id))
        .filter(Boolean);
      warnings.push(error instanceof Error ? error.message : "Failed to stop related PDF export jobs.");
    }
  }

  const removableJobIds = jobIds.filter((jobId) => !blockedJobIds.includes(jobId));
  const removableJobs = await loadPdfExportJobsByIds(serviceClient, removableJobIds);
  const archivePaths = Array.from(new Set(removableJobs
    .map((job) => toTrimmedString(job.archive_path))
    .filter(Boolean)));

  let removedArchiveCount = 0;
  let removedJobCount = 0;

  if (archivePaths.length) {
    const removeResult = await serviceClient.storage.from(PDF_EXPORT_BUCKET).remove(archivePaths);
    if (removeResult.error) {
      warnings.push(removeResult.error.message || "Failed to remove related ZIP archives.");
    } else {
      removedArchiveCount = archivePaths.length;
    }
  }

  if (removableJobIds.length) {
    const deleteResult = await serviceClient.from("pdf_export_jobs").delete().in("id", removableJobIds);
    if (deleteResult.error) {
      warnings.push(deleteResult.error.message || "Failed to delete related PDF export jobs.");
    } else {
      removedJobCount = removableJobIds.length;
    }
  }

  return {
    removedJobCount,
    removedArchiveCount,
    warnings,
  };
};

const cleanupExpiredApplications = async (
  serviceClient: ReturnType<typeof createClient>,
  cutoffIso: string,
  dryRun: boolean,
) => {
  const expiredApplicationCount = await loadExpiredApplicationCount(serviceClient, cutoffIso);
  if (dryRun || !expiredApplicationCount) {
    return {
      expiredApplicationCount,
      deletedApplicationCount: 0,
      removedRelatedJobCount: 0,
      removedRelatedArchiveCount: 0,
      warnings: [] as string[],
    };
  }

  let deletedApplicationCount = 0;
  let removedRelatedJobCount = 0;
  let removedRelatedArchiveCount = 0;
  const warnings: string[] = [];

  while (true) {
    const batchIds = await loadExpiredApplicationBatch(serviceClient, cutoffIso, APPLICATION_BATCH_SIZE);
    if (!batchIds.length) {
      break;
    }

    const deleteResult = await serviceClient.from("applications").delete().in("id", batchIds);
    if (deleteResult.error) {
      throw new Error(deleteResult.error.message || "Failed to delete expired applications.");
    }

    deletedApplicationCount += batchIds.length;

    try {
      const relatedCleanup = await cleanupPdfExportArtifacts(serviceClient, batchIds);
      removedRelatedJobCount += relatedCleanup.removedJobCount;
      removedRelatedArchiveCount += relatedCleanup.removedArchiveCount;
      warnings.push(...relatedCleanup.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Failed to clean related PDF exports.");
    }
  }

  return {
    expiredApplicationCount,
    deletedApplicationCount,
    removedRelatedJobCount,
    removedRelatedArchiveCount,
    warnings,
  };
};

const loadExpiredPdfJobCount = async (serviceClient: ReturnType<typeof createClient>, cutoffIso: string) => {
  const finishedResult = await serviceClient
    .from("pdf_export_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", FINISHED_JOB_STATUSES)
    .not("finished_at", "is", null)
    .lt("finished_at", cutoffIso);

  if (finishedResult.error) {
    throw new Error(finishedResult.error.message || "Failed to count expired PDF export jobs by finished_at.");
  }

  const createdResult = await serviceClient
    .from("pdf_export_jobs")
    .select("id", { head: true, count: "exact" })
    .in("status", FINISHED_JOB_STATUSES)
    .is("finished_at", null)
    .lt("created_at", cutoffIso);

  if (createdResult.error) {
    throw new Error(createdResult.error.message || "Failed to count expired PDF export jobs by created_at.");
  }

  return Number(finishedResult.count || 0) + Number(createdResult.count || 0);
};

const loadExpiredPdfJobBatch = async (
  serviceClient: ReturnType<typeof createClient>,
  cutoffIso: string,
  limit: number,
) => {
  const finishedResult = await serviceClient
    .from("pdf_export_jobs")
    .select("id, archive_path")
    .in("status", FINISHED_JOB_STATUSES)
    .not("finished_at", "is", null)
    .lt("finished_at", cutoffIso)
    .order("id", { ascending: true })
    .limit(limit);

  if (finishedResult.error) {
    throw new Error(finishedResult.error.message || "Failed to load expired PDF export jobs by finished_at.");
  }

  const finishedRows = Array.isArray(finishedResult.data) ? finishedResult.data as PdfExportJobCleanupRow[] : [];
  if (finishedRows.length >= limit) {
    return finishedRows;
  }

  const createdResult = await serviceClient
    .from("pdf_export_jobs")
    .select("id, archive_path")
    .in("status", FINISHED_JOB_STATUSES)
    .is("finished_at", null)
    .lt("created_at", cutoffIso)
    .order("id", { ascending: true })
    .limit(limit - finishedRows.length);

  if (createdResult.error) {
    throw new Error(createdResult.error.message || "Failed to load expired PDF export jobs by created_at.");
  }

  const createdRows = Array.isArray(createdResult.data) ? createdResult.data as PdfExportJobCleanupRow[] : [];
  return [...finishedRows, ...createdRows];
};

const cleanupExpiredPdfJobs = async (
  serviceClient: ReturnType<typeof createClient>,
  cutoffIso: string,
  dryRun: boolean,
) => {
  const expiredPdfJobCount = await loadExpiredPdfJobCount(serviceClient, cutoffIso);
  if (dryRun || !expiredPdfJobCount) {
    return {
      expiredPdfJobCount,
      deletedPdfJobCount: 0,
      removedPdfArchiveCount: 0,
      warnings: [] as string[],
    };
  }

  let deletedPdfJobCount = 0;
  let removedPdfArchiveCount = 0;
  const warnings: string[] = [];

  while (true) {
    const rows = await loadExpiredPdfJobBatch(serviceClient, cutoffIso, PDF_JOB_BATCH_SIZE);
    if (!rows.length) {
      break;
    }

    const jobIds = rows
      .map((row) => toTrimmedString(row.id))
      .filter(Boolean);
    const archivePaths = Array.from(new Set(rows
      .map((row) => toTrimmedString(row.archive_path))
      .filter(Boolean)));

    if (archivePaths.length) {
      const removeResult = await serviceClient.storage.from(PDF_EXPORT_BUCKET).remove(archivePaths);
      if (removeResult.error) {
        warnings.push(removeResult.error.message || "Failed to remove expired ZIP archives.");
      } else {
        removedPdfArchiveCount += archivePaths.length;
      }
    }

    if (jobIds.length) {
      const deleteResult = await serviceClient.from("pdf_export_jobs").delete().in("id", jobIds);
      if (deleteResult.error) {
        throw new Error(deleteResult.error.message || "Failed to delete expired PDF export jobs.");
      }
      deletedPdfJobCount += jobIds.length;
    }
  }

  return {
    expiredPdfJobCount,
    deletedPdfJobCount,
    removedPdfArchiveCount,
    warnings,
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const env = getEnv();
    const providedSecret = req.headers.get("x-retention-cron-secret") || "";
    if (providedSecret !== env.retentionCronSecret) {
      return json(401, { ok: false, error: "Unauthorized cleanup request." });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const cutoffIso = createCutoffIso(body?.now);
    const serviceClient = createServiceClient(env);

    const applicationCleanup = await cleanupExpiredApplications(serviceClient, cutoffIso, dryRun);
    const pdfJobCleanup = await cleanupExpiredPdfJobs(serviceClient, cutoffIso, dryRun);
    const warnings = Array.from(new Set([
      ...applicationCleanup.warnings,
      ...pdfJobCleanup.warnings,
    ].filter(Boolean)));

    return json(200, {
      ok: true,
      dryRun,
      source: toTrimmedString(body?.source) || "manual",
      retentionYears: RETENTION_YEARS,
      cutoffIso,
      expiredApplications: applicationCleanup.expiredApplicationCount,
      deletedApplications: applicationCleanup.deletedApplicationCount,
      removedRelatedPdfJobs: applicationCleanup.removedRelatedJobCount,
      removedRelatedArchives: applicationCleanup.removedRelatedArchiveCount,
      expiredPdfJobs: pdfJobCleanup.expiredPdfJobCount,
      deletedPdfJobs: pdfJobCleanup.deletedPdfJobCount,
      removedPdfArchives: pdfJobCleanup.removedPdfArchiveCount,
      warnings,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown retention cleanup error.",
    });
  }
});
