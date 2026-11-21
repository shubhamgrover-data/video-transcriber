import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { getSettings } from "./src/config.ts";
import {
  ALLOWED_ENGINES,
  ALLOWED_UPLOAD_EXTENSIONS,
  ALLOWED_WHISPER_MODELS,
  SUPPORTED_PLATFORMS,
  type HealthResponse,
  type JobListResponse,
  type JobStep,
  type RetryJobRequest,
  type TranscribeRequest,
  type TranscriptionEngine,
} from "./src/models.ts";
import {
  toJsonExport,
  toPlainTxt,
  toSrt,
  toTimestampedTxt,
  toVtt,
} from "./src/services/formatter.ts";
import type { ExtractedMedia } from "./src/services/media.ts";
import {
  PipelineStepError,
  transcribeFile,
  transcribeUrl,
} from "./src/services/pipeline.ts";
import { detectAvailableEngines } from "./src/services/transcriber.ts";
import { parseVideoUrl } from "./src/services/urlParser.ts";
import { JobStore, type JobCheckpoint } from "./src/store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const settings = getSettings();
const store = new JobStore();
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(
        settings.tempDir,
        `upload_${crypto.randomBytes(6).toString("hex")}`,
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext =
        path.extname(file.originalname || "uploaded_video.mp4").toLowerCase() ||
        ".mp4";
      cb(null, `source${ext}`);
    },
  }),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB
  },
});

function isValidEngine(value: unknown): value is TranscriptionEngine {
  return (
    typeof value === "string" &&
    (ALLOWED_ENGINES as readonly string[]).includes(value)
  );
}

function isValidWhisperModel(value: string): boolean {
  return (ALLOWED_WHISPER_MODELS as readonly string[]).includes(value);
}

function cleanupJobArtifacts(jobId: string, checkpoint: JobCheckpoint | null): void {
  if (!settings.cleanupAudio) return;

  const audioDir = path.join(settings.tempDir, jobId);
  if (fs.existsSync(audioDir)) {
    fs.rmSync(audioDir, { recursive: true, force: true });
  }

  if (checkpoint?.uploadedFilePath) {
    const uploadDir = path.dirname(checkpoint.uploadedFilePath);
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  }
}

function buildCachedMedia(checkpoint: JobCheckpoint): ExtractedMedia | null {
  if (
    !checkpoint.extractedAudioPath ||
    !fs.existsSync(checkpoint.extractedAudioPath)
  ) {
    return null;
  }
  return {
    audioPath: checkpoint.extractedAudioPath,
    title:
      checkpoint.extractedMedia?.title ||
      checkpoint.originalFilename ||
      "Untitled Video",
    uploader: checkpoint.extractedMedia?.uploader ?? null,
    durationSec: checkpoint.extractedMedia?.durationSec ?? null,
    thumbnailUrl: checkpoint.extractedMedia?.thumbnailUrl ?? null,
  };
}

async function runJob(jobId: string): Promise<void> {
  const checkpoint = store.getCheckpoint(jobId);
  if (!checkpoint) {
    store.updateJob(jobId, {
      status: "failed",
      progress: 100,
      stage_message: "Job checkpoint missing",
      error: "Job configuration is no longer available.",
      failed_step: "extracting",
    });
    return;
  }

  const cachedMedia = buildCachedMedia(checkpoint);

  const onMediaExtracted = (media: ExtractedMedia) => {
    store.updateCheckpoint(jobId, {
      extractedAudioPath: media.audioPath,
      extractedMedia: {
        title: media.title,
        uploader: media.uploader,
        durationSec: media.durationSec,
        thumbnailUrl: media.thumbnailUrl,
      },
    });
    // Persist discovered metadata immediately so even if transcribing fails, title & duration show up
    store.updateJob(jobId, {
      title: media.title,
      uploader: media.uploader,
      duration_sec: media.durationSec,
      thumbnail_url: media.thumbnailUrl,
    });
    // Once local raw file has been extracted to compact MP3, we can free the raw upload dir
    if (settings.cleanupAudio && checkpoint.uploadedFilePath) {
      const uploadDir = path.dirname(checkpoint.uploadedFilePath);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
      store.updateCheckpoint(jobId, { uploadedFilePath: null });
    }
  };

  try {
    const output =
      checkpoint.sourceType === "url"
        ? await transcribeUrl(checkpoint.rawUrl || "", {
            engine: checkpoint.engine,
            language: checkpoint.language,
            whisperModel: checkpoint.whisperModel,
            preferCaptions: checkpoint.preferCaptions,
            settings,
            jobId,
            cachedMedia,
            onMediaExtracted,
            onProgress: (stage, progress, message) => {
              store.updateJob(jobId, {
                status: stage,
                progress,
                stage_message: message,
              });
            },
          })
        : await transcribeFile(checkpoint.uploadedFilePath ?? null, {
            originalFilename: checkpoint.originalFilename || "uploaded_media",
            engine: checkpoint.engine,
            language: checkpoint.language,
            whisperModel: checkpoint.whisperModel,
            settings,
            jobId,
            cachedMedia,
            onMediaExtracted,
            onProgress: (stage, progress, message) => {
              store.updateJob(jobId, {
                status: stage,
                progress,
                stage_message: message,
              });
            },
          });

    // Clear checkpoint paths once completed and clean up any leftover upload files
    const latestCp = store.getCheckpoint(jobId);
    cleanupJobArtifacts(jobId, latestCp);
    store.updateCheckpoint(jobId, {
      extractedAudioPath: null,
      uploadedFilePath: null,
    });

    store.updateJob(jobId, {
      status: "completed",
      progress: 100,
      stage_message: "Transcription completed",
      title: output.title,
      uploader: output.uploader,
      duration_sec: output.durationSec,
      thumbnail_url: output.thumbnailUrl,
      engine_used: output.engineUsed,
      language: output.language,
      segments: output.segments,
      full_text: output.fullText,
      error: null,
      failed_step: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedStep: JobStep =
      err instanceof PipelineStepError ? err.step : "transcribing";
    const latestCp = store.getCheckpoint(jobId);
    const audioCached = Boolean(
      latestCp?.extractedAudioPath && fs.existsSync(latestCp.extractedAudioPath),
    );

    store.updateJob(jobId, {
      status: "failed",
      progress: failedStep === "transcribing" ? 65 : 30,
      stage_message:
        failedStep === "transcribing" && audioCached
          ? "Failed during transcribing (audio cached — retry skips download)"
          : `Failed during ${failedStep}`,
      error: message,
      failed_step: failedStep,
    });
  }
}

app.get("/api/health", (_req: Request, res: Response) => {
  const payload: HealthResponse = {
    status: "ok",
    app_name: settings.appName,
    default_engine: settings.defaultEngine,
    default_whisper_model: settings.whisperModel,
    supported_platforms: [...SUPPORTED_PLATFORMS],
    available_engines: detectAvailableEngines(settings),
  };
  res.json(payload);
});

app.post("/api/transcribe", (req: Request, res: Response) => {
  const body = (req.body || {}) as Partial<TranscribeRequest>;
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";

  if (rawUrl.length < 8 || rawUrl.length > 2048) {
    res.status(400).json({
      detail: "Please provide a valid YouTube, Facebook, or Instagram video URL.",
    });
    return;
  }

  const engine: TranscriptionEngine = isValidEngine(body.engine)
    ? body.engine
    : "auto";
  const whisperModel =
    typeof body.whisper_model === "string" && body.whisper_model.trim()
      ? body.whisper_model.trim()
      : null;
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim().slice(0, 12)
      : null;
  const preferCaptions =
    typeof body.prefer_captions === "boolean" ? body.prefer_captions : true;

  if (whisperModel && !isValidWhisperModel(whisperModel)) {
    res.status(400).json({
      detail: `Unsupported whisper_model '${whisperModel}'. Choose from: ${ALLOWED_WHISPER_MODELS.join(", ")}.`,
    });
    return;
  }

  let parsed;
  try {
    parsed = parseVideoUrl(rawUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid video URL.";
    res.status(400).json({ detail: message });
    return;
  }

  const jobId = crypto.randomBytes(6).toString("hex");
  const job = store.createJob(
    {
      jobId,
      url: parsed.originalUrl,
      canonicalUrl: parsed.canonicalUrl,
      platform: parsed.platform,
      videoId: parsed.videoId,
      language,
      requestedEngine: engine,
      requestedWhisperModel: whisperModel,
    },
    {
      sourceType: "url",
      rawUrl,
      preferCaptions,
      engine,
      language,
      whisperModel,
    },
  );

  setImmediate(() => {
    void runJob(jobId);
  });

  res.status(202).json(job);
});

app.post(
  "/api/transcribe/upload",
  upload.single("file"),
  (req: Request, res: Response) => {
    const uploaded = req.file;
    if (!uploaded) {
      res.status(400).json({ detail: "Please upload a video or audio file." });
      return;
    }

    const filename = (uploaded.originalname || "uploaded_video.mp4").trim();
    const suffix = path.extname(filename).toLowerCase();
    const cleanupUploadedDir = () => {
      const dir = path.dirname(uploaded.path);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    if (!ALLOWED_UPLOAD_EXTENSIONS.has(suffix)) {
      cleanupUploadedDir();
      const allowed = Array.from(ALLOWED_UPLOAD_EXTENSIONS).sort().join(", ");
      res.status(400).json({
        detail: `Unsupported file type '${suffix}'. Allowed: ${allowed}.`,
      });
      return;
    }

    const rawEngine = req.body?.engine;
    const engine: TranscriptionEngine = isValidEngine(rawEngine)
      ? rawEngine
      : "auto";
    const whisperModel =
      typeof req.body?.whisper_model === "string" &&
      req.body.whisper_model.trim()
        ? req.body.whisper_model.trim()
        : null;
    const language =
      typeof req.body?.language === "string" && req.body.language.trim()
        ? req.body.language.trim().slice(0, 12)
        : null;

    if (whisperModel && !isValidWhisperModel(whisperModel)) {
      cleanupUploadedDir();
      res.status(400).json({
        detail: `Unsupported whisper_model '${whisperModel}'. Choose from: ${ALLOWED_WHISPER_MODELS.join(", ")}.`,
      });
      return;
    }

    const jobId = crypto.randomBytes(6).toString("hex");
    store.createJob(
      {
        jobId,
        url: `local://${filename}`,
        canonicalUrl: `local://${filename}`,
        platform: "local",
        videoId: jobId,
        language,
        requestedEngine: engine,
        requestedWhisperModel: whisperModel,
      },
      {
        sourceType: "file",
        preferCaptions: false,
        engine,
        language,
        whisperModel,
        uploadedFilePath: uploaded.path,
        originalFilename: filename,
      },
    );
    const updated = store.updateJob(jobId, {
      title: path.parse(filename).name || "Uploaded Media",
      uploader: "Local Upload",
    });

    setImmediate(() => {
      void runJob(jobId);
    });

    res.status(202).json(updated);
  },
);

app.post("/api/jobs/:jobId/retry", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const existing = store.getJob(jobId);
  if (!existing) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (existing.status !== "failed") {
    res.status(409).json({
      detail: `Only failed jobs can be retried (current status: '${existing.status}').`,
    });
    return;
  }
  if (!existing.can_retry) {
    res.status(409).json({
      detail:
        "This job's cached media is no longer available on disk. Please submit a new job.",
    });
    return;
  }

  const checkpoint = store.getCheckpoint(jobId);
  if (!checkpoint) {
    res.status(409).json({
      detail: "Job checkpoint is unavailable. Please submit a new job.",
    });
    return;
  }

  const body = (req.body || {}) as Partial<RetryJobRequest>;
  let nextEngine = checkpoint.engine;
  if (body.engine !== undefined && body.engine !== null) {
    if (!isValidEngine(body.engine)) {
      res.status(400).json({
        detail: `Unsupported engine '${String(body.engine)}'. Choose from: ${ALLOWED_ENGINES.join(", ")}.`,
      });
      return;
    }
    nextEngine = body.engine;
  }

  let nextWhisperModel = checkpoint.whisperModel;
  if (typeof body.whisper_model === "string") {
    const trimmed = body.whisper_model.trim();
    if (trimmed && !isValidWhisperModel(trimmed)) {
      res.status(400).json({
        detail: `Unsupported whisper_model '${trimmed}'. Choose from: ${ALLOWED_WHISPER_MODELS.join(", ")}.`,
      });
      return;
    }
    nextWhisperModel = trimmed || null;
  }

  const nextLanguage =
    body.language !== undefined
      ? typeof body.language === "string" && body.language.trim()
        ? body.language.trim().slice(0, 12)
        : null
      : checkpoint.language;

  store.updateCheckpoint(jobId, {
    engine: nextEngine,
    whisperModel: nextWhisperModel,
    language: nextLanguage,
  });

  const resumingFromTranscribing = existing.cached_audio_ready;
  const nextRetryCount = existing.retry_count + 1;
  const updated = store.updateJob(jobId, {
    status: resumingFromTranscribing ? "transcribing" : "queued",
    progress: resumingFromTranscribing ? 65 : 10,
    stage_message: resumingFromTranscribing
      ? `Retry #${nextRetryCount}: Resuming from transcribing step using cached audio...`
      : `Retry #${nextRetryCount}: Resuming from extracting step...`,
    error: null,
    failed_step: null,
    retry_count: nextRetryCount,
    requested_engine: nextEngine,
    requested_whisper_model: nextWhisperModel,
    language: nextLanguage,
  });

  setImmediate(() => {
    void runJob(jobId);
  });

  res.status(202).json(updated);
});

app.get("/api/jobs", (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.floor(rawLimit)))
    : 25;
  const jobs = store.listJobs(limit);
  const payload: JobListResponse = { jobs, total: jobs.length };
  res.json(payload);
});

app.get("/api/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = store.getJob(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  res.json(job);
});

app.delete("/api/jobs/:jobId", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const { deleted, checkpoint } = store.deleteJob(jobId);
  if (!deleted) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  cleanupJobArtifacts(jobId, checkpoint);
  res.json({ deleted: true });
});

app.get("/api/jobs/:jobId/export", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const fmt = String(req.query.fmt || "srt").toLowerCase();
  if (!["srt", "vtt", "txt", "plain", "json"].includes(fmt)) {
    res.status(400).json({
      detail: "Unsupported export format. Choose from: srt, vtt, txt, plain, json.",
    });
    return;
  }

  const job = store.getJob(jobId);
  if (!job) {
    res.status(404).json({ detail: "Job not found." });
    return;
  }
  if (job.status !== "completed") {
    res.status(409).json({ detail: "Transcript is not ready yet." });
    return;
  }

  const safeStem = `transcript_${job.platform}_${job.video_id || job.id}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );

  if (fmt === "srt") {
    res
      .type("application/x-subrip; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${safeStem}.srt"`)
      .send(toSrt(job.segments));
    return;
  }
  if (fmt === "vtt") {
    res
      .type("text/vtt; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${safeStem}.vtt"`)
      .send(toVtt(job.segments));
    return;
  }
  if (fmt === "txt") {
    res
      .type("text/plain; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${safeStem}_timestamps.txt"`,
      )
      .send(toTimestampedTxt(job.segments));
    return;
  }
  if (fmt === "plain") {
    res
      .type("text/plain; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${safeStem}.txt"`)
      .send(toPlainTxt(job.segments));
    return;
  }

  const content = toJsonExport(job.segments, {
    id: job.id,
    platform: job.platform,
    url: job.canonical_url,
    title: job.title,
    uploader: job.uploader,
    duration_sec: job.duration_sec,
    language: job.language,
    engine_used: job.engine_used,
  });
  res
    .type("application/json; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="${safeStem}.json"`)
    .send(content);
});

app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: settings.appName,
      version: "2.0.0",
      description:
        "Submit YouTube, Facebook, or Instagram links — or upload local video/audio files — for timestamped transcription and SRT/VTT/TXT/JSON export.",
    },
    paths: {
      "/api/health": { get: { summary: "Service health & available engines" } },
      "/api/transcribe": { post: { summary: "Submit a video URL transcription job" } },
      "/api/transcribe/upload": { post: { summary: "Upload a local media file for transcription" } },
      "/api/jobs": { get: { summary: "List recent transcription jobs" } },
      "/api/jobs/{jobId}": {
        get: { summary: "Fetch transcription job status and segments" },
        delete: { summary: "Delete a transcription job" },
      },
      "/api/jobs/{jobId}/retry": {
        post: {
          summary:
            "Resume a failed job from its failed step only (skips download/ffmpeg when audio is cached)",
        },
      },
      "/api/jobs/{jobId}/export": {
        get: { summary: "Download transcript in srt, vtt, txt, plain, or json format" },
      },
    },
  });
});

app.get("/docs", (_req: Request, res: Response) => {
  res.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClipScribe — API Docs</title>
  <link rel="stylesheet" href="/static/styles.css" />
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">CS</div>
        <div>
          <h1>ClipScribe API Documentation</h1>
          <p class="subtitle">REST Endpoints (v2.0.0)</p>
        </div>
      </div>
      <div class="header-actions">
        <a href="/openapi.json" class="btn btn-secondary small-btn">OpenAPI JSON</a>
        <a href="/" class="btn btn-primary small-btn">Back to App</a>
      </div>
    </header>
    <div class="card" style="display:flex;flex-direction:column;gap:12px;">
      <div class="segment-row"><span class="timestamp-btn">GET</span><div class="segment-text"><strong>/api/health</strong> — Service health, defaults, and available engines.</div></div>
      <div class="segment-row"><span class="timestamp-btn">POST</span><div class="segment-text"><strong>/api/transcribe</strong> — JSON body <code>{ url, engine, whisper_model, language, prefer_captions }</code>. Returns 202 with job record.</div></div>
      <div class="segment-row"><span class="timestamp-btn">POST</span><div class="segment-text"><strong>/api/transcribe/upload</strong> — Multipart form upload with <code>file</code>, <code>engine</code>, <code>whisper_model</code>, <code>language</code>.</div></div>
      <div class="segment-row"><span class="timestamp-btn">GET</span><div class="segment-text"><strong>/api/jobs?limit=25</strong> — List recent transcription jobs.</div></div>
      <div class="segment-row"><span class="timestamp-btn">GET</span><div class="segment-text"><strong>/api/jobs/:jobId</strong> — Get job progress, metadata, and timestamped segments.</div></div>
      <div class="segment-row"><span class="timestamp-btn">POST</span><div class="segment-text"><strong>/api/jobs/:jobId/retry</strong> — Optional JSON body <code>{ engine, whisper_model, language }</code>. Resumes from the failed step only (reuses cached 16kHz audio if extraction already succeeded).</div></div>
      <div class="segment-row"><span class="timestamp-btn">DELETE</span><div class="segment-text"><strong>/api/jobs/:jobId</strong> — Remove a job and clean up any cached audio artifacts.</div></div>
      <div class="segment-row"><span class="timestamp-btn">GET</span><div class="segment-text"><strong>/api/jobs/:jobId/export?fmt=srt|vtt|txt|plain|json</strong> — Download formatted transcript.</div></div>
    </div>
  </div>
</body>
</html>`);
});

const publicDir = path.join(__dirname, "public");
app.use("/static", express.static(publicDir));

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(settings.port, settings.host, () => {
  console.log(
    `[ClipScribe] Server running on http://${settings.host}:${settings.port}`,
  );
});
