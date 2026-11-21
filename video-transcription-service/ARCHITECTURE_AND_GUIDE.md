# ClipScribe — Full Architecture, Purpose & Production Scaling Guide

## 1. Purpose of This Application

ClipScribe solves a common media-processing workflow: given a **YouTube**, **Facebook**, or **Instagram** link—or a **local video/audio file**—automatically extract clean speech audio and generate an accurate, **timestamped transcript** (`SRT`, `WebVTT`, `TXT`, `JSON`).

Rather than bundling everything into a monolithic script, ClipScribe is architected for **maximum reusability and isolation**:
1. **Isolated ML Inference (`whisper` container)**: Keeps `faster-whisper` (`base` by default) and its model weights in a dedicated container so the web/API container stays small, restarts quickly, and can scale independently (or move to a GPU host).
2. **User-Selectable Backend Routing**: Every request lets the user choose between the **separate `faster-whisper` container** (free, private, self-hosted) and the **Groq Whisper Large API** (`whisper-large-v3-turbo` / `whisper-large-v3`, configured via `.env`).
3. **Reusable Core Pipeline (`app/services/pipeline.py`)**: All validation, preprocessing, routing, and formatting live in pure Python service modules imported by both the **FastAPI Web/REST server** and the **MCP server**.
4. **First-Class MCP Layer (`mcp_server/server.py`)**: Wraps `transcribe_url` and `transcribe_file` as standard Model Context Protocol (MCP) tools for AI agents and IDE assistants.

---

## 2. Two-Container + MCP Architecture

```text
┌───────────────────────────┐      ┌────────────────────────────────────────┐
│   Browser / REST Client   │      │  MCP Client (Claude / Cursor / CLI)    │
└─────────────┬─────────────┘      └───────────────────┬────────────────────┘
              │ HTTP :8000                             │ stdio (JSON-RPC 2.0)
              ▼                                        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Container 1: clipscribe-api  (Dockerfile — lightweight, NO Whisper ML)   │
│                                                                           │
│  Entrypoints:                                                             │
│   • app/main.py          — FastAPI REST API + Web UI + SQLite JobStore    │
│   • mcp_server/server.py — MCP wrapper (transcribe_link, transcribe_file) │
│                                                                           │
│  Shared Reusable Core (app/services/):                                    │
│   • pipeline.py    — transcribe_url() & transcribe_file() orchestration   │
│   • url_parser.py  — YouTube, Facebook, Instagram URL canonicalization    │
│   • downloader.py  — yt-dlp + ffmpeg (16kHz mono 64kbps MP3 + ffprobe)    │
│   • transcriber.py — Backend router (Whisper Container / Groq / OpenAI)   │
│   • formatter.py   — SRT, WebVTT, timestamped TXT, plain TXT, JSON        │
└───────────────────┬───────────────────────────────────────┬───────────────┘
                    │ HTTP POST /transcribe                 │ HTTPS API
                    │ (WHISPER_SERVICE_URL)                 │ (GROQ_API_KEY)
                    ▼                                       ▼
┌─────────────────────────────────────────┐   ┌─────────────────────────────┐
│  Container 2: clipscribe-whisper (:8001)│   │   Groq Cloud Whisper API    │
│  (whisper_service/Dockerfile)           │   │   whisper-large-v3-turbo    │
│  • faster-whisper (default: base)       │   │   or whisper-large-v3       │
│  • Persistent volume: whisper_cache     │   │   (configured in .env)      │
└─────────────────────────────────────────┘   └─────────────────────────────┘
```

---

## 3. Project Folder Structure

| Path | Responsibility |
| :--- | :--- |
| `docker-compose.yml` | Orchestrates the two separate containers (`whisper` on `:8001` and `api` on `:8000`) + persistent `whisper_cache` volume |
| `Dockerfile` & `requirements.txt` | Lightweight API + `ffmpeg` + `yt-dlp` + MCP container (no `faster-whisper`) |
| `whisper_service/Dockerfile` & `main.py` | Dedicated `faster-whisper` (`base`) microservice exposing `/health` and `/transcribe` |
| `app/services/pipeline.py` | Reusable `transcribe_url()` and `transcribe_file()` functions shared by REST API and MCP |
| `app/services/url_parser.py` | Validates & normalizes YouTube, Facebook, and Instagram URLs |
| `app/services/downloader.py` | Extracts 16 kHz mono 64 kbps MP3 via `yt-dlp` (links) or `ffmpeg` (local uploads) |
| `app/services/transcriber.py` | Routes preprocessed audio to the Whisper container, Groq API, OpenAI API, or YouTube captions fast-path |
| `app/services/formatter.py` | Converts canonical `{id, start, end, text}` segments into SRT, VTT, TXT, and JSON |
| `app/main.py` & `app/static/` | FastAPI REST server, SQLite job history, and responsive Web UI |
| `mcp_server/server.py` | MCP stdio server wrapping `transcribe_link`, `transcribe_media_file`, and `list_transcription_engines` |
| `tests/test_app.py` | Unit + live two-service HTTP + MCP JSON-RPC automated test suite |

---

## 4. Backend Comparison (Whisper Container vs. Groq API)

| Backend | Model | Best For | Where It Runs |
| :--- | :--- | :--- | :--- |
| **YouTube Captions Fast-Path** | Native subtitles | Instant (< 1s), zero-cost YouTube transcripts | `api` container |
| **Separate `whisper` Container** | `faster-whisper` (`base` default; supports `tiny`/`small`/`medium`/`large-v3`) | Free, private, offline transcription; no API bills | `whisper` container (`:8001`) |
| **Groq Whisper API** | `whisper-large-v3-turbo` or `whisper-large-v3` | Ultra-fast high-accuracy multilingual transcription without a local GPU | Groq Cloud (`.env` key) |
| **OpenAI Whisper API** | `whisper-1` | Optional cloud fallback | OpenAI Cloud (`.env` key) |

---

## 5. Handling Instagram & Facebook Rate Limits

- Public **YouTube**, **Facebook**, and **Instagram** videos are extracted via `yt-dlp` and converted to 16 kHz mono 64 kbps MP3 (reducing a ~21 MB 720p video to ~3 MB of audio—well under Groq's 25 MB upload limit).
- If Instagram or Facebook rate-limits datacenter IPs or requires login:
  1. Export browser cookies in Netscape format (`cookies.txt`).
  2. Mount `./cookies.txt:/app/cookies.txt:ro` in `docker-compose.yml` and set `COOKIES_FILE=/app/cookies.txt` in `.env`.
  3. For high-volume production use, set `PROXY_URL` to a residential proxy and update `yt-dlp` regularly.

---

## 6. Scaling to Production

When moving beyond personal or small-team usage:
1. **Replace SQLite with PostgreSQL** (`app/database.py`) and cache completed transcripts by `(platform, video_id, language)`.
2. **Replace `ThreadPoolExecutor` with Celery + Redis** so multiple `api` worker replicas process downloads concurrently.
3. **Scale the `whisper` container horizontally** behind a load balancer or enable the NVIDIA GPU block already commented in `docker-compose.yml`.
4. **Chunk audio > 45 minutes** with `ffmpeg -f segment` when sending very long recordings to Groq's 25 MB API limit, offsetting each chunk's timestamps automatically.
