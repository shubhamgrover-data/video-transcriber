"""SQLite persistence layer for transcription jobs."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from app.models import JobResponse, JobStatus, Platform, TranscriptSegment


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    """Thread-safe SQLite store for transcription jobs and timestamped segments."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    canonical_url TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    video_id TEXT,
                    title TEXT,
                    uploader TEXT,
                    duration_sec REAL,
                    thumbnail_url TEXT,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    stage_message TEXT NOT NULL DEFAULT '',
                    engine_used TEXT,
                    language TEXT,
                    segments_json TEXT NOT NULL DEFAULT '[]',
                    full_text TEXT NOT NULL DEFAULT '',
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at DESC)"
            )
            conn.commit()

    def create_job(
        self,
        *,
        job_id: str,
        url: str,
        canonical_url: str,
        platform: Platform,
        video_id: Optional[str],
        language: Optional[str],
    ) -> JobResponse:
        now = _utc_now()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    id, url, canonical_url, platform, video_id, status, progress,
                    stage_message, language, segments_json, full_text, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    url,
                    canonical_url,
                    platform.value,
                    video_id,
                    JobStatus.QUEUED.value,
                    5,
                    "Queued for processing",
                    language,
                    "[]",
                    "",
                    now,
                    now,
                ),
            )
            conn.commit()
        job = self.get_job(job_id)
        assert job is not None
        return job

    def update_job(
        self,
        job_id: str,
        *,
        status: Optional[JobStatus] = None,
        progress: Optional[int] = None,
        stage_message: Optional[str] = None,
        title: Optional[str] = None,
        uploader: Optional[str] = None,
        duration_sec: Optional[float] = None,
        thumbnail_url: Optional[str] = None,
        engine_used: Optional[str] = None,
        language: Optional[str] = None,
        segments: Optional[List[TranscriptSegment]] = None,
        full_text: Optional[str] = None,
        error: Optional[str] = None,
    ) -> Optional[JobResponse]:
        updates: dict[str, object] = {"updated_at": _utc_now()}
        if status is not None:
            updates["status"] = status.value
        if progress is not None:
            updates["progress"] = max(0, min(100, progress))
        if stage_message is not None:
            updates["stage_message"] = stage_message
        if title is not None:
            updates["title"] = title
        if uploader is not None:
            updates["uploader"] = uploader
        if duration_sec is not None:
            updates["duration_sec"] = duration_sec
        if thumbnail_url is not None:
            updates["thumbnail_url"] = thumbnail_url
        if engine_used is not None:
            updates["engine_used"] = engine_used
        if language is not None:
            updates["language"] = language
        if segments is not None:
            updates["segments_json"] = json.dumps([s.model_dump() for s in segments], ensure_ascii=False)
        if full_text is not None:
            updates["full_text"] = full_text
        if error is not None:
            updates["error"] = error

        columns = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [job_id]

        with self._lock, self._connect() as conn:
            conn.execute(f"UPDATE jobs SET {columns} WHERE id = ?", values)
            conn.commit()
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> Optional[JobResponse]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row_to_model(row) if row else None

    def list_jobs(self, limit: int = 25) -> List[JobResponse]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def delete_job(self, job_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
            conn.commit()
            return cur.rowcount > 0

    @staticmethod
    def _row_to_model(row: sqlite3.Row) -> JobResponse:
        raw_segments = json.loads(row["segments_json"] or "[]")
        segments = [TranscriptSegment(**item) for item in raw_segments]
        return JobResponse(
            id=row["id"],
            url=row["url"],
            canonical_url=row["canonical_url"],
            platform=Platform(row["platform"]),
            video_id=row["video_id"],
            title=row["title"],
            uploader=row["uploader"],
            duration_sec=row["duration_sec"],
            thumbnail_url=row["thumbnail_url"],
            status=JobStatus(row["status"]),
            progress=row["progress"],
            stage_message=row["stage_message"],
            engine_used=row["engine_used"],
            language=row["language"],
            segments=segments,
            full_text=row["full_text"],
            error=row["error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
