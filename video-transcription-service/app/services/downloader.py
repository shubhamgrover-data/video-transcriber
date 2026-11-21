"""Audio & metadata extraction using yt-dlp + ffmpeg for YouTube, Facebook, Instagram, and local uploads."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.config import Settings


@dataclass
class ExtractedMedia:
    audio_path: Path
    title: str
    uploader: Optional[str]
    duration_sec: Optional[float]
    thumbnail_url: Optional[str]


def _build_ydl_opts(settings: Settings, output_template: Optional[str] = None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
    }
    if settings.cookies_file and Path(settings.cookies_file).is_file():
        opts["cookiefile"] = settings.cookies_file
    if settings.proxy_url:
        opts["proxy"] = settings.proxy_url

    if output_template:
        opts.update(
            {
                "format": "bestaudio/best",
                "outtmpl": output_template,
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "64",  # 64kbps mono speech keeps cloud API uploads < 25MB
                    }
                ],
                "postprocessor_args": ["-ac", "1", "-ar", "16000"],
            }
        )
    return opts


def fetch_video_metadata(url: str, settings: Settings) -> dict:
    """Fetch video metadata without downloading media (used for captions fast-path)."""
    try:
        import yt_dlp
    except ImportError:
        return {}

    opts = _build_ydl_opts(settings)
    opts["skip_download"] = True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False) or {}
            return {
                "title": info.get("title"),
                "uploader": info.get("uploader") or info.get("channel"),
                "duration_sec": info.get("duration"),
                "thumbnail_url": info.get("thumbnail"),
            }
    except Exception:
        return {}


def download_audio(url: str, job_id: str, settings: Settings) -> ExtractedMedia:
    """Download and convert video audio track to 16kHz mono MP3 for transcription."""
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError(
            "yt-dlp is not installed. Run `pip install -r requirements.txt` and ensure `ffmpeg` is installed."
        ) from exc

    job_dir = settings.temp_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(job_dir / "audio.%(ext)s")

    opts = _build_ydl_opts(settings, output_template=output_template)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if not info:
            raise RuntimeError("Could not extract video information from this URL.")

        duration = info.get("duration")
        if duration and duration > settings.max_video_duration_sec:
            raise ValueError(
                f"Video duration ({int(duration)}s) exceeds the configured limit "
                f"({settings.max_video_duration_sec}s)."
            )

        info = ydl.extract_info(url, download=True)

    audio_path = job_dir / "audio.mp3"
    if not audio_path.is_file():
        candidates = [p for p in job_dir.iterdir() if p.is_file()]
        if not candidates:
            raise RuntimeError("Audio extraction finished but no audio file was produced. Verify ffmpeg is installed.")
        audio_path = candidates[0]

    return ExtractedMedia(
        audio_path=audio_path,
        title=info.get("title") or "Untitled Video",
        uploader=info.get("uploader") or info.get("channel"),
        duration_sec=float(info["duration"]) if info.get("duration") is not None else None,
        thumbnail_url=info.get("thumbnail"),
    )


def probe_media_duration(media_path: Path) -> Optional[float]:
    """Read duration in seconds using ffprobe when available."""
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(media_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if res.returncode == 0 and res.stdout.strip():
            return round(float(res.stdout.strip()), 2)
    except Exception:
        pass
    return None


def extract_audio_from_local_file(
    input_path: Path,
    original_filename: str,
    job_id: str,
    settings: Settings,
) -> ExtractedMedia:
    """Convert an uploaded local video/audio file to 16kHz mono 64kbps MP3 using ffmpeg."""
    job_dir = settings.temp_dir / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    out_mp3 = job_dir / "audio.mp3"

    duration = probe_media_duration(input_path)
    if duration and duration > settings.max_video_duration_sec:
        raise ValueError(
            f"Media duration ({int(duration)}s) exceeds the configured limit "
            f"({settings.max_video_duration_sec}s)."
        )

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        str(out_mp3),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "ffmpeg is not installed or not on PATH. Install ffmpeg to transcribe local video/audio files."
        ) from exc

    if proc.returncode != 0 or not out_mp3.is_file():
        err_tail = (proc.stderr or "").strip().splitlines()[-3:]
        raise RuntimeError(f"ffmpeg failed to extract audio: {' | '.join(err_tail)}")

    if duration is None:
        duration = probe_media_duration(out_mp3)

    title = Path(original_filename).stem or "Uploaded Media"
    return ExtractedMedia(
        audio_path=out_mp3,
        title=title,
        uploader="Local Upload",
        duration_sec=duration,
        thumbnail_url=None,
    )
