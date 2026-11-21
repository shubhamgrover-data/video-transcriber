import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Settings } from "../config.ts";

const execFileAsync = promisify(execFile);

const YT_DLP_DOWNLOAD_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

let ytDlpBootstrapPromise: Promise<string> | null = null;

export interface ExtractedMedia {
  audioPath: string;
  title: string;
  uploader: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

export async function ensureYtDlp(settings: Settings): Promise<string> {
  // 1. Check if yt-dlp is already installed globally on PATH
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5_000 });
    return "yt-dlp";
  } catch {
    // Not on PATH, use managed standalone binary in tempDir/bin
  }

  const binDir = path.join(settings.tempDir, "bin");
  const binPath = path.join(binDir, "yt-dlp");

  if (fs.existsSync(binPath)) {
    try {
      fs.chmodSync(binPath, 0o755);
      return binPath;
    } catch {
      // Re-download below
    }
  }

  if (!ytDlpBootstrapPromise) {
    ytDlpBootstrapPromise = (async () => {
      fs.mkdirSync(binDir, { recursive: true });
      const res = await fetch(YT_DLP_DOWNLOAD_URL, {
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to download yt-dlp binary (HTTP ${res.status}).`,
        );
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const tmpPath = `${binPath}.tmp_${process.pid}`;
      await fs.promises.writeFile(tmpPath, bytes, { mode: 0o755 });
      await fs.promises.rename(tmpPath, binPath);
      fs.chmodSync(binPath, 0o755);
      return binPath;
    })().finally(() => {
      ytDlpBootstrapPromise = null;
    });
  }

  return ytDlpBootstrapPromise;
}

function buildCommonYtDlpArgs(settings: Settings): string[] {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
  ];
  if (settings.cookiesFile && fs.existsSync(settings.cookiesFile)) {
    args.push("--cookies", settings.cookiesFile);
  }
  if (settings.proxyUrl) {
    args.push("--proxy", settings.proxyUrl);
  }
  return args;
}

interface YtDlpMetadata {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
}

export async function downloadAudio(
  url: string,
  jobId: string,
  settings: Settings,
): Promise<ExtractedMedia> {
  const ytDlpBin = await ensureYtDlp(settings);
  const jobDir = path.join(settings.tempDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const commonArgs = buildCommonYtDlpArgs(settings);

  // 1. Fetch metadata first to validate duration & capture title/uploader
  let info: YtDlpMetadata = {};
  try {
    const { stdout } = await execFileAsync(
      ytDlpBin,
      [...commonArgs, "--dump-json", "--no-download", url],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const firstLine = stdout.trim().split(/\r?\n/)[0];
    if (firstLine) {
      info = JSON.parse(firstLine) as YtDlpMetadata;
    }
  } catch (err) {
    const error = err as Error & { stderr?: string };
    const detail = (error.stderr || error.message || "")
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" | ");
    throw new Error(
      `Could not extract video information from this URL: ${detail}`,
    );
  }

  if (
    typeof info.duration === "number" &&
    info.duration > settings.maxVideoDurationSec
  ) {
    throw new Error(
      `Video duration (${Math.floor(info.duration)}s) exceeds the configured limit (${settings.maxVideoDurationSec}s).`,
    );
  }

  // 2. Download best audio and convert to 16kHz mono 64kbps MP3 via ffmpeg
  const outputTemplate = path.join(jobDir, "audio.%(ext)s");
  try {
    await execFileAsync(
      ytDlpBin,
      [
        ...commonArgs,
        "-f",
        "bestaudio/best",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "32K",
        "--postprocessor-args",
        "ffmpeg:-ac 1 -ar 16000",
        "-o",
        outputTemplate,
        url,
      ],
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    const error = err as Error & { stderr?: string };
    const detail = (error.stderr || error.message || "")
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" | ");
    throw new Error(`Audio download failed: ${detail}`);
  }

  let audioPath = path.join(jobDir, "audio.mp3");
  if (!fs.existsSync(audioPath)) {
    const candidates = fs
      .readdirSync(jobDir)
      .map((name) => path.join(jobDir, name))
      .filter((p) => fs.statSync(p).isFile());
    if (candidates.length === 0) {
      throw new Error(
        "Audio extraction finished but no audio file was produced.",
      );
    }
    audioPath = candidates[0];
  }

  const probedDuration =
    typeof info.duration === "number" && Number.isFinite(info.duration)
      ? info.duration
      : await probeMediaDuration(audioPath);

  return {
    audioPath,
    title: info.title || "Untitled Video",
    uploader: info.uploader || info.channel || null,
    durationSec: probedDuration,
    thumbnailUrl: info.thumbnail || null,
  };
}

export async function probeMediaDuration(mediaPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        mediaPath,
      ],
      { timeout: 15_000 },
    );
    const trimmed = stdout.trim();
    if (trimmed) {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed * 100) / 100;
      }
    }
  } catch {
    // ffprobe is optional
  }
  return null;
}

export async function extractAudioFromLocalFile(
  inputPath: string,
  originalFilename: string,
  jobId: string,
  settings: Settings,
): Promise<ExtractedMedia> {
  const jobDir = path.join(settings.tempDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const outMp3 = path.join(jobDir, "audio.mp3");

  let duration = await probeMediaDuration(inputPath);
  if (duration && duration > settings.maxVideoDurationSec) {
    throw new Error(
      `Media duration (${Math.floor(duration)}s) exceeds the configured limit (${settings.maxVideoDurationSec}s).`,
    );
  }

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        outMp3,
      ],
      { timeout: 300_000 },
    );
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    if (error.code === "ENOENT") {
      throw new Error(
        "ffmpeg is not installed or not on PATH. Install ffmpeg to transcribe local video/audio files.",
      );
    }
    const errLines = (error.stderr || error.message || "")
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" | ");
    throw new Error(`ffmpeg failed to extract audio: ${errLines}`);
  }

  if (!fs.existsSync(outMp3)) {
    throw new Error("ffmpeg finished but no output MP3 file was produced.");
  }

  if (duration === null) {
    duration = await probeMediaDuration(outMp3);
  }

  const title = path.parse(originalFilename).name || "Uploaded Media";
  return {
    audioPath: outMp3,
    title,
    uploader: "Local Upload",
    durationSec: duration,
    thumbnailUrl: null,
  };
}
