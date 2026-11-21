"""Transcript formatting utilities for SRT, WebVTT, timestamped TXT, plain TXT, and JSON."""

from __future__ import annotations

import json
from typing import Iterable, List

from app.models import TranscriptSegment


def format_timestamp_clock(seconds: float) -> str:
    """Format seconds as MM:SS or HH:MM:SS for human display."""
    total_sec = max(0, int(round(seconds)))
    hours, rem = divmod(total_sec, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def format_timestamp_srt(seconds: float) -> str:
    """Format seconds as HH:MM:SS,mmm for SubRip (.srt)."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def format_timestamp_vtt(seconds: float) -> str:
    """Format seconds as HH:MM:SS.mmm for WebVTT (.vtt)."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def to_srt(segments: Iterable[TranscriptSegment]) -> str:
    blocks: List[str] = []
    for idx, seg in enumerate(segments, start=1):
        start_ts = format_timestamp_srt(seg.start)
        end_ts = format_timestamp_srt(max(seg.end, seg.start + 0.1))
        blocks.append(f"{idx}\n{start_ts} --> {end_ts}\n{seg.text.strip()}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def to_vtt(segments: Iterable[TranscriptSegment]) -> str:
    lines: List[str] = ["WEBVTT", ""]
    for seg in segments:
        start_ts = format_timestamp_vtt(seg.start)
        end_ts = format_timestamp_vtt(max(seg.end, seg.start + 0.1))
        lines.append(f"{start_ts} --> {end_ts}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines)


def to_timestamped_txt(segments: Iterable[TranscriptSegment]) -> str:
    lines = [
        f"[{format_timestamp_clock(seg.start)} - {format_timestamp_clock(seg.end)}] {seg.text.strip()}"
        for seg in segments
    ]
    return "\n".join(lines) + ("\n" if lines else "")


def to_plain_txt(segments: Iterable[TranscriptSegment]) -> str:
    return " ".join(seg.text.strip() for seg in segments if seg.text.strip())


def to_json_export(segments: Iterable[TranscriptSegment], metadata: dict) -> str:
    payload = {
        "metadata": metadata,
        "segments": [
            {
                "id": seg.id,
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "timestamp": format_timestamp_clock(seg.start),
                "text": seg.text.strip(),
            }
            for seg in segments
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)
