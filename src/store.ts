import fs from "node:fs";
import type {
  JobResponse,
  JobStatus,
  JobStep,
  Platform,
  TranscriptSegment,
  TranscriptionEngine,
} from "./models.ts";

export interface CreateJobInput {
  jobId: string;
  url: string;
  canonicalUrl: string;
  platform: Platform;
  videoId: string | null;
  language: string | null;
  requestedEngine: TranscriptionEngine;
  requestedWhisperModel: string | null;
}

export interface UpdateJobInput {
  status?: JobStatus;
  progress?: number;
  stage_message?: string;
  title?: string | null;
  uploader?: string | null;
  duration_sec?: number | null;
  thumbnail_url?: string | null;
  engine_used?: string | null;
  requested_engine?: TranscriptionEngine;
  requested_whisper_model?: string | null;
  language?: string | null;
  segments?: TranscriptSegment[];
  full_text?: string;
  error?: string | null;
  failed_step?: JobStep | null;
  retry_count?: number;
}

export interface CachedMediaMeta {
  title: string;
  uploader: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export interface JobCheckpoint {
  sourceType: "url" | "file";
  rawUrl?: string;
  preferCaptions: boolean;
  engine: TranscriptionEngine;
  language: string | null;
  whisperModel: string | null;
  uploadedFilePath?: string | null;
  originalFilename?: string | null;
  extractedAudioPath?: string | null;
  extractedMedia?: CachedMediaMeta | null;
}

/**
 * In-memory job store with step checkpoints for resumable retries.
 */
export class JobStore {
  private readonly jobs = new Map<string, JobResponse>();
  private readonly checkpoints = new Map<string, JobCheckpoint>();

  private hydrate(job: JobResponse): JobResponse {
    const cp = this.checkpoints.get(job.id);
    const cachedAudioReady = Boolean(
      cp?.extractedAudioPath && fs.existsSync(cp.extractedAudioPath),
    );
    const hasUploadedFile = Boolean(
      cp?.uploadedFilePath && fs.existsSync(cp.uploadedFilePath),
    );
    const canRetry =
      job.status === "failed" &&
      Boolean(cp) &&
      (cachedAudioReady || cp?.sourceType === "url" || hasUploadedFile);

    return {
      ...job,
      segments: [...job.segments],
      cached_audio_ready: cachedAudioReady,
      can_retry: canRetry,
    };
  }

  createJob(input: CreateJobInput, checkpoint: JobCheckpoint): JobResponse {
    const now = new Date().toISOString();
    const job: JobResponse = {
      id: input.jobId,
      url: input.url,
      canonical_url: input.canonicalUrl,
      platform: input.platform,
      video_id: input.videoId,
      title: null,
      uploader: null,
      duration_sec: null,
      thumbnail_url: null,
      status: "queued",
      progress: 5,
      stage_message: "Queued for processing",
      engine_used: null,
      requested_engine: input.requestedEngine,
      requested_whisper_model: input.requestedWhisperModel,
      language: input.language,
      segments: [],
      full_text: "",
      error: null,
      failed_step: null,
      retry_count: 0,
      can_retry: false,
      cached_audio_ready: false,
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(job.id, job);
    this.checkpoints.set(job.id, { ...checkpoint });
    return this.hydrate(job);
  }

  updateJob(jobId: string, updates: UpdateJobInput): JobResponse | null {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;

    const updated: JobResponse = {
      ...existing,
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.progress !== undefined
        ? { progress: Math.max(0, Math.min(100, updates.progress)) }
        : {}),
      ...(updates.stage_message !== undefined
        ? { stage_message: updates.stage_message }
        : {}),
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.uploader !== undefined ? { uploader: updates.uploader } : {}),
      ...(updates.duration_sec !== undefined
        ? { duration_sec: updates.duration_sec }
        : {}),
      ...(updates.thumbnail_url !== undefined
        ? { thumbnail_url: updates.thumbnail_url }
        : {}),
      ...(updates.engine_used !== undefined
        ? { engine_used: updates.engine_used }
        : {}),
      ...(updates.requested_engine !== undefined
        ? { requested_engine: updates.requested_engine }
        : {}),
      ...(updates.requested_whisper_model !== undefined
        ? { requested_whisper_model: updates.requested_whisper_model }
        : {}),
      ...(updates.language !== undefined ? { language: updates.language } : {}),
      ...(updates.segments !== undefined ? { segments: updates.segments } : {}),
      ...(updates.full_text !== undefined
        ? { full_text: updates.full_text }
        : {}),
      ...(updates.error !== undefined ? { error: updates.error } : {}),
      ...(updates.failed_step !== undefined
        ? { failed_step: updates.failed_step }
        : {}),
      ...(updates.retry_count !== undefined
        ? { retry_count: updates.retry_count }
        : {}),
      updated_at: new Date().toISOString(),
    };

    this.jobs.set(jobId, updated);
    return this.hydrate(updated);
  }

  getCheckpoint(jobId: string): JobCheckpoint | null {
    const cp = this.checkpoints.get(jobId);
    return cp ? { ...cp } : null;
  }

  updateCheckpoint(
    jobId: string,
    partial: Partial<JobCheckpoint>,
  ): JobCheckpoint | null {
    const existing = this.checkpoints.get(jobId);
    if (!existing) return null;
    const merged: JobCheckpoint = { ...existing, ...partial };
    this.checkpoints.set(jobId, merged);
    return { ...merged };
  }

  getJob(jobId: string): JobResponse | null {
    const job = this.jobs.get(jobId);
    return job ? this.hydrate(job) : null;
  }

  listJobs(limit = 25): JobResponse[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((job) => this.hydrate(job));
  }

  deleteJob(jobId: string): { deleted: boolean; checkpoint: JobCheckpoint | null } {
    const checkpoint = this.checkpoints.get(jobId) ?? null;
    this.checkpoints.delete(jobId);
    const deleted = this.jobs.delete(jobId);
    return { deleted, checkpoint };
  }
}
