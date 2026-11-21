import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import type { Settings } from "../config.ts";
import {
  ALLOWED_WHISPER_MODELS,
  type Platform,
  type TranscriptSegment,
  type TranscriptionEngine,
} from "../models.ts";

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  language: string | null;
  engineUsed: string;
}

export interface VideoMetadata {
  title: string | null;
  uploader: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

function getGeminiApiKey(settings: Settings): string {
  return settings.geminiApiKey || process.env.GEMINI_API_KEY || "";
}

function getDeepgramApiKey(settings: Settings): string {
  return settings.deepgramApiKey || process.env.DEEPGRAM_API_KEY || "";
}

export function detectAvailableEngines(settings: Settings): Record<string, boolean> {
  const hasWhisperContainer = Boolean(settings.whisperServiceUrl);
  const hasGemini = Boolean(getGeminiApiKey(settings));
  const hasDeepgram = Boolean(getDeepgramApiKey(settings));
  return {
    youtube_captions: true,
    deepgram: hasDeepgram,
    gemini: hasGemini,
    faster_whisper: hasWhisperContainer,
    whisper_container: hasWhisperContainer,
    groq: Boolean(settings.groqApiKey || process.env.GROQ_API_KEY),
    openai: Boolean(settings.openaiApiKey || process.env.OPENAI_API_KEY),
    demo: true,
  };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
}

export async function fetchYoutubeMetadata(canonicalUrl: string): Promise<VideoMetadata> {
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return { title: null, uploader: null, durationSec: null, thumbnailUrl: null };
    }
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title || null,
      uploader: data.author_name || null,
      durationSec: null,
      thumbnailUrl: data.thumbnail_url || null,
    };
  } catch {
    return { title: null, uploader: null, durationSec: null, thumbnailUrl: null };
  }
}

export async function tryYoutubeCaptions(
  videoId: string,
  language: string | null = null,
): Promise<TranscriptionResult | null> {
  try {
    let tracks: CaptionTrack[] = [];

    try {
      const playerRes = await fetch(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: "ANDROID",
                clientVersion: "19.09.37",
                androidSdkVersion: 30,
              },
            },
            videoId,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (playerRes.ok) {
        const playerJson = (await playerRes.json()) as {
          captions?: {
            playerCaptionsTracklistRenderer?: {
              captionTracks?: CaptionTrack[];
            };
          };
        };
        tracks =
          playerJson.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
          [];
      }
    } catch {
      // Fallback to watch page below
    }

    if (tracks.length === 0) {
      const watchRes = await fetch(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (watchRes.ok) {
        const html = await watchRes.text();
        const match = html.match(/"captionTracks":(\[.*?\])/);
        if (match && match[1]) {
          tracks = JSON.parse(match[1]) as CaptionTrack[];
        }
      }
    }

    if (tracks.length === 0) {
      return null;
    }

    const preferredLangs = language ? [language] : ["en", "en-US", "en-GB", "hi"];
    let selectedTrack: CaptionTrack | undefined;
    for (const pref of preferredLangs) {
      selectedTrack = tracks.find(
        (t) =>
          t.languageCode?.toLowerCase() === pref.toLowerCase() ||
          t.languageCode?.toLowerCase().startsWith(`${pref.toLowerCase()}-`),
      );
      if (selectedTrack) break;
    }
    if (!selectedTrack) {
      selectedTrack = tracks[0];
    }
    if (!selectedTrack?.baseUrl) {
      return null;
    }

    const trackUrl = selectedTrack.baseUrl.includes("fmt=")
      ? selectedTrack.baseUrl
      : `${selectedTrack.baseUrl}&fmt=json3`;

    const trackRes = await fetch(trackUrl, { signal: AbortSignal.timeout(10_000) });
    if (!trackRes.ok) {
      return null;
    }

    const rawBody = await trackRes.text();
    const segments: TranscriptSegment[] = [];

    if (rawBody.trim().startsWith("{")) {
      const json3 = JSON.parse(rawBody) as {
        events?: Array<{
          tStartMs?: number;
          dDurationMs?: number;
          segs?: Array<{ utf8?: string }>;
        }>;
      };
      for (const ev of json3.events ?? []) {
        if (!ev.segs) continue;
        const text = decodeHtmlEntities(
          ev.segs.map((s) => s.utf8 || "").join(""),
        );
        if (!text) continue;
        const start = (ev.tStartMs ?? 0) / 1000;
        const duration = Math.max((ev.dDurationMs ?? 2000) / 1000, 0.2);
        segments.push({
          id: segments.length + 1,
          start: Math.round(start * 1000) / 1000,
          end: Math.round((start + duration) * 1000) / 1000,
          text,
        });
      }
    } else {
      const textTagRegex =
        /<text\s+start="([^"]+)"(?:\s+dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/g;
      let m: RegExpExecArray | null;
      while ((m = textTagRegex.exec(rawBody)) !== null) {
        const start = Number.parseFloat(m[1] || "0");
        const dur = Number.parseFloat(m[2] || "2");
        const text = decodeHtmlEntities(m[3] || "");
        if (!text) continue;
        segments.push({
          id: segments.length + 1,
          start: Math.round(start * 1000) / 1000,
          end: Math.round((start + Math.max(dur, 0.2)) * 1000) / 1000,
          text,
        });
      }
    }

    if (segments.length === 0) {
      return null;
    }

    return {
      segments,
      language: selectedTrack.languageCode || language || "en",
      engineUsed: "youtube_captions",
    };
  } catch {
    return null;
  }
}

export function resolveEngine(
  requested: TranscriptionEngine,
  settings: Settings,
): TranscriptionEngine {
  if (requested !== "auto") {
    return requested;
  }

  const configured = settings.defaultEngine.toLowerCase();
  if (
    configured === "deepgram" ||
    configured === "gemini" ||
    configured === "groq" ||
    configured === "openai" ||
    configured === "faster_whisper" ||
    configured === "demo"
  ) {
    return configured;
  }

  if (settings.whisperServiceUrl) {
    return "faster_whisper";
  }
  if (settings.groqApiKey || process.env.GROQ_API_KEY) {
    return "groq";
  }
  if (getDeepgramApiKey(settings)) {
    return "deepgram";
  }
  if (settings.openaiApiKey || process.env.OPENAI_API_KEY) {
    return "openai";
  }
  if (getGeminiApiKey(settings)) {
    return "gemini";
  }

  throw new Error(
    "No transcription backend key is configured. Add DEEPGRAM_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, or WHISPER_SERVICE_URL in Settings > Secrets, or choose 'Demo Mode'.",
  );
}

export async function transcribeAudioFile(
  audioPath: string,
  engine: TranscriptionEngine,
  settings: Settings,
  language: string | null = null,
  whisperModel: string | null = null,
  durationSec: number | null = null,
): Promise<TranscriptionResult> {
  const resolved = resolveEngine(engine, settings);

  if (resolved === "deepgram") {
    return transcribeDeepgram(audioPath, settings, language, durationSec);
  }
  if (resolved === "gemini") {
    return transcribeGemini(audioPath, settings, language, durationSec);
  }
  if (resolved === "groq") {
    return transcribeGroq(audioPath, settings, language);
  }
  if (resolved === "openai") {
    return transcribeOpenAi(audioPath, settings, language);
  }
  if (resolved === "faster_whisper") {
    return transcribeWhisperContainer(audioPath, settings, language, whisperModel);
  }
  throw new Error(`Unsupported transcription engine: ${resolved}`);
}

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

interface DeepgramResponse {
  results?: {
    utterances?: Array<{
      start?: number;
      end?: number;
      transcript?: string;
    }>;
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
      }>;
    }>;
  };
}

async function transcribeDeepgram(
  audioPath: string,
  settings: Settings,
  language: string | null,
  durationSec: number | null,
): Promise<TranscriptionResult> {
  const apiKey = getDeepgramApiKey(settings);
  if (!apiKey) {
    throw new Error(
      "DEEPGRAM_API_KEY is not set. Add DEEPGRAM_API_KEY in Settings > Secrets.",
    );
  }

  const params = new URLSearchParams({
    model: settings.deepgramModel || "nova-3",
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
  });
  if (language) {
    params.set("language", language);
  } else {
    params.set("detect_language", "true");
  }

  const fileBytes = await fs.promises.readFile(audioPath);
  const res = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/mpeg",
      },
      body: fileBytes,
      signal: AbortSignal.timeout(300_000),
    },
  );

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Deepgram API returned HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as DeepgramResponse;
  const segments: TranscriptSegment[] = [];

  for (const utt of data.results?.utterances ?? []) {
    const text = String(utt.transcript || "").trim();
    if (!text) continue;
    const start = Math.max(0, Number(utt.start ?? 0));
    const end = Math.max(start + 0.2, Number(utt.end ?? start + 2));
    segments.push({
      id: segments.length + 1,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
    });
  }

  const firstChannel = data.results?.channels?.[0];
  const firstAlt = firstChannel?.alternatives?.[0];

  if (segments.length === 0 && firstAlt?.words && firstAlt.words.length > 0) {
    let chunkWords: string[] = [];
    let chunkStart = Number(firstAlt.words[0].start ?? 0);
    let chunkEnd = chunkStart;

    for (const w of firstAlt.words) {
      const token = (w.punctuated_word || w.word || "").trim();
      if (!token) continue;
      if (chunkWords.length === 0) {
        chunkStart = Number(w.start ?? chunkEnd);
      }
      chunkWords.push(token);
      chunkEnd = Number(w.end ?? chunkStart + 0.5);

      const endsSentence = /[.!?।]$/.test(token);
      const longEnough = chunkEnd - chunkStart >= 10 || chunkWords.length >= 25;
      if (endsSentence || longEnough) {
        segments.push({
          id: segments.length + 1,
          start: Math.round(chunkStart * 1000) / 1000,
          end: Math.round(Math.max(chunkEnd, chunkStart + 0.2) * 1000) / 1000,
          text: chunkWords.join(" "),
        });
        chunkWords = [];
      }
    }
    if (chunkWords.length > 0) {
      segments.push({
        id: segments.length + 1,
        start: Math.round(chunkStart * 1000) / 1000,
        end: Math.round(Math.max(chunkEnd, chunkStart + 0.2) * 1000) / 1000,
        text: chunkWords.join(" "),
      });
    }
  }

  if (segments.length === 0 && firstAlt?.transcript?.trim()) {
    segments.push({
      id: 1,
      start: 0,
      end: durationSec && durationSec > 0 ? Math.round(durationSec * 1000) / 1000 : 5,
      text: firstAlt.transcript.trim(),
    });
  }

  return {
    segments,
    language: firstChannel?.detected_language || language || null,
    engineUsed: `deepgram:${settings.deepgramModel || "nova-3"}`,
  };
}

function parseClockToSeconds(clock: string): number {
  const parts = clock.trim().split(":").map((p) => Number.parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] ?? 0;
}

function parseTextToSegments(
  rawText: string,
  durationSec: number | null,
): TranscriptSegment[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Check for "[MM:SS - MM:SS] text" or "[MM:SS] text" lines
  const rangeRegex =
    /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(?:-|–|-->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?\s*(.+)$/;
  const singleRegex =
    /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?\s*(.+)$/;

  const parsed: TranscriptSegment[] = [];
  for (const line of lines) {
    const rMatch = line.match(rangeRegex);
    if (rMatch) {
      const start = parseClockToSeconds(rMatch[1]);
      const end = Math.max(parseClockToSeconds(rMatch[2]), start + 0.5);
      const text = rMatch[3].trim();
      if (text) {
        parsed.push({
          id: parsed.length + 1,
          start: Math.round(start * 1000) / 1000,
          end: Math.round(end * 1000) / 1000,
          text,
        });
      }
      continue;
    }

    const sMatch = line.match(singleRegex);
    if (sMatch) {
      const start = parseClockToSeconds(sMatch[1]);
      const text = sMatch[2].trim();
      if (text) {
        parsed.push({
          id: parsed.length + 1,
          start: Math.round(start * 1000) / 1000,
          end: Math.round((start + 3) * 1000) / 1000,
          text,
        });
      }
    }
  }

  if (parsed.length > 0) {
    for (let i = 0; i < parsed.length - 1; i++) {
      if (parsed[i + 1].start > parsed[i].start) {
        parsed[i].end = Math.min(parsed[i].end, parsed[i + 1].start);
      }
    }
    return parsed;
  }

  // Plain transcript fallback: split into sentences and estimate timestamps from duration
  const cleaned = rawText.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned
    .split(/(?<=[.!?।])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = sentences.length > 0 ? sentences : [cleaned];
  const totalDuration = durationSec && durationSec > 0 ? durationSec : chunks.length * 4;
  const totalChars = chunks.reduce((acc, s) => acc + s.length, 0) || 1;
  let cursor = 0;

  return chunks.map((text, idx) => {
    const sliceDur = Math.max((text.length / totalChars) * totalDuration, 0.5);
    const start = Math.round(cursor * 1000) / 1000;
    const end =
      idx === chunks.length - 1
        ? Math.round(Math.max(totalDuration, start + 0.5) * 1000) / 1000
        : Math.round((cursor + sliceDur) * 1000) / 1000;
    cursor += sliceDur;
    return { id: idx + 1, start, end, text };
  });
}

async function transcribeGemini(
  audioPath: string,
  settings: Settings,
  language: string | null,
  durationSec: number | null,
): Promise<TranscriptionResult> {
  const apiKey = getGeminiApiKey(settings);
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Check your API key in Settings > Secrets.",
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const stat = await fs.promises.stat(audioPath);
  const useFilesApi = stat.size > 15 * 1024 * 1024;
  let uploadedFileName: string | null = null;

  try {
    let audioPart:
      | { inlineData: { mimeType: string; data: string } }
      | { fileData: { fileUri: string; mimeType: string } };

    if (useFilesApi) {
      const uploaded = await ai.files.upload({
        file: audioPath,
        config: { mimeType: "audio/mp3" },
      });
      uploadedFileName = uploaded.name || null;
      if (!uploaded.uri) {
        throw new Error("Gemini Files API upload did not return a file URI.");
      }
      audioPart = {
        fileData: {
          fileUri: uploaded.uri,
          mimeType: uploaded.mimeType || "audio/mp3",
        },
      };
    } else {
      const fileBytes = await fs.promises.readFile(audioPath);
      audioPart = {
        inlineData: {
          mimeType: "audio/mp3",
          data: fileBytes.toString("base64"),
        },
      };
    }

    const langHint = language
      ? `The spoken language is '${language}'. Transcribe faithfully in that language.`
      : "Auto-detect the spoken language and transcribe faithfully in the original spoken language.";

    // Try structured JSON timestamped segments first using gemini-3.5-transcribe
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            audioPart,
            {
              text: `Transcribe this audio verbatim with accurate segment start and end timestamps in seconds. ${langHint}`,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              language: {
                type: Type.STRING,
                description: "ISO-639-1 detected language code (e.g. en, hi, es).",
              },
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    start: {
                      type: Type.NUMBER,
                      description: "Segment start time in seconds.",
                    },
                    end: {
                      type: Type.NUMBER,
                      description: "Segment end time in seconds.",
                    },
                    text: {
                      type: Type.STRING,
                      description: "Verbatim transcribed text for this segment.",
                    },
                  },
                  required: ["start", "end", "text"],
                },
              },
            },
            required: ["segments"],
          },
        },
      });

      const rawJson = (response.text ?? "").trim();
      if (rawJson) {
        const parsed = JSON.parse(rawJson) as {
          language?: string;
          segments?: Array<{ start?: number; end?: number; text?: string }>;
        };
        const segments: TranscriptSegment[] = [];
        for (const item of parsed.segments ?? []) {
          const text = String(item.text || "").trim();
          if (!text) continue;
          const start = Math.max(0, Number(item.start ?? 0));
          const end = Math.max(start + 0.2, Number(item.end ?? start + 2));
          segments.push({
            id: segments.length + 1,
            start: Math.round(start * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            text,
          });
        }
        if (segments.length > 0) {
          return {
            segments,
            language: parsed.language || language || null,
            engineUsed: "gemini:gemini-3.5-transcribe",
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("API_KEY_INVALID") ||
        msg.includes("PERMISSION_DENIED") ||
        msg.includes("RESOURCE_EXHAUSTED")
      ) {
        throw new Error(
          `Gemini API error: ${msg}. Please check your API key in Settings > Secrets.`,
        );
      }
      // Otherwise fall back to plain timestamped prompt without JSON schema
    }

    const fallbackRes = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          audioPart,
          {
            text: `Transcribe this audio verbatim. Format each utterance on its own line with timestamps like [00:00 - 00:05] transcribed text. ${langHint}`,
          },
        ],
      },
    });

    const text = (fallbackRes.text ?? "").trim();
    const segments = parseTextToSegments(text, durationSec);
    if (segments.length === 0) {
      throw new Error("Gemini transcription returned no speech segments.");
    }

    return {
      segments,
      language: language || null,
      engineUsed: "gemini:gemini-3.5-transcribe",
    };
  } finally {
    if (uploadedFileName) {
      ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
}

async function transcribeWhisperContainer(
  audioPath: string,
  settings: Settings,
  language: string | null,
  whisperModel: string | null,
): Promise<TranscriptionResult> {
  if (!settings.whisperServiceUrl) {
    throw new Error(
      "WHISPER_SERVICE_URL is not configured. Point WHISPER_SERVICE_URL to a running faster-whisper HTTP container, or choose Gemini, Groq, OpenAI, or Demo Mode.",
    );
  }

  const modelName = (whisperModel || settings.whisperModel || "base").trim();
  if (!(ALLOWED_WHISPER_MODELS as readonly string[]).includes(modelName)) {
    throw new Error(
      `Unsupported Whisper model '${modelName}'. Choose one of: ${ALLOWED_WHISPER_MODELS.join(", ")}.`,
    );
  }

  const fileBytes = await fs.promises.readFile(audioPath);
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([fileBytes], { type: "audio/mpeg" }),
    path.basename(audioPath),
  );
  fd.append("model", modelName);
  if (language) {
    fd.append("language", language);
  }

  const response = await fetch(`${settings.whisperServiceUrl}/transcribe`, {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(settings.whisperServiceTimeoutSec * 1000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `Whisper container returned HTTP ${response.status}: ${detail}`,
    );
  }

  const payload = (await response.json()) as {
    segments?: Array<{ id?: number; start?: number; end?: number; text?: string }>;
    language?: string;
    engine_used?: string;
  };

  const segments: TranscriptSegment[] = [];
  for (const item of payload.segments ?? []) {
    const text = String(item.text || "").trim();
    if (!text) continue;
    segments.push({
      id: Number(item.id ?? segments.length + 1),
      start: Number(item.start ?? 0),
      end: Number(item.end ?? 0),
      text,
    });
  }

  return {
    segments,
    language: payload.language || language,
    engineUsed: payload.engine_used || `faster_whisper:${modelName}`,
  };
}

async function transcribeGroq(
  audioPath: string,
  settings: Settings,
  language: string | null,
): Promise<TranscriptionResult> {
  const groqKey = settings.groqApiKey || process.env.GROQ_API_KEY || "";
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not set in your environment.");
  }

  const fileBytes = await fs.promises.readFile(audioPath);
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([fileBytes], { type: "audio/mpeg" }),
    path.basename(audioPath),
  );
  fd.append("model", settings.groqModel);
  fd.append("response_format", "verbose_json");
  if (language) {
    fd.append("language", language);
  }

  const res = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: fd,
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Groq API returned HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as VerboseJsonResponse;
  return parseVerboseJsonResponse(data, `groq:${settings.groqModel}`, language);
}

async function transcribeOpenAi(
  audioPath: string,
  settings: Settings,
  language: string | null,
): Promise<TranscriptionResult> {
  const openAiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY || "";
  if (!openAiKey) {
    throw new Error("OPENAI_API_KEY is not set in your environment.");
  }

  const fileBytes = await fs.promises.readFile(audioPath);
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([fileBytes], { type: "audio/mpeg" }),
    path.basename(audioPath),
  );
  fd.append("model", settings.openaiModel);
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "segment");
  if (language) {
    fd.append("language", language);
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}` },
    body: fd,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`OpenAI API returned HTTP ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as VerboseJsonResponse;
  return parseVerboseJsonResponse(
    data,
    `openai:${settings.openaiModel}`,
    language,
  );
}

interface VerboseJsonResponse {
  text?: string;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
}

function parseVerboseJsonResponse(
  response: VerboseJsonResponse,
  engineLabel: string,
  fallbackLanguage: string | null,
): TranscriptionResult {
  const segments: TranscriptSegment[] = [];
  for (const item of response.segments ?? []) {
    const text = String(item.text || "").trim();
    if (!text) continue;
    const start = Number(item.start ?? 0);
    const end = Number(item.end ?? start + 1);
    segments.push({
      id: segments.length + 1,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
    });
  }

  if (segments.length === 0 && response.text?.trim()) {
    segments.push({
      id: 1,
      start: 0,
      end: 5,
      text: response.text.trim(),
    });
  }

  return {
    segments,
    language: response.language || fallbackLanguage,
    engineUsed: engineLabel,
  };
}

export function generateDemoTranscript(
  platform: Platform,
  label: string,
): { metadata: VideoMetadata; result: TranscriptionResult } {
  const platformLabel =
    platform === "local"
      ? "Local Upload"
      : platform.charAt(0).toUpperCase() + platform.slice(1);

  const metadata: VideoMetadata = {
    title:
      platform === "local"
        ? `[${platformLabel} Demo] ${label}`
        : `[${platformLabel} Demo] Sample Timestamped Video Transcript`,
    uploader: `${platformLabel} Studio`,
    durationSec: 42.0,
    thumbnailUrl: null,
  };

  const segments: TranscriptSegment[] = [
    {
      id: 1,
      start: 0.0,
      end: 7.4,
      text: `Welcome! This is a demo timestamped transcript generated for your ${platformLabel} input.`,
    },
    {
      id: 2,
      start: 7.4,
      end: 16.2,
      text: "In live mode, ClipScribe extracts the audio track with yt-dlp and ffmpeg at 16 kilohertz mono.",
    },
    {
      id: 3,
      start: 16.2,
      end: 26.8,
      text: "Audio is then transcribed via YouTube captions fast-path, Gemini Audio Transcription, faster-whisper, Groq, or OpenAI Whisper.",
    },
    {
      id: 4,
      start: 26.8,
      end: 35.5,
      text: "You can search keywords below, click any timestamp to jump directly, or export SRT, WebVTT, TXT, and JSON.",
    },
    {
      id: 5,
      start: 35.5,
      end: 42.0,
      text: "Switch the engine selector to Auto, Gemini, faster-whisper, Groq, or OpenAI to transcribe live videos.",
    },
  ];

  return {
    metadata,
    result: {
      segments,
      language: "en",
      engineUsed: "demo",
    },
  };
}
