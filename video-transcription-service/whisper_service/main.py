"""Dedicated faster-whisper HTTP microservice designed to run in its own Docker container."""

from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

ALLOWED_MODELS = ("tiny", "base", "small", "medium", "large-v3")

DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
PRELOAD_MODEL = os.getenv("PRELOAD_MODEL", "true").lower() == "true"

_MODEL_CACHE: dict[str, object] = {}
_MODEL_LOCK = threading.Lock()


def get_whisper_model(model_name: str):
    """Load and cache a faster-whisper WhisperModel instance."""
    if model_name not in ALLOWED_MODELS:
        raise ValueError(f"Unsupported model '{model_name}'. Allowed: {', '.join(ALLOWED_MODELS)}.")

    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(model_name)
        if cached is not None:
            return cached

        from faster_whisper import WhisperModel

        device = "cpu" if WHISPER_DEVICE == "auto" else WHISPER_DEVICE
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=WHISPER_COMPUTE_TYPE,
        )
        _MODEL_CACHE[model_name] = model
        return model


app = FastAPI(
    title="ClipScribe Whisper Worker",
    version="1.0.0",
    description="Dedicated faster-whisper container serving timestamped speech-to-text over HTTP.",
)


@app.on_event("startup")
def _startup_preload() -> None:
    if PRELOAD_MODEL:
        try:
            get_whisper_model(DEFAULT_MODEL)
        except Exception:
            # Allow container to boot cleanly if running in test environments without faster-whisper
            pass


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "default_model": DEFAULT_MODEL,
        "device": WHISPER_DEVICE,
        "compute_type": WHISPER_COMPUTE_TYPE,
        "loaded_models": sorted(_MODEL_CACHE.keys()),
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    model: Optional[str] = Form(default=None),
) -> dict:
    chosen_model = (model or DEFAULT_MODEL).strip()
    if chosen_model not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model '{chosen_model}'. Allowed: {', '.join(ALLOWED_MODELS)}.",
        )

    suffix = Path(file.filename or "audio.mp3").suffix or ".mp3"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        while chunk := await file.read(1024 * 1024):
            tmp.write(chunk)
        tmp_path = Path(tmp.name)
    await file.close()

    try:
        whisper_model = get_whisper_model(chosen_model)
        raw_segments, info = whisper_model.transcribe(
            str(tmp_path),
            language=language or None,
            vad_filter=True,
            beam_size=5,
        )

        segments = []
        for seg in raw_segments:
            text = seg.text.strip()
            if not text:
                continue
            segments.append(
                {
                    "id": len(segments) + 1,
                    "start": round(float(seg.start), 3),
                    "end": round(float(seg.end), 3),
                    "text": text,
                }
            )

        return {
            "model": chosen_model,
            "engine_used": f"faster_whisper:{chosen_model}",
            "language": getattr(info, "language", language),
            "segments": segments,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Whisper transcription error: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)
