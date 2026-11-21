"""Reusable core transcription pipeline shared by the FastAPI server and the MCP layer."""

from __future__ import annotations

import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

from app.config import Settings, get_settings
from app.models import Platform, TranscriptSegment, TranscriptionEngine
from app.services.downloader import (
    download_audio,
    extract_audio_from_local_file,
    fetch_video_metadata,
)
from app.services.formatter import to_json_export, to_plain_txt, to_srt, to_timestamped_txt, to_vtt
from app.services.transcriber import (
    generate_demo_transcript,
    transcribe_audio_file,
    try_youtube_captions,
)
from app.services.url_parser import parse_video_url

ProgressCallback = Callable[[str, int, str], None]


@dataclass
class PipelineOutput:
    platform: Platform
    source: str
    canonical_url: str
    video_id: Optional[str]
    title: str
    uploader: Optional[str]
    duration_sec: Optional[float]
    thumbnail_url: Optional[str]
    engine_used: str
    language: Optional[str]
    segments: List[TranscriptSegment]
    full_text: str

    def format_as(self, fmt: str = "json") -> str:
        fmt_lower = fmt.lower().strip()
        if fmt_lower == "srt":
            return to_srt(self.segments)
        if fmt_lower == "vtt":
            return to_vtt(self.segments)
        if fmt_lower == "txt":
            return to_timestamped_txt(self.segments)
        if fmt_lower == "plain":
            return self.full_text
        if fmt_lower == "json":
            return to_json_export(
                self.segments,
                metadata={
                    "platform": self.platform.value,
                    "source": self.source,
                    "canonical_url": self.canonical_url,
                    "title": self.title,
                    "uploader": self.uploader,
                    "duration_sec": self.duration_sec,
                    "language": self.language,
                    "engine_used": self.engine_used,
                },
            )
        raise ValueError(f"Unsupported output format '{fmt}'. Choose from: json, srt, vtt, txt, plain.")


def _notify(cb: Optional[ProgressCallback], stage: str, progress: int, message: str) -> None:
    if cb is not None:
        cb(stage, progress, message)


def transcribe_url(
    url: str,
    *,
    engine: TranscriptionEngine = TranscriptionEngine.AUTO,
    language: Optional[str] = None,
    whisper_model: Optional[str] = None,
    prefer_captions: bool = True,
    settings: Optional[Settings] = None,
    job_id: Optional[str] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> PipelineOutput:
    """Reusable utility: validate a YT/FB/IG link, extract audio, and transcribe via Whisper container or Groq."""
    cfg = settings or get_settings()
    parsed = parse_video_url(url)
    run_id = job_id or uuid.uuid4().hex[:12]
    audio_dir = cfg.temp_dir / run_id

    try:
        if engine == TranscriptionEngine.DEMO:
            _notify(on_progress, "transcribing", 55, "Generating demo timestamped transcript...")
            meta, result = generate_demo_transcript(parsed.platform, parsed.canonical_url)
            return PipelineOutput(
                platform=parsed.platform,
                source=parsed.original_url,
                canonical_url=parsed.canonical_url,
                video_id=parsed.video_id,
                title=meta["title"],
                uploader=meta["uploader"],
                duration_sec=meta["duration_sec"],
                thumbnail_url=meta["thumbnail_url"],
                engine_used=result.engine_used,
                language=result.language,
                segments=result.segments,
                full_text=to_plain_txt(result.segments),
            )

        # Fast-path: YouTube captions
        if (
            parsed.platform == Platform.YOUTUBE
            and parsed.video_id
            and prefer_captions
            and cfg.prefer_youtube_captions
        ):
            _notify(on_progress, "extracting", 25, "Checking YouTube captions fast-path...")
            caption_result = try_youtube_captions(parsed.video_id, language)
            if caption_result is not None:
                meta = fetch_video_metadata(parsed.canonical_url, cfg)
                return PipelineOutput(
                    platform=parsed.platform,
                    source=parsed.original_url,
                    canonical_url=parsed.canonical_url,
                    video_id=parsed.video_id,
                    title=meta.get("title") or f"YouTube Video ({parsed.video_id})",
                    uploader=meta.get("uploader"),
                    duration_sec=meta.get("duration_sec"),
                    thumbnail_url=meta.get("thumbnail_url"),
                    engine_used=caption_result.engine_used,
                    language=caption_result.language,
                    segments=caption_result.segments,
                    full_text=to_plain_txt(caption_result.segments),
                )

        _notify(on_progress, "extracting", 30, f"Extracting 16kHz audio from {parsed.platform.value.capitalize()}...")
        media = download_audio(parsed.canonical_url, run_id, cfg)

        _notify(on_progress, "transcribing", 65, "Sending preprocessed audio to transcription backend...")
        result = transcribe_audio_file(
            audio_path=media.audio_path,
            engine=engine,
            settings=cfg,
            language=language,
            whisper_model=whisper_model,
        )
        return PipelineOutput(
            platform=parsed.platform,
            source=parsed.original_url,
            canonical_url=parsed.canonical_url,
            video_id=parsed.video_id,
            title=media.title,
            uploader=media.uploader,
            duration_sec=media.duration_sec,
            thumbnail_url=media.thumbnail_url,
            engine_used=result.engine_used,
            language=result.language,
            segments=result.segments,
            full_text=to_plain_txt(result.segments),
        )
    finally:
        if cfg.cleanup_audio and audio_dir.exists():
            shutil.rmtree(audio_dir, ignore_errors=True)


def transcribe_file(
    file_path: Path | str,
    *,
    original_filename: Optional[str] = None,
    engine: TranscriptionEngine = TranscriptionEngine.AUTO,
    language: Optional[str] = None,
    whisper_model: Optional[str] = None,
    settings: Optional[Settings] = None,
    job_id: Optional[str] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> PipelineOutput:
    """Reusable utility: preprocess a local video/audio file with ffmpeg and transcribe via Whisper container or Groq."""
    cfg = settings or get_settings()
    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Media file not found: {path}")

    filename = original_filename or path.name
    run_id = job_id or uuid.uuid4().hex[:12]
    audio_dir = cfg.temp_dir / run_id

    try:
        if engine == TranscriptionEngine.DEMO:
            _notify(on_progress, "transcribing", 55, "Generating demo timestamped transcript...")
            meta, result = generate_demo_transcript(Platform.LOCAL, filename)
            return PipelineOutput(
                platform=Platform.LOCAL,
                source=f"local://{filename}",
                canonical_url=f"local://{filename}",
                video_id=run_id,
                title=meta["title"],
                uploader=meta["uploader"],
                duration_sec=meta["duration_sec"],
                thumbnail_url=None,
                engine_used=result.engine_used,
                language=result.language,
                segments=result.segments,
                full_text=to_plain_txt(result.segments),
            )

        _notify(on_progress, "extracting", 30, "Preprocessing video/audio to 16kHz mono MP3 with ffmpeg...")
        media = extract_audio_from_local_file(path, filename, run_id, cfg)

        _notify(on_progress, "transcribing", 65, "Sending preprocessed audio to transcription backend...")
        result = transcribe_audio_file(
            audio_path=media.audio_path,
            engine=engine,
            settings=cfg,
            language=language,
            whisper_model=whisper_model,
        )
        return PipelineOutput(
            platform=Platform.LOCAL,
            source=f"local://{filename}",
            canonical_url=f"local://{filename}",
            video_id=run_id,
            title=media.title,
            uploader=media.uploader,
            duration_sec=media.duration_sec,
            thumbnail_url=None,
            engine_used=result.engine_used,
            language=result.language,
            segments=result.segments,
            full_text=to_plain_txt(result.segments),
        )
    finally:
        if cfg.cleanup_audio and audio_dir.exists():
            shutil.rmtree(audio_dir, ignore_errors=True)
