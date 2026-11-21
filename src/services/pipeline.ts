import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../config.ts";
import type {
  JobStatus,
  JobStep,
  Platform,
  TranscriptSegment,
  TranscriptionEngine,
} from "../models.ts";
import { toPlainTxt } from "./formatter.ts";
import {
  downloadAudio,
  extractAudioFromLocalFile,
  probeMediaDuration,
  type ExtractedMedia,
} from "./media.ts";
import {
  fetchYoutubeMetadata,
  generateDemoTranscript,
  transcribeAudioFile,
  tryYoutubeCaptions,
} from "./transcriber.ts";
import { parseVideoUrl } from "./urlParser.ts";

export type ProgressCallback = (
  stage: JobStatus,
  progress: number,
  message: string,
) => void;

export class PipelineStepError extends Error {
  readonly step: JobStep;

  constructor(message: string, step: JobStep) {
    super(message);
    this.name = "PipelineStepError";
    this.step = step;
  }
}

export interface PipelineOutput {
  platform: Platform;
  source: string;
  canonicalUrl: string;
  videoId: string | null;
  title: string;
  uploader: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  engineUsed: string;
  language: string | null;
  segments: TranscriptSegment[];
  fullText: string;
}

export interface TranscribeUrlOptions {
  engine: TranscriptionEngine;
  language: string | null;
  whisperModel: string | null;
  preferCaptions: boolean;
  settings: Settings;
  jobId?: string;
  onProgress?: ProgressCallback;
  onMediaExtracted?: (media: ExtractedMedia) => void;
  cachedMedia?: ExtractedMedia | null;
}

function toStepError(err: unknown, step: JobStep): PipelineStepError {
  if (err instanceof PipelineStepError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new PipelineStepError(message, step);
}

export async function transcribeUrl(
  url: string,
  options: TranscribeUrlOptions,
): Promise<PipelineOutput> {
  const parsed = parseVideoUrl(url);
  const runId = options.jobId || crypto.randomBytes(6).toString("hex");
  const audioDir = path.join(options.settings.tempDir, runId);

  if (options.engine === "demo") {
    options.onProgress?.(
      "transcribing",
      55,
      "Generating demo timestamped transcript...",
    );
    const { metadata, result } = generateDemoTranscript(
      parsed.platform,
      parsed.canonicalUrl,
    );
    if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
      fs.rmSync(audioDir, { recursive: true, force: true });
    }
    return {
      platform: parsed.platform,
      source: parsed.originalUrl,
      canonicalUrl: parsed.canonicalUrl,
      videoId: parsed.videoId,
      title: metadata.title || "Demo Transcript",
      uploader: metadata.uploader,
      durationSec: metadata.durationSec,
      thumbnailUrl: metadata.thumbnailUrl,
      engineUsed: result.engineUsed,
      language: result.language,
      segments: result.segments,
      fullText: toPlainTxt(result.segments),
    };
  }

  let media: ExtractedMedia;
  const hasCachedAudio = Boolean(
    options.cachedMedia?.audioPath && fs.existsSync(options.cachedMedia.audioPath),
  );

  if (hasCachedAudio && options.cachedMedia) {
    // Resume directly at transcribing step — skip download & ffmpeg extraction!
    media = options.cachedMedia;
    options.onProgress?.(
      "transcribing",
      65,
      "Resuming from transcribing step using cached audio...",
    );
  } else {
    // Step 1: Fast-path YouTube captions or yt-dlp + ffmpeg audio extraction
    if (
      parsed.platform === "youtube" &&
      parsed.videoId &&
      options.preferCaptions &&
      options.settings.preferYoutubeCaptions
    ) {
      options.onProgress?.(
        "extracting",
        25,
        "Checking YouTube captions fast-path...",
      );
      const captionResult = await tryYoutubeCaptions(
        parsed.videoId,
        options.language,
      );
      if (captionResult) {
        const meta = await fetchYoutubeMetadata(parsed.canonicalUrl);
        const lastSeg = captionResult.segments[captionResult.segments.length - 1];
        return {
          platform: parsed.platform,
          source: parsed.originalUrl,
          canonicalUrl: parsed.canonicalUrl,
          videoId: parsed.videoId,
          title: meta.title || `YouTube Video (${parsed.videoId})`,
          uploader: meta.uploader,
          durationSec:
            meta.durationSec ?? (lastSeg ? Math.round(lastSeg.end) : null),
          thumbnailUrl: meta.thumbnailUrl,
          engineUsed: captionResult.engineUsed,
          language: captionResult.language,
          segments: captionResult.segments,
          fullText: toPlainTxt(captionResult.segments),
        };
      }
    }

    const platformLabel =
      parsed.platform.charAt(0).toUpperCase() + parsed.platform.slice(1);
    options.onProgress?.(
      "extracting",
      30,
      `Extracting 16kHz audio from ${platformLabel} via yt-dlp & ffmpeg...`,
    );

    try {
      media = await downloadAudio(
        parsed.canonicalUrl,
        runId,
        options.settings,
      );
    } catch (err) {
      // Extraction failed — remove any partial/corrupt files in audioDir
      if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
        fs.rmSync(audioDir, { recursive: true, force: true });
      }
      throw toStepError(err, "extracting");
    }

    // Checkpoint extracted media immediately before starting Step 2
    options.onMediaExtracted?.(media);
  }

  // Step 2: Transcribe extracted audio
  options.onProgress?.(
    "transcribing",
    65,
    hasCachedAudio
      ? "Resuming transcription with cached 16kHz audio..."
      : "Sending preprocessed audio to transcription backend...",
  );

  let result;
  try {
    result = await transcribeAudioFile(
      media.audioPath,
      options.engine,
      options.settings,
      options.language,
      options.whisperModel,
      media.durationSec,
    );
  } catch (err) {
    // Preserve extracted audioDir so retry resumes directly from transcribing!
    throw toStepError(err, "transcribing");
  }

  // Only clean up extracted audio after transcription succeeds
  if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
    fs.rmSync(audioDir, { recursive: true, force: true });
  }

  return {
    platform: parsed.platform,
    source: parsed.originalUrl,
    canonicalUrl: parsed.canonicalUrl,
    videoId: parsed.videoId,
    title: media.title,
    uploader: media.uploader,
    durationSec: media.durationSec,
    thumbnailUrl: media.thumbnailUrl,
    engineUsed: result.engineUsed,
    language: result.language,
    segments: result.segments,
    fullText: toPlainTxt(result.segments),
  };
}

export interface TranscribeFileOptions {
  originalFilename: string;
  engine: TranscriptionEngine;
  language: string | null;
  whisperModel: string | null;
  settings: Settings;
  jobId?: string;
  onProgress?: ProgressCallback;
  onMediaExtracted?: (media: ExtractedMedia) => void;
  cachedMedia?: ExtractedMedia | null;
}

export async function transcribeFile(
  filePath: string | null,
  options: TranscribeFileOptions,
): Promise<PipelineOutput> {
  const runId = options.jobId || crypto.randomBytes(6).toString("hex");
  const audioDir = path.join(options.settings.tempDir, runId);

  if (options.engine === "demo") {
    options.onProgress?.(
      "transcribing",
      55,
      "Generating demo timestamped transcript...",
    );
    const probedDuration =
      options.cachedMedia?.durationSec ??
      (filePath && fs.existsSync(filePath)
        ? await probeMediaDuration(filePath)
        : null);
    const { metadata, result } = generateDemoTranscript(
      "local",
      options.originalFilename,
    );
    if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
      fs.rmSync(audioDir, { recursive: true, force: true });
    }
    return {
      platform: "local",
      source: `local://${options.originalFilename}`,
      canonicalUrl: `local://${options.originalFilename}`,
      videoId: runId,
      title: metadata.title || options.originalFilename,
      uploader: metadata.uploader,
      durationSec: probedDuration ?? metadata.durationSec,
      thumbnailUrl: null,
      engineUsed: result.engineUsed,
      language: result.language,
      segments: result.segments,
      fullText: toPlainTxt(result.segments),
    };
  }

  let media: ExtractedMedia;
  const hasCachedAudio = Boolean(
    options.cachedMedia?.audioPath && fs.existsSync(options.cachedMedia.audioPath),
  );

  if (hasCachedAudio && options.cachedMedia) {
    // Resume directly at transcribing step — skip ffmpeg preprocessing!
    media = options.cachedMedia;
    options.onProgress?.(
      "transcribing",
      65,
      "Resuming from transcribing step using cached audio...",
    );
  } else {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new PipelineStepError(
        "Source upload file is no longer available on disk. Please upload the file again.",
        "extracting",
      );
    }

    options.onProgress?.(
      "extracting",
      30,
      "Preprocessing video/audio to 16kHz mono MP3 with ffmpeg...",
    );

    try {
      media = await extractAudioFromLocalFile(
        filePath,
        options.originalFilename,
        runId,
        options.settings,
      );
    } catch (err) {
      if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
        fs.rmSync(audioDir, { recursive: true, force: true });
      }
      throw toStepError(err, "extracting");
    }

    // Checkpoint extracted MP3 immediately before Step 2
    options.onMediaExtracted?.(media);
  }

  options.onProgress?.(
    "transcribing",
    65,
    hasCachedAudio
      ? "Resuming transcription with cached 16kHz audio..."
      : "Sending preprocessed audio to transcription backend...",
  );

  let result;
  try {
    result = await transcribeAudioFile(
      media.audioPath,
      options.engine,
      options.settings,
      options.language,
      options.whisperModel,
      media.durationSec,
    );
  } catch (err) {
    // Preserve extracted audioDir so retry resumes directly from transcribing!
    throw toStepError(err, "transcribing");
  }

  // Only clean up extracted audio after transcription succeeds
  if (options.settings.cleanupAudio && fs.existsSync(audioDir)) {
    fs.rmSync(audioDir, { recursive: true, force: true });
  }

  return {
    platform: "local",
    source: `local://${options.originalFilename}`,
    canonicalUrl: `local://${options.originalFilename}`,
    videoId: runId,
    title: media.title,
    uploader: media.uploader,
    durationSec: media.durationSec,
    thumbnailUrl: null,
    engineUsed: result.engineUsed,
    language: result.language,
    segments: result.segments,
    fullText: toPlainTxt(result.segments),
  };
}
