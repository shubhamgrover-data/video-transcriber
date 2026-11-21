"""Application configuration loaded from environment variables and optional .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(env_path: Path) -> None:
    """Minimal .env loader so the app works even if python-dotenv is not installed."""
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


BASE_DIR = Path(__file__).resolve().parent.parent
_load_dotenv(BASE_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "ClipScribe — Video Transcription Service")
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))

    # Storage paths
    data_dir: Path = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
    db_path: Path = Path(os.getenv("DB_PATH", str(BASE_DIR / "data" / "jobs.db")))
    temp_dir: Path = Path(os.getenv("TEMP_DIR", str(BASE_DIR / "data" / "tmp")))

    # Transcription engine: auto | faster_whisper | groq | openai | demo
    default_engine: str = os.getenv("TRANSCRIPTION_ENGINE", "auto")
    prefer_youtube_captions: bool = os.getenv("PREFER_YOUTUBE_CAPTIONS", "true").lower() == "true"

    # Dedicated faster-whisper container URL (e.g. http://whisper:8001 in Docker Compose)
    whisper_service_url: str = os.getenv("WHISPER_SERVICE_URL", "").rstrip("/")
    whisper_service_timeout_sec: int = int(os.getenv("WHISPER_SERVICE_TIMEOUT_SEC", "1800"))

    # faster-whisper model settings (defaults to base)
    whisper_model: str = os.getenv("WHISPER_MODEL", "base")
    whisper_device: str = os.getenv("WHISPER_DEVICE", "auto")
    whisper_compute_type: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

    # Cloud API keys (optional)
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    groq_model: str = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_WHISPER_MODEL", "whisper-1")

    # Media extraction settings (helpful for Instagram/Facebook rate limits or private content)
    cookies_file: str = os.getenv("COOKIES_FILE", "")
    proxy_url: str = os.getenv("PROXY_URL", "")
    max_video_duration_sec: int = int(os.getenv("MAX_VIDEO_DURATION_SEC", "7200"))  # 2 hours
    cleanup_audio: bool = os.getenv("CLEANUP_AUDIO", "true").lower() == "true"


def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.temp_dir.mkdir(parents=True, exist_ok=True)
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    return settings
