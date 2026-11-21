import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Settings {
  appName: string;
  host: string;
  port: number;
  tempDir: string;
  defaultEngine: string;
  preferYoutubeCaptions: boolean;
  whisperServiceUrl: string;
  whisperServiceTimeoutSec: number;
  whisperModel: string;
  whisperDevice: string;
  whisperComputeType: string;
  geminiApiKey: string;
  deepgramApiKey: string;
  deepgramModel: string;
  groqApiKey: string;
  groqModel: string;
  openaiApiKey: string;
  openaiModel: string;
  cookiesFile: string;
  proxyUrl: string;
  maxVideoDurationSec: number;
  cleanupAudio: boolean;
}

export function getSettings(): Settings {
  const tempDir = process.env.TEMP_DIR || path.join(os.tmpdir(), "clipscribe");
  fs.mkdirSync(tempDir, { recursive: true });

  return {
    appName: process.env.APP_NAME || "ClipScribe — Video Transcription Service",
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || "3000"),
    tempDir,
    defaultEngine: process.env.TRANSCRIPTION_ENGINE || "auto",
    preferYoutubeCaptions:
      (process.env.PREFER_YOUTUBE_CAPTIONS || "true").toLowerCase() === "true",
    whisperServiceUrl: (process.env.WHISPER_SERVICE_URL || "").replace(/\/+$/, ""),
    whisperServiceTimeoutSec: Number(
      process.env.WHISPER_SERVICE_TIMEOUT_SEC || "1800",
    ),
    whisperModel: process.env.WHISPER_MODEL || "base",
    whisperDevice: process.env.WHISPER_DEVICE || "auto",
    whisperComputeType: process.env.WHISPER_COMPUTE_TYPE || "int8",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
    deepgramModel: process.env.DEEPGRAM_MODEL || "nova-3",
    groqApiKey: process.env.GROQ_API_KEY || "",
    groqModel: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_WHISPER_MODEL || "whisper-1",
    cookiesFile: process.env.COOKIES_FILE || "",
    proxyUrl: process.env.PROXY_URL || "",
    maxVideoDurationSec: Number(process.env.MAX_VIDEO_DURATION_SEC || "7200"),
    cleanupAudio: (process.env.CLEANUP_AUDIO || "true").toLowerCase() === "true",
  };
}
