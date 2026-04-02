import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { PDFDocument, PDFFont, PDFPage, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PDF_TEMPLATE_SETTING_KEY = "pdf_template";
const PDF_EXPORT_BUCKET = "pdf-export-archives";
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const FINISHED_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const FONT_URL =
  "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf";

const fontBytesPromise = fetch(FONT_URL).then(async (response) => {
  if (!response.ok) {
    throw new Error(`Font fetch failed: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
});

type EnvConfig = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
};

type RequestContext = {
  env: EnvConfig;
  adminClient: ReturnType<typeof createClient>;
  userId: string;
  requesterName: string;
};

type ExportItem = {
  id?: string | number;
  teacher_name?: string;
  file_name?: string;
  grade?: string | number;
  subject?: string;
  duration?: string | number;
  date?: string;
  content?: string;
  approval_time?: string;
  approver_name?: string;
};

type PdfTemplateConfig = {
  schoolName: string;
  headerTitle: string;
  headerSubtitle: string;
  signOffText: string;
  pdfFileNamePattern: string;
  archiveFileNamePattern: string;
};

type PdfExportJobRow = {
  id: string;
  status: string;
  mode_label: string;
  filter_snapshot: Record<string, unknown>;
  filter_summary: string;
  folder_mode: string;
  items: ExportItem[];
  total_count: number;
  completed_count: number;
  archive_name: string;
  archive_path: string | null;
  progress_text: string;
  error_message: string;
  use_filters: boolean;
  cancel_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });

const pad = (value: number | string) => String(value).padStart(2, "0");
const toTrimmedString = (value: unknown) => String(value ?? "").trim();

const sanitizeFileName = (value: unknown, fallback = "homework-pdf") => {
  const safeName = String(value || fallback).replace(/[\\/:*?"<>|]+/g, "_").trim();
  return safeName || fallback;
};

const parseDateValue = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateTime = (value: unknown) => {
  const date = parseDateValue(value);
  if (!date) return "--";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatDateOnly = (value: unknown) => formatDateTime(value).split(" ")[0];

const formatDateToken = (value: unknown, withTime = true) => {
  const date = parseDateValue(value);
  if (!date) return "";
  return withTime
    ? `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`
    : `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};

const buildDefaultPdfTemplateConfig = (): PdfTemplateConfig => ({
  schoolName: "School Office",
  headerTitle: "Homework Notice",
  headerSubtitle: "HOMEWORK APPROVAL NOTICE",
  signOffText: "School Office",
  pdfFileNamePattern: "{file_name}",
  archiveFileNamePattern: "{mode}_{count}items_{timestamp}",
});

const normalizePdfTemplateConfig = (value: unknown): PdfTemplateConfig => {
  const source = typeof value === "object" && value ? value as Record<string, unknown> : {};
  const base = { ...buildDefaultPdfTemplateConfig(), ...source };
  return {
    schoolName: toTrimmedString(base.schoolName) || "School Office",
    headerTitle: toTrimmedString(base.headerTitle) || "Homework Notice",
    headerSubtitle: toTrimmedString(base.headerSubtitle),
    signOffText: toTrimmedString(base.signOffText) || toTrimmedString(base.schoolName) || "School Office",
    pdfFileNamePattern: toTrimmedString(base.pdfFileNamePattern) || "{file_name}",
    archiveFileNamePattern: toTrimmedString(base.archiveFileNamePattern) || "{mode}_{count}items_{timestamp}",
  };
};

const snapshotFilter = (value: unknown) => {
  const source = typeof value === "object" && value ? value as Record<string, unknown> : {};
  return {
    grade: toTrimmedString(source.grade) || "全部",
    subject: toTrimmedString(source.subject) || "全部",
    keyword: toTrimmedString(source.keyword),
    dateField: toTrimmedString(source.dateField) === "approval_time" ? "approval_time" : "date",
    dateFrom: toTrimmedString(source.dateFrom),
    dateTo: toTrimmedString(source.dateTo),
    folderMode: ["flat", "grade", "grade_subject", "teacher"].includes(toTrimmedString(source.folderMode))
      ? toTrimmedString(source.folderMode)
      : "flat",
  };
};

const renderTemplatePattern = (pattern: string, values: Record<string, string | number>, fallback: string) => {
  const template = toTrimmedString(pattern) || fallback;
  const rendered = template.replace(/\{([a-z_]+)\}/gi, (_, key) => toTrimmedString(values[key]));
  return sanitizeFileName(rendered.replace(/\s+/g, " ").trim(), fallback);
};

const buildPatternValues = (app: ExportItem, extra: Record<string, string | number>, config: PdfTemplateConfig) => ({
  school: config.schoolName,
  teacher: toTrimmedString(app.teacher_name),
  grade: toTrimmedString(app.grade),
  subject: toTrimmedString(app.subject),
  file_name: toTrimmedString(app.file_name),
  date: formatDateToken(app.date, false),
  date_time: formatDateToken(app.date, true),
  approval_date: formatDateToken(app.approval_time, false),
  approval_time: formatDateToken(app.approval_time, true),
  mode: toTrimmedString(extra.mode),
  count: toTrimmedString(extra.count),
  timestamp: toTrimmedString(extra.timestamp) || formatDateToken(new Date(), true),
});

const buildPdfFileBaseName = (app: ExportItem, config: PdfTemplateConfig) =>
  renderTemplatePattern(
    config.pdfFileNamePattern,
    buildPatternValues(app, {}, config),
    toTrimmedString(app.file_name) || "homework-notice",
  );

const buildPdfArchiveName = (
  modeLabel: string,
  exportCount: number,
  useFilters: boolean,
  filterSnapshot: Record<string, unknown>,
  config: PdfTemplateConfig,
) => {
  const snapshot = snapshotFilter(filterSnapshot);
  const fallbackParts = [modeLabel];
  if (useFilters) {
    if (snapshot.grade !== "全部") fallbackParts.push(`${snapshot.grade}年级`);
    if (snapshot.subject !== "全部") fallbackParts.push(snapshot.subject);
    if (snapshot.keyword) fallbackParts.push("keyword-filtered");
    if (snapshot.dateFrom || snapshot.dateTo) {
      fallbackParts.push(snapshot.dateField === "approval_time" ? "approval-range" : "assigned-range");
    }
  }
  fallbackParts.push(`${exportCount}items`);
  fallbackParts.push(formatDateToken(new Date(), true) || String(Date.now()));
  return `${renderTemplatePattern(
    config.archiveFileNamePattern,
    {
      school: config.schoolName,
      mode: modeLabel,
      count: exportCount,
      grade: snapshot.grade === "全部" ? "" : snapshot.grade,
      subject: snapshot.subject === "全部" ? "" : snapshot.subject,
      timestamp: formatDateToken(new Date(), true),
    },
    fallbackParts.join("_"),
  )}.zip`;
};

const buildPdfZipEntryPath = (app: ExportItem, folderMode: string, fileName: string) => {
  const folderParts: string[] = [];
  if (folderMode === "grade") {
    folderParts.push(sanitizeFileName(`${toTrimmedString(app.grade) || "ungraded"}-grade`));
  } else if (folderMode === "grade_subject") {
    folderParts.push(sanitizeFileName(`${toTrimmedString(app.grade) || "ungraded"}-grade`));
    folderParts.push(sanitizeFileName(toTrimmedString(app.subject) || "unspecified-subject"));
  } else if (folderMode === "teacher") {
    folderParts.push(sanitizeFileName(toTrimmedString(app.teacher_name) || "unnamed-teacher"));
  }
  return [...folderParts, fileName].join("/");
};

const wrapText = (font: PDFFont, text: string, fontSize: number, maxWidth: number) => {
  const lines: string[] = [];
  let currentLine = "";
  for (const char of Array.from(String(text || "").replace(/\r\n/g, "\n"))) {
    if (char === "\n") {
      lines.push(currentLine);
      currentLine = "";
      continue;
    }
    const nextLine = currentLine + char;
    if (currentLine && font.widthOfTextAtSize(nextLine, fontSize) > maxWidth) {
      lines.push(currentLine);
      currentLine = char.trim() ? char : "";
      continue;
    }
    currentLine = nextLine;
  }
  if (currentLine || !lines.length) lines.push(currentLine);
  return lines;
};

const drawRightText = (
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  color = rgb(0, 0, 0),
) => {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: x - width, y, size, font, color });
};

const getEnv = (): EnvConfig => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("PROJECT_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Missing Supabase env vars: SUPABASE_URL, SUPABASE_ANON_KEY, and PROJECT_SERVICE_ROLE_KEY.");
  }
  return { supabaseUrl, anonKey, serviceRoleKey };
};

const createServiceClient = (env: EnvConfig) =>
  createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

const resolveContext = async (req: Request): Promise<RequestContext> => {
  const env = getEnv();
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Missing authorization header.");

  const userClient = createClient(env.supabaseUrl, env.anonKey, {
    global: { headers: { Authorization: authHeader } },
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
    throw new Error(authError?.message || "Login session expired.");
  }

  const adminClient = createServiceClient(env);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("role, full_name, username")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message || "Failed to load admin profile.");
  if (profile?.role !== "admin") throw new Error("Only admins can use PDF export jobs.");

  const requesterName = toTrimmedString(profile?.full_name) || toTrimmedString(profile?.username) || "Admin";
  return { env, adminClient, userId: user.id, requesterName };
};

const fetchPdfTemplateConfig = async (adminClient: ReturnType<typeof createClient>) => {
  const { data, error } = await adminClient
    .from("app_settings")
    .select("setting_value")
    .eq("setting_key", PDF_TEMPLATE_SETTING_KEY)
    .maybeSingle();

  if (error) throw new Error(error.message || "Failed to load PDF template config.");
  return normalizePdfTemplateConfig(data?.setting_value);
};

const fetchJob = async (adminClient: ReturnType<typeof createClient>, jobId: string) => {
  const { data, error } = await adminClient
    .from("pdf_export_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(error.message || "Failed to load PDF export job.");
  return data as PdfExportJobRow | null;
};

const updateJob = async (adminClient: ReturnType<typeof createClient>, jobId: string, patch: Record<string, unknown>) => {
  const { error } = await adminClient
    .from("pdf_export_jobs")
    .update(patch)
    .eq("id", jobId);

  if (error) throw new Error(error.message || "Failed to update PDF export job.");
};

const removeArchiveIfPresent = async (adminClient: ReturnType<typeof createClient>, job: PdfExportJobRow | null) => {
  if (!job?.archive_path) return;
  const { error } = await adminClient.storage.from(PDF_EXPORT_BUCKET).remove([job.archive_path]);
  if (error) throw new Error(error.message || "Failed to remove ZIP archive.");
};

const createPdfBytes = async (app: ExportItem, config: PdfTemplateConfig) => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await fontBytesPromise;
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });
  const page = pdfDoc.addPage([595.28, 841.89]);
  const pageWidth = page.getWidth();
  const black = rgb(0, 0, 0);

  const drawCentered = (text: string, y: number, size: number, color = black) => {
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (pageWidth - width) / 2, y, size, font, color });
  };

  drawCentered(config.schoolName, 780, 14);
  drawCentered(config.headerTitle, 742, 24);
  if (config.headerSubtitle) drawCentered(config.headerSubtitle, 716, 10);

  page.drawLine({
    start: { x: 86, y: 700 },
    end: { x: 509, y: 700 },
    thickness: 1.4,
    color: black,
  });

  page.drawText(`年级：${toTrimmedString(app.grade) || "--"}年级`, { x: 70, y: 668, size: 14, font, color: black });
  drawRightText(page, font, `学科：${toTrimmedString(app.subject) || "--"}`, 525, 668, 14, black);
  page.drawText(`时长：${toTrimmedString(app.duration) || "--"}分钟`, { x: 70, y: 638, size: 14, font, color: black });
  drawRightText(page, font, `日期：${formatDateOnly(app.date)}`, 525, 638, 14, black);

  page.drawRectangle({
    x: 60,
    y: 315,
    width: 475,
    height: 280,
    borderColor: black,
    borderWidth: 1.4,
  });
  page.drawRectangle({
    x: 72,
    y: 588,
    width: 80,
    height: 18,
    color: rgb(1, 1, 1),
  });
  page.drawText("作业内容", { x: 80, y: 592, size: 12, font, color: black });

  const contentLines = wrapText(font, toTrimmedString(app.content) || "暂无内容", 13, 435);
  let contentY = 560;
  for (const line of contentLines.slice(0, 13)) {
    page.drawText(line || " ", { x: 78, y: contentY, size: 13, font, color: black });
    contentY -= 22;
  }

  page.drawLine({
    start: { x: 60, y: 284 },
    end: { x: 535, y: 284 },
    thickness: 1.1,
    color: black,
  });
  page.drawText("双减要求：符合", { x: 70, y: 260, size: 14, font, color: black });
  page.drawText("审核：通过", { x: 70, y: 188, size: 14, font, color: black });
  page.drawText(`时间：${formatDateOnly(app.approval_time)}`, { x: 70, y: 160, size: 14, font, color: black });

  drawRightText(page, font, config.signOffText || config.schoolName, 520, 190, 14, black);
  drawRightText(page, font, formatDateOnly(app.approval_time), 520, 162, 14, black);

  return await pdfDoc.save();
};

const processPdfExportJob = async (env: EnvConfig, jobId: string) => {
  const adminClient = createServiceClient(env);
  const sourceJob = await fetchJob(adminClient, jobId);
  if (!sourceJob || sourceJob.status === "cancelled") return;

  const pdfConfig = await fetchPdfTemplateConfig(adminClient);
  const items = Array.isArray(sourceJob.items) ? sourceJob.items : [];
  const archiveName = toTrimmedString(sourceJob.archive_name) || buildPdfArchiveName(
    sourceJob.mode_label,
    items.length,
    sourceJob.use_filters !== false,
    sourceJob.filter_snapshot || {},
    pdfConfig,
  );

  await updateJob(adminClient, jobId, {
    status: "running",
    started_at: sourceJob.started_at ?? new Date().toISOString(),
    finished_at: null,
    archive_name: archiveName,
    archive_path: null,
    progress_text: items.length ? `Preparing 1/${items.length} PDF...` : "Preparing ZIP archive...",
    error_message: "",
    cancel_requested: false,
    completed_count: 0,
  });

  try {
    if (!items.length) throw new Error("No records available for export.");

    const zip = new JSZip();
    const usedPaths = new Set<string>();

    for (let i = 0; i < items.length; i += 1) {
      const latestJob = await fetchJob(adminClient, jobId);
      if (!latestJob) throw new Error("Export job was not found.");
      if (latestJob.cancel_requested || latestJob.status === "cancelled") {
        throw new Error("__PDF_EXPORT_CANCELLED__");
      }

      const app = items[i];
      const pdfBytes = await createPdfBytes(app, pdfConfig);
      const baseName = buildPdfFileBaseName(app, pdfConfig);
      let zipPath = buildPdfZipEntryPath(app, latestJob.folder_mode || "flat", `${baseName}.pdf`);
      let suffix = 2;
      while (usedPaths.has(zipPath)) {
        zipPath = buildPdfZipEntryPath(app, latestJob.folder_mode || "flat", `${baseName}_${suffix}.pdf`);
        suffix += 1;
      }
      usedPaths.add(zipPath);
      zip.file(zipPath, pdfBytes);

      await updateJob(adminClient, jobId, {
        completed_count: i + 1,
        progress_text: i + 1 >= items.length
          ? "Building ZIP archive..."
          : `Generating ${i + 2}/${items.length} PDF...`,
      });
    }

    const zipBytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const archivePath = `jobs/${jobId}/${sanitizeFileName(archiveName, "pdf-export.zip")}`;
    const uploadResult = await adminClient.storage.from(PDF_EXPORT_BUCKET).upload(archivePath, zipBytes, {
      upsert: true,
      contentType: "application/zip",
    });
    if (uploadResult.error) throw new Error(uploadResult.error.message || "Failed to upload ZIP archive.");

    await updateJob(adminClient, jobId, {
      status: "completed",
      finished_at: new Date().toISOString(),
      completed_count: items.length,
      archive_name: archiveName,
      archive_path: archivePath,
      progress_text: `Generated ${items.length} PDFs. ZIP is ready.`,
      error_message: "",
      cancel_requested: false,
    });
  } catch (error) {
    const latestJob = await fetchJob(adminClient, jobId).catch(() => null);
    const isCancelled = error instanceof Error && error.message === "__PDF_EXPORT_CANCELLED__";
    await updateJob(adminClient, jobId, {
      status: isCancelled ? "cancelled" : "failed",
      finished_at: new Date().toISOString(),
      progress_text: isCancelled
        ? `Job cancelled at ${latestJob?.completed_count || 0}/${latestJob?.total_count || items.length}.`
        : `Job failed at ${latestJob?.completed_count || 0}/${latestJob?.total_count || items.length}.`,
      error_message: isCancelled ? "" : (error instanceof Error ? error.message : "Background ZIP export failed."),
      cancel_requested: false,
    }).catch((innerError) => {
      console.error("Failed to update PDF export job after error.", innerError);
    });
  }
};

const enqueueBackgroundJob = (env: EnvConfig, jobId: string) => {
  const task = processPdfExportJob(env, jobId).catch((error) => {
    console.error("PDF export background job failed.", error);
  });
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(task);
  } else {
    void task;
  }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const context = await resolveContext(req);
    const body = await req.json().catch(() => ({}));
    const action = toTrimmedString(body?.action || "queue");

    if (action === "queue") {
      const items = Array.isArray(body?.items) ? body.items as ExportItem[] : [];
      if (!items.length) return json(400, { ok: false, error: "No records available for export." });
      if (items.length > 200) return json(400, { ok: false, error: "A single export can include at most 200 PDFs." });

      const filterSnapshot = snapshotFilter(body?.filterSnapshot);
      const pdfConfig = await fetchPdfTemplateConfig(context.adminClient);
      const archiveName = buildPdfArchiveName(
        toTrimmedString(body?.modeLabel) || "PDF Export",
        items.length,
        body?.useFilters !== false,
        filterSnapshot,
        pdfConfig,
      );

      const { data: job, error } = await context.adminClient
        .from("pdf_export_jobs")
        .insert({
          created_by: context.userId,
          created_by_name: context.requesterName,
          status: "queued",
          mode_label: toTrimmedString(body?.modeLabel) || "PDF Export",
          filter_snapshot: filterSnapshot,
          filter_summary: toTrimmedString(body?.filterSummary) || "All approved",
          folder_mode: filterSnapshot.folderMode,
          items,
          total_count: items.length,
          completed_count: 0,
          archive_name: archiveName,
          archive_path: null,
          progress_text: `Queued ${items.length} PDFs.`,
          error_message: "",
          use_filters: body?.useFilters !== false,
          cancel_requested: false,
        })
        .select("*")
        .single();

      if (error || !job) throw new Error(error?.message || "Failed to create PDF export job.");

      enqueueBackgroundJob(context.env, String(job.id));
      return json(200, { ok: true, job });
    }

    if (action === "signed_url") {
      const jobId = toTrimmedString(body?.jobId);
      if (!jobId) return json(400, { ok: false, error: "Missing jobId." });
      const job = await fetchJob(context.adminClient, jobId);
      if (!job) return json(404, { ok: false, error: "Export job not found." });
      if (job.status !== "completed" || !job.archive_path) {
        return json(400, { ok: false, error: "This job does not have a downloadable ZIP yet." });
      }

      const signed = await context.adminClient.storage
        .from(PDF_EXPORT_BUCKET)
        .createSignedUrl(job.archive_path, 60 * 15, { download: job.archive_name || true });

      if (signed.error || !signed.data?.signedUrl) {
        throw new Error(signed.error?.message || "Failed to create signed download URL.");
      }

      return json(200, {
        ok: true,
        url: signed.data.signedUrl,
        fileName: job.archive_name,
      });
    }

    if (action === "cancel") {
      const jobId = toTrimmedString(body?.jobId);
      if (!jobId) return json(400, { ok: false, error: "Missing jobId." });
      const job = await fetchJob(context.adminClient, jobId);
      if (!job) return json(404, { ok: false, error: "Export job not found." });

      if (job.status === "queued") {
        await updateJob(context.adminClient, jobId, {
          status: "cancelled",
          finished_at: new Date().toISOString(),
          progress_text: `Job cancelled at ${job.completed_count}/${job.total_count}.`,
          cancel_requested: false,
        });
      } else if (job.status === "running") {
        await updateJob(context.adminClient, jobId, {
          cancel_requested: true,
          progress_text: "Cancelling export job...",
        });
      }

      return json(200, { ok: true });
    }

    if (action === "retry") {
      const jobId = toTrimmedString(body?.jobId);
      if (!jobId) return json(400, { ok: false, error: "Missing jobId." });
      const job = await fetchJob(context.adminClient, jobId);
      if (!job) return json(404, { ok: false, error: "Export job not found." });
      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        return json(400, { ok: false, error: "Cancel the running job before retrying it." });
      }

      await removeArchiveIfPresent(context.adminClient, job);
      const pdfConfig = await fetchPdfTemplateConfig(context.adminClient);
      await updateJob(context.adminClient, jobId, {
        status: "queued",
        started_at: null,
        finished_at: null,
        completed_count: 0,
        archive_path: null,
        archive_name: buildPdfArchiveName(
          job.mode_label,
          job.total_count,
          job.use_filters !== false,
          job.filter_snapshot || {},
          pdfConfig,
        ),
        progress_text: `Queued ${job.total_count} PDFs.`,
        error_message: "",
        cancel_requested: false,
      });

      enqueueBackgroundJob(context.env, jobId);
      return json(200, { ok: true });
    }

    if (action === "delete") {
      const jobId = toTrimmedString(body?.jobId);
      if (!jobId) return json(400, { ok: false, error: "Missing jobId." });
      const job = await fetchJob(context.adminClient, jobId);
      if (!job) return json(404, { ok: false, error: "Export job not found." });
      if (job.status === "running") {
        return json(400, { ok: false, error: "Stop the running job before deleting it." });
      }

      await removeArchiveIfPresent(context.adminClient, job);
      const { error } = await context.adminClient.from("pdf_export_jobs").delete().eq("id", jobId);
      if (error) throw new Error(error.message || "Failed to delete PDF export job.");
      return json(200, { ok: true });
    }

    if (action === "clear_finished") {
      const { data: jobs, error } = await context.adminClient
        .from("pdf_export_jobs")
        .select("id, archive_path, status")
        .in("status", Array.from(FINISHED_JOB_STATUSES));

      if (error) throw new Error(error.message || "Failed to list finished export jobs.");

      const removableJobs = Array.isArray(jobs) ? jobs : [];
      const archivePaths = removableJobs.map((job) => toTrimmedString(job.archive_path)).filter(Boolean);
      if (archivePaths.length) {
        const removeResult = await context.adminClient.storage.from(PDF_EXPORT_BUCKET).remove(archivePaths);
        if (removeResult.error) throw new Error(removeResult.error.message || "Failed to remove ZIP archives.");
      }

      if (removableJobs.length) {
        const deleteResult = await context.adminClient.from("pdf_export_jobs").delete().in("id", removableJobs.map((job) => job.id));
        if (deleteResult.error) throw new Error(deleteResult.error.message || "Failed to clear finished export jobs.");
      }

      return json(200, { ok: true, count: removableJobs.length });
    }

    return json(400, { ok: false, error: "Unsupported action." });
  } catch (error) {
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown PDF export job error.",
    });
  }
});
