import type { TranscriptSegment } from "../models.ts";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export function formatTimestampClock(seconds: number): string {
  const totalSec = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
  }
  return `${pad2(minutes)}:${pad2(secs)}`;
}

export function formatTimestampSrt(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const remAfterH = totalMs % 3_600_000;
  const minutes = Math.floor(remAfterH / 60_000);
  const remAfterM = remAfterH % 60_000;
  const secs = Math.floor(remAfterM / 1000);
  const ms = remAfterM % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${pad3(ms)}`;
}

export function formatTimestampVtt(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const remAfterH = totalMs % 3_600_000;
  const minutes = Math.floor(remAfterH / 60_000);
  const remAfterM = remAfterH % 60_000;
  const secs = Math.floor(remAfterM / 1000);
  const ms = remAfterM % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}.${pad3(ms)}`;
}

export function toSrt(segments: readonly TranscriptSegment[]): string {
  const blocks = segments.map((seg, idx) => {
    const startTs = formatTimestampSrt(seg.start);
    const endTs = formatTimestampSrt(Math.max(seg.end, seg.start + 0.1));
    return `${idx + 1}\n${startTs} --> ${endTs}\n${seg.text.trim()}`;
  });
  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

export function toVtt(segments: readonly TranscriptSegment[]): string {
  const lines: string[] = ["WEBVTT", ""];
  for (const seg of segments) {
    const startTs = formatTimestampVtt(seg.start);
    const endTs = formatTimestampVtt(Math.max(seg.end, seg.start + 0.1));
    lines.push(`${startTs} --> ${endTs}`);
    lines.push(seg.text.trim());
    lines.push("");
  }
  return lines.join("\n");
}

export function toTimestampedTxt(segments: readonly TranscriptSegment[]): string {
  const lines = segments.map(
    (seg) =>
      `[${formatTimestampClock(seg.start)} - ${formatTimestampClock(seg.end)}] ${seg.text.trim()}`,
  );
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export function toPlainTxt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((seg) => seg.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function toJsonExport(
  segments: readonly TranscriptSegment[],
  metadata: Record<string, unknown>,
): string {
  const payload = {
    metadata,
    segments: segments.map((seg) => ({
      id: seg.id,
      start: Math.round(seg.start * 1000) / 1000,
      end: Math.round(seg.end * 1000) / 1000,
      timestamp: formatTimestampClock(seg.start),
      text: seg.text.trim(),
    })),
  };
  return JSON.stringify(payload, null, 2);
}
