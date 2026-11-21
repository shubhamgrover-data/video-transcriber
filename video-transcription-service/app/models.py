"""Pydantic models for API requests, responses, and transcript segments."""

from __future__ import annotations

from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class Platform(str, Enum):
    YOUTUBE = "youtube"
    FACEBOOK = "facebook"
    INSTAGRAM = "instagram"
    LOCAL = "local"


class JobStatus(str, Enum):
    QUEUED = "queued"
    EXTRACTING = "extracting"
    TRANSCRIBING = "transcribing"
    COMPLETED = "completed"
    FAILED = "failed"


class TranscriptionEngine(str, Enum):
    AUTO = "auto"
    FASTER_WHISPER = "faster_whisper"
    GROQ = "groq"
    OPENAI = "openai"
    DEMO = "demo"


ALLOWED_WHISPER_MODELS = ("tiny", "base", "small", "medium", "large-v3")


class TranscriptSegment(BaseModel):
    id: int = Field(..., description="1-based segment index")
    start: float = Field(..., ge=0.0, description="Start time in seconds")
    end: float = Field(..., ge=0.0, description="End time in seconds")
    text: str = Field(..., description="Transcribed text for this segment")


class TranscribeRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048, description="YouTube, Facebook, or Instagram video URL")
    language: Optional[str] = Field(
        default=None,
        max_length=12,
        description="Optional ISO-639-1 language code (e.g. 'en', 'hi', 'es'). Leave empty for auto-detect.",
    )
    engine: TranscriptionEngine = Field(
        default=TranscriptionEngine.AUTO,
        description="Transcription engine to use ('auto', 'faster_whisper', 'groq', 'openai', or 'demo').",
    )
    whisper_model: Optional[str] = Field(
        default=None,
        description="Optional local faster-whisper model size: tiny, base, small, medium, or large-v3.",
    )
    prefer_captions: bool = Field(
        default=True,
        description="For YouTube videos, fetch native captions instantly if available before falling back to audio ASR.",
    )


class JobResponse(BaseModel):
    id: str
    url: str
    canonical_url: str
    platform: Platform
    video_id: Optional[str] = None
    title: Optional[str] = None
    uploader: Optional[str] = None
    duration_sec: Optional[float] = None
    thumbnail_url: Optional[str] = None
    status: JobStatus
    progress: int = Field(default=0, ge=0, le=100)
    stage_message: str = ""
    engine_used: Optional[str] = None
    language: Optional[str] = None
    segments: List[TranscriptSegment] = Field(default_factory=list)
    full_text: str = ""
    error: Optional[str] = None
    created_at: str
    updated_at: str


class JobListResponse(BaseModel):
    jobs: List[JobResponse]
    total: int


class HealthResponse(BaseModel):
    status: str
    app_name: str
    default_engine: str
    default_whisper_model: str
    supported_platforms: List[str]
    available_engines: dict[str, bool]
