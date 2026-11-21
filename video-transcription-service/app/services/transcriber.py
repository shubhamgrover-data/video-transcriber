"""Multi-engine transcription pipeline (YouTube Captions, Separate faster-whisper Container, Local faster-whisper, Groq, OpenAI, Demo)."""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import httpx

from app.config import Settings
from app.models import ALLOWED_WHISPER_MODELS, Platform, TranscriptSegment, TranscriptionEngine


@dataclass
class TranscriptionResult:
    segments: List[TranscriptSegment]
    language: Optional[str]
    engine_used: str


_LOCAL_WHISPER_MODEL_CACHE: dict[str, object] = {}


def detect_available_engines(settings: Settings) -> dict[str, bool]:
    """Report which transcription backends are currently configured/installed."""
    has_whisper_container = bool(settings.whisper_service_url)
    has_local_whisper = importlib.util.find_spec("faster_whisper") is not None
    return {
        "youtube_captions": importlib.util.find_spec("youtube_transcript_api") is not None,
        "faster_whisper": has_whisper_container or has_local_whisper,
        "whisper_container": has_whisper_container,
        "groq": bool(settings.groq_api_key) and importlib.util.find_spec("groq") is not None,
        "openai": bool(settings.openai_api_key) and importlib.util.find_spec("openai") is not None,
        "demo": True,
    }


def try_youtube_captions(video_id: str, language: Optional[str] = None) -> Optional[TranscriptionResult]:
    """Fast-path: fetch existing YouTube subtitles with timestamps (instant & free)."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None

    try:
        api = YouTubeTranscriptApi()
        preferred_langs = [language] if language else ["en", "en-US", "en-GB", "hi"]
        if hasattr(api, "fetch"):
            fetched = api.fetch(video_id, languages=preferred_langs)
            raw_items = list(fetched)
            detected_lang = getattr(fetched, "language_code", language or "en")
        else:
            raw_items = YouTubeTranscriptApi.get_transcript(video_id, languages=preferred_langs)
            detected_lang = language or "en"

        segments: List[TranscriptSegment] = []
        for item in raw_items:
            text = (item.text if hasattr(item, "text") else item.get("text", "")).replace("\n", " ").strip()
            if not text:
                continue
            start = float(item.start if hasattr(item, "start") else item.get("start", 0.0))
            duration = float(item.duration if hasattr(item, "duration") else item.get("duration", 2.0))
            segments.append(
                TranscriptSegment(
                    id=len(segments) + 1,
                    start=round(start, 3),
                    end=round(start + max(duration, 0.2), 3),
                    text=text,
                )
            )
        if not segments:
            return None
        return TranscriptionResult(
            segments=segments,
            language=detected_lang,
            engine_used="youtube_captions",
        )
    except Exception:
        return None


def transcribe_audio_file(
    audio_path: Path,
    engine: TranscriptionEngine,
    settings: Settings,
    language: Optional[str] = None,
    whisper_model: Optional[str] = None,
) -> TranscriptionResult:
    """Transcribe a downloaded or uploaded audio file using the chosen or auto-detected engine."""
    resolved = _resolve_engine(engine, settings)

    if resolved == TranscriptionEngine.GROQ:
        return _transcribe_groq(audio_path, settings, language)
    if resolved == TranscriptionEngine.OPENAI:
        return _transcribe_openai(audio_path, settings, language)
    if resolved == TranscriptionEngine.FASTER_WHISPER:
        if settings.whisper_service_url:
            return _transcribe_whisper_container(audio_path, settings, language, whisper_model)
        return _transcribe_faster_whisper_local(audio_path, settings, language, whisper_model)
    raise RuntimeError(f"Unsupported transcription engine: {resolved}")


def _resolve_engine(requested: TranscriptionEngine, settings: Settings) -> TranscriptionEngine:
    if requested != TranscriptionEngine.AUTO:
        return requested

    configured = settings.default_engine.lower()
    if configured in {"groq", "openai", "faster_whisper", "demo"}:
        return TranscriptionEngine(configured)

    # Auto priority: Dedicated Whisper Container -> Groq -> OpenAI -> Local faster-whisper
    if settings.whisper_service_url:
        return TranscriptionEngine.FASTER_WHISPER
    if settings.groq_api_key and importlib.util.find_spec("groq") is not None:
        return TranscriptionEngine.GROQ
    if settings.openai_api_key and importlib.util.find_spec("openai") is not None:
        return TranscriptionEngine.OPENAI
    if importlib.util.find_spec("faster_whisper") is not None:
        return TranscriptionEngine.FASTER_WHISPER

    raise RuntimeError(
        "No transcription backend is ready. Run `docker compose up --build` (to start the separate faster-whisper container), "
        "install `faster-whisper` locally, or set GROQ_API_KEY / OPENAI_API_KEY in .env."
    )


def _transcribe_whisper_container(
    audio_path: Path,
    settings: Settings,
    language: Optional[str],
    whisper_model: Optional[str] = None,
) -> TranscriptionResult:
    """Send extracted audio to the separate faster-whisper container over HTTP."""
    model_name = (whisper_model or settings.whisper_model or "base").strip()
    if model_name not in ALLOWED_WHISPER_MODELS:
        raise ValueError(
            f"Unsupported Whisper model '{model_name}'. Choose one of: {', '.join(ALLOWED_WHISPER_MODELS)}."
        )

    endpoint = f"{settings.whisper_service_url}/transcribe"
    form_data = {"model": model_name}
    if language:
        form_data["language"] = language

    with audio_path.open("rb") as fh:
        files = {"file": (audio_path.name, fh, "audio/mpeg")}
        response = httpx.post(
            endpoint,
            data=form_data,
            files=files,
            timeout=settings.whisper_service_timeout_sec,
        )

    if response.status_code != 200:
        detail = response.text[:300]
        raise RuntimeError(f"Whisper container returned HTTP {response.status_code}: {detail}")

    payload = response.json()
    segments = [
        TranscriptSegment(
            id=int(item["id"]),
            start=float(item["start"]),
            end=float(item["end"]),
            text=str(item["text"]).strip(),
        )
        for item in payload.get("segments", [])
        if str(item.get("text", "")).strip()
    ]
    return TranscriptionResult(
        segments=segments,
        language=payload.get("language") or language,
        engine_used=payload.get("engine_used") or f"faster_whisper:{model_name}",
    )


def _transcribe_faster_whisper_local(
    audio_path: Path,
    settings: Settings,
    language: Optional[str],
    whisper_model: Optional[str] = None,
) -> TranscriptionResult:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper is not installed in this container. Set WHISPER_SERVICE_URL to point to the separate "
            "whisper container (default in docker-compose.yml) or run `pip install faster-whisper`."
        ) from exc

    model_name = (whisper_model or settings.whisper_model or "base").strip()
    if model_name not in ALLOWED_WHISPER_MODELS:
        raise ValueError(
            f"Unsupported Whisper model '{model_name}'. Choose one of: {', '.join(ALLOWED_WHISPER_MODELS)}."
        )

    cache_key = f"{model_name}:{settings.whisper_device}:{settings.whisper_compute_type}"
    model = _LOCAL_WHISPER_MODEL_CACHE.get(cache_key)
    if model is None:
        device = settings.whisper_device
        if device == "auto":
            device = "cpu"
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=settings.whisper_compute_type,
        )
        _LOCAL_WHISPER_MODEL_CACHE[cache_key] = model

    raw_segments, info = model.transcribe(
        str(audio_path),
        language=language or None,
        vad_filter=True,
        beam_size=5,
    )

    segments: List[TranscriptSegment] = []
    for seg in raw_segments:
        text = seg.text.strip()
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                id=len(segments) + 1,
                start=round(float(seg.start), 3),
                end=round(float(seg.end), 3),
                text=text,
            )
        )

    return TranscriptionResult(
        segments=segments,
        language=getattr(info, "language", language),
        engine_used=f"faster_whisper:{model_name}",
    )


def _transcribe_groq(
    audio_path: Path,
    settings: Settings,
    language: Optional[str],
) -> TranscriptionResult:
    if not settings.groq_api_key:
        raise RuntimeError("GROQ_API_KEY is not set in your environment or .env file.")
    try:
        from groq import Groq
    except ImportError as exc:
        raise RuntimeError("groq SDK is not installed. Run `pip install groq`.") from exc

    client = Groq(api_key=settings.groq_api_key)
    with audio_path.open("rb") as audio_file:
        kwargs = {
            "file": (audio_path.name, audio_file.read()),
            "model": settings.groq_model,
            "response_format": "verbose_json",
        }
        if language:
            kwargs["language"] = language
        response = client.audio.transcriptions.create(**kwargs)

    return _parse_verbose_json_response(response, f"groq:{settings.groq_model}", language)


def _transcribe_openai(
    audio_path: Path,
    settings: Settings,
    language: Optional[str],
) -> TranscriptionResult:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in your environment or .env file.")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise RuntimeError("openai SDK is not installed. Run `pip install openai`.") from exc

    client = OpenAI(api_key=settings.openai_api_key)
    with audio_path.open("rb") as audio_file:
        kwargs = {
            "file": audio_file,
            "model": settings.openai_model,
            "response_format": "verbose_json",
            "timestamp_granularities": ["segment"],
        }
        if language:
            kwargs["language"] = language
        response = client.audio.transcriptions.create(**kwargs)

    return _parse_verbose_json_response(response, f"openai:{settings.openai_model}", language)


def _parse_verbose_json_response(
    response: object,
    engine_label: str,
    fallback_language: Optional[str],
) -> TranscriptionResult:
    raw_segments = getattr(response, "segments", None)
    if raw_segments is None and isinstance(response, dict):
        raw_segments = response.get("segments", [])
    raw_segments = raw_segments or []

    segments: List[TranscriptSegment] = []
    for item in raw_segments:
        if isinstance(item, dict):
            text = str(item.get("text", "")).strip()
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start + 1.0))
        else:
            text = str(getattr(item, "text", "")).strip()
            start = float(getattr(item, "start", 0.0))
            end = float(getattr(item, "end", start + 1.0))
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                id=len(segments) + 1,
                start=round(start, 3),
                end=round(end, 3),
                text=text,
            )
        )

    if not segments:
        full_text = getattr(response, "text", None) or (
            response.get("text", "") if isinstance(response, dict) else ""
        )
        if full_text:
            segments.append(TranscriptSegment(id=1, start=0.0, end=5.0, text=str(full_text).strip()))

    detected_lang = getattr(response, "language", None) or (
        response.get("language") if isinstance(response, dict) else None
    )
    return TranscriptionResult(
        segments=segments,
        language=detected_lang or fallback_language,
        engine_used=engine_label,
    )


def generate_demo_transcript(platform: Platform, label: str) -> tuple[dict, TranscriptionResult]:
    """Generate a realistic sample timestamped transcript so users can test the UI offline."""
    platform_label = "Local Upload" if platform == Platform.LOCAL else platform.value.capitalize()
    metadata = {
        "title": f"[{platform_label} Demo] {label}" if platform == Platform.LOCAL else f"[{platform_label} Demo] Sample Timestamped Video Transcript",
        "uploader": f"{platform_label} Studio",
        "duration_sec": 42.0,
        "thumbnail_url": None,
    }
    segments = [
        TranscriptSegment(
            id=1,
            start=0.0,
            end=7.4,
            text=f"Welcome! This is a demo timestamped transcript generated for your {platform_label} input.",
        ),
        TranscriptSegment(
            id=2,
            start=7.4,
            end=16.2,
            text="In live mode, ClipScribe extracts the audio track with yt-dlp and ffmpeg at 16 kilohertz mono.",
        ),
        TranscriptSegment(
            id=3,
            start=16.2,
            end=26.8,
            text="Audio is then sent over HTTP to the separate faster-whisper container running the base model.",
        ),
        TranscriptSegment(
            id=4,
            start=26.8,
            end=35.5,
            text="You can search keywords below, click any timestamp to jump directly, or export SRT, WebVTT, TXT, and JSON.",
        ),
        TranscriptSegment(
            id=5,
            start=35.5,
            end=42.0,
            text="Switch the engine selector to Local faster-whisper (base/small/large-v3), Groq, or OpenAI to transcribe real videos.",
        ),
    ]
    return metadata, TranscriptionResult(segments=segments, language="en", engine_used="demo")
