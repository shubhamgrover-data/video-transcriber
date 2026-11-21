"""FastAPI REST & Web UI adapter built on top of ClipScribe's reusable core pipeline."""

from __future__ import annotations

import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import Settings, get_settings
from app.database import JobStore
from app.models import (
    ALLOWED_WHISPER_MODELS,
    HealthResponse,
    JobListResponse,
    JobResponse,
    JobStatus,
    Platform,
    TranscribeRequest,
    TranscriptionEngine,
)
from app.services.formatter import to_json_export, to_plain_txt, to_srt, to_timestamped_txt, to_vtt
from app.services.pipeline import transcribe_file, transcribe_url
from app.services.transcriber import detect_available_engines
from app.services.url_parser import parse_video_url

ALLOWED_UPLOAD_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".ogg", ".flac"}


def create_app(custom_settings: Settings | None = None) -> FastAPI:
    settings = custom_settings or get_settings()
    store = JobStore(settings.db_path)
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="transcribe-worker")

    app = FastAPI(
        title=settings.app_name,
        version="2.0.0",
        description=(
            "Submit YouTube, Facebook, or Instagram links — or upload local video/audio files — "
            "to preprocess and transcribe via the separate faster-whisper container or Groq Whisper Large API."
        ),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.settings = settings
    app.state.store = store
    app.state.executor = executor

    def _make_progress_cb(job_id: str):
        def _cb(stage: str, progress: int, message: str) -> None:
            status_map = {
                "queued": JobStatus.QUEUED,
                "extracting": JobStatus.EXTRACTING,
                "transcribing": JobStatus.TRANSCRIBING,
            }
            store.update_job(
                job_id,
                status=status_map.get(stage, JobStatus.TRANSCRIBING),
                progress=progress,
                stage_message=message,
            )

        return _cb

    def _run_url_job(job_id: str, request: TranscribeRequest) -> None:
        try:
            output = transcribe_url(
                request.url,
                engine=request.engine,
                language=request.language,
                whisper_model=request.whisper_model,
                prefer_captions=request.prefer_captions,
                settings=settings,
                job_id=job_id,
                on_progress=_make_progress_cb(job_id),
            )
            store.update_job(
                job_id,
                status=JobStatus.COMPLETED,
                progress=100,
                stage_message="Transcription completed",
                title=output.title,
                uploader=output.uploader,
                duration_sec=output.duration_sec,
                thumbnail_url=output.thumbnail_url,
                engine_used=output.engine_used,
                language=output.language,
                segments=output.segments,
                full_text=output.full_text,
            )
        except Exception as exc:
            store.update_job(
                job_id,
                status=JobStatus.FAILED,
                progress=100,
                stage_message="Transcription failed",
                error=str(exc),
            )

    def _run_file_job(
        job_id: str,
        uploaded_path: Path,
        original_filename: str,
        engine: TranscriptionEngine,
        language: Optional[str],
        whisper_model: Optional[str],
    ) -> None:
        upload_dir = uploaded_path.parent
        try:
            output = transcribe_file(
                uploaded_path,
                original_filename=original_filename,
                engine=engine,
                language=language,
                whisper_model=whisper_model,
                settings=settings,
                job_id=job_id,
                on_progress=_make_progress_cb(job_id),
            )
            store.update_job(
                job_id,
                status=JobStatus.COMPLETED,
                progress=100,
                stage_message="Transcription completed",
                title=output.title,
                uploader=output.uploader,
                duration_sec=output.duration_sec,
                engine_used=output.engine_used,
                language=output.language,
                segments=output.segments,
                full_text=output.full_text,
            )
        except Exception as exc:
            store.update_job(
                job_id,
                status=JobStatus.FAILED,
                progress=100,
                stage_message="Transcription failed",
                error=str(exc),
            )
        finally:
            if settings.cleanup_audio and upload_dir.exists():
                shutil.rmtree(upload_dir, ignore_errors=True)

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            app_name=settings.app_name,
            default_engine=settings.default_engine,
            default_whisper_model=settings.whisper_model,
            supported_platforms=[p.value for p in Platform],
            available_engines=detect_available_engines(settings),
        )

    @app.post("/api/transcribe", response_model=JobResponse, status_code=202)
    def submit_transcription(request: TranscribeRequest) -> JobResponse:
        if request.whisper_model and request.whisper_model not in ALLOWED_WHISPER_MODELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported whisper_model '{request.whisper_model}'. Choose from: {', '.join(ALLOWED_WHISPER_MODELS)}.",
            )
        try:
            parsed = parse_video_url(request.url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        job_id = uuid.uuid4().hex[:12]
        job = store.create_job(
            job_id=job_id,
            url=parsed.original_url,
            canonical_url=parsed.canonical_url,
            platform=parsed.platform,
            video_id=parsed.video_id,
            language=request.language,
        )
        executor.submit(_run_url_job, job_id, request)
        return job

    @app.post("/api/transcribe/upload", response_model=JobResponse, status_code=202)
    async def submit_file_upload(
        file: UploadFile = File(...),
        engine: TranscriptionEngine = Form(default=TranscriptionEngine.AUTO),
        language: Optional[str] = Form(default=None),
        whisper_model: Optional[str] = Form(default=None),
    ) -> JobResponse:
        filename = (file.filename or "uploaded_video.mp4").strip()
        suffix = Path(filename).suffix.lower()
        if suffix not in ALLOWED_UPLOAD_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_UPLOAD_EXTENSIONS))}.",
            )
        if whisper_model and whisper_model not in ALLOWED_WHISPER_MODELS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported whisper_model '{whisper_model}'. Choose from: {', '.join(ALLOWED_WHISPER_MODELS)}.",
            )

        job_id = uuid.uuid4().hex[:12]
        upload_dir = settings.temp_dir / f"upload_{job_id}"
        upload_dir.mkdir(parents=True, exist_ok=True)
        saved_path = upload_dir / f"source{suffix}"

        with saved_path.open("wb") as out_file:
            while chunk := await file.read(1024 * 1024):
                out_file.write(chunk)
        await file.close()

        store.create_job(
            job_id=job_id,
            url=f"local://{filename}",
            canonical_url=f"local://{filename}",
            platform=Platform.LOCAL,
            video_id=job_id,
            language=language or None,
        )
        store.update_job(job_id, title=Path(filename).stem, uploader="Local Upload")

        executor.submit(
            _run_file_job,
            job_id,
            saved_path,
            filename,
            engine,
            language or None,
            whisper_model or None,
        )
        updated = store.get_job(job_id)
        assert updated is not None
        return updated

    @app.get("/api/jobs", response_model=JobListResponse)
    def list_jobs(limit: int = Query(default=25, ge=1, le=100)) -> JobListResponse:
        jobs = store.list_jobs(limit=limit)
        return JobListResponse(jobs=jobs, total=len(jobs))

    @app.get("/api/jobs/{job_id}", response_model=JobResponse)
    def get_job(job_id: str) -> JobResponse:
        job = store.get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        return job

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str) -> dict[str, bool]:
        deleted = store.delete_job(job_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Job not found.")
        return {"deleted": True}

    @app.get("/api/jobs/{job_id}/export")
    def export_transcript(
        job_id: str,
        fmt: str = Query(default="srt", pattern="^(srt|vtt|txt|plain|json)$"),
    ) -> Response:
        job = store.get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        if job.status != JobStatus.COMPLETED:
            raise HTTPException(status_code=409, detail="Transcript is not ready yet.")

        safe_stem = f"transcript_{job.platform.value}_{job.video_id or job.id}"

        if fmt == "srt":
            content = to_srt(job.segments)
            return PlainTextResponse(
                content,
                media_type="application/x-subrip; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{safe_stem}.srt"'},
            )
        if fmt == "vtt":
            content = to_vtt(job.segments)
            return PlainTextResponse(
                content,
                media_type="text/vtt; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{safe_stem}.vtt"'},
            )
        if fmt == "txt":
            content = to_timestamped_txt(job.segments)
            return PlainTextResponse(
                content,
                media_type="text/plain; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{safe_stem}_timestamps.txt"'},
            )
        if fmt == "plain":
            content = to_plain_txt(job.segments)
            return PlainTextResponse(
                content,
                media_type="text/plain; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{safe_stem}.txt"'},
            )

        content = to_json_export(
            job.segments,
            metadata={
                "id": job.id,
                "platform": job.platform.value,
                "url": job.canonical_url,
                "title": job.title,
                "uploader": job.uploader,
                "duration_sec": job.duration_sec,
                "language": job.language,
                "engine_used": job.engine_used,
            },
        )
        return Response(
            content=content,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_stem}.json"'},
        )

    static_dir = Path(__file__).resolve().parent / "static"
    if static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

        @app.get("/", include_in_schema=False)
        def serve_index() -> FileResponse:
            return FileResponse(static_dir / "index.html")

    return app


app = create_app()
