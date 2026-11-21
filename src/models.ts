export type Platform = "youtube" | "facebook" | "instagram" | "local";

export const SUPPORTED_PLATFORMS: readonly Platform[] = [
  "youtube",
  "facebook",
  "instagram",
  "local",
];

export type JobStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "completed"
  | "failed";

export type JobStep = "extracting" | "transcribing";

export type TranscriptionEngine =
  | "auto"
  | "deepgram"
  | "gemini"
  | "faster_whisper"
  | "groq"
  | "openai"
  | "demo";

export const ALLOWED_ENGINES: readonly TranscriptionEngine[] = [
  "auto",
  "deepgram",
  "gemini",
  "faster_whisper",
  "groq",
  "openai",
  "demo",
];

export const ALLOWED_WHISPER_MODELS = [
  "tiny",
  "base",
  "small",
  "medium",
  "large-v3",
] as const;

export type WhisperModel = (typeof ALLOWED_WHISPER_MODELS)[number];

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
]);

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface TranscribeRequest {
  url: string;
  language?: string | null;
  engine?: TranscriptionEngine;
  whisper_model?: string | null;
  prefer_captions?: boolean;
}

export interface RetryJobRequest {
  engine?: TranscriptionEngine;
  whisper_model?: string | null;
  language?: string | null;
}

export interface JobResponse {
  id: string;
  url: string;
  canonical_url: string;
  platform: Platform;
  video_id: string | null;
  title: string | null;
  uploader: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  status: JobStatus;
  progress: number;
  stage_message: string;
  engine_used: string | null;
  requested_engine: TranscriptionEngine;
  requested_whisper_model: string | null;
  language: string | null;
  segments: TranscriptSegment[];
  full_text: string;
  error: string | null;
  failed_step: JobStep | null;
  retry_count: number;
  can_retry: boolean;
  cached_audio_ready: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobListResponse {
  jobs: JobResponse[];
  total: number;
}

export interface HealthResponse {
  status: string;
  app_name: string;
  default_engine: string;
  default_whisper_model: string;
  supported_platforms: Platform[];
  available_engines: Record<string, boolean>;
}
