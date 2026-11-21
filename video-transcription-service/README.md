# ClipScribe — Modular Video Transcription Service + MCP Layer

## What Is ClipScribe? (Purpose)

**ClipScribe** is a self-hosted, modular video and audio transcription service that turns **YouTube**, **Facebook**, **Instagram** links—or **local video/audio files** (`MP4`, `MOV`, `MKV`, `MP3`, `WAV`, `M4A`, `OGG`, `FLAC`)—into searchable **timestamped transcripts** exportable as **SRT**, **WebVTT**, **TXT**, and **JSON**.

It is designed so **every layer is decoupled and reusable**:
- **Separate Whisper Container (`whisper`)**: Runs `faster-whisper` (`base` model by default) in its own isolated container with a persistent model cache volume—keeping the API container lightweight and letting you scale or move Whisper to a GPU independently.
- **Orchestration & Preprocessing Server (`api`)**: Accepts links or uploaded files, validates URLs, extracts/normalizes audio to 16 kHz mono MP3 with `yt-dlp` and `ffmpeg`, and routes transcription to either the **separate Whisper container** or the **Groq Whisper Large API** (configured in `.env`) based on the user's choice.
- **Shared Core Utilities (`app/services/pipeline.py`)**: Single reusable implementation of `transcribe_url(...)` and `transcribe_file(...)` shared by both the FastAPI server and the MCP layer with zero duplicated logic.
- **MCP Layer (`mcp_server/server.py`)**: Exposes `transcribe_link`, `transcribe_media_file`, and `list_transcription_engines` as Model Context Protocol (MCP) tools so AI assistants (Claude Desktop, Cursor, Gemini CLI, etc.) can transcribe links or files directly.

---

## System Architecture

```text
  Web UI / REST Clients              MCP Clients (Claude / Cursor / Gemini CLI)
          │                                              │
          ▼                                              ▼
  app/main.py (FastAPI)                       mcp_server/server.py (MCP stdio)
          └──────────────────────┬───────────────────────┘
                                 ▼
              app/services/pipeline.py (Shared Core Utilities)
              • transcribe_url(...)    • transcribe_file(...)
              Uses: url_parser.py, downloader.py (yt-dlp + ffmpeg),
                    transcriber.py, formatter.py
                    ┌────────────┴────────────┐
                    ▼                         ▼
    Container 2: whisper (port 8001)     Groq Cloud API (.env)
    faster-whisper (base by default)     whisper-large-v3-turbo / whisper-large-v3
```

> For the deep-dive architecture, scaling roadmap, cost comparison, and Instagram/Facebook rate-limit guide, read **[ARCHITECTURE_AND_GUIDE.md](./ARCHITECTURE_AND_GUIDE.md)**.

---

## Step-by-Step Installation & Setup

### Option 1: Docker Compose (Recommended — Two Separate Containers)

**Prerequisites:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) or Docker Engine + Compose plugin (Linux).

1. **Unzip the archive** and open a terminal inside the project folder:
   ```bash
   cd video-transcription-service
   ```
2. **Create your `.env` file** from the template:
   ```bash
   cp .env.example .env
   ```
   *(On Windows PowerShell: `Copy-Item .env.example .env`)*
3. **(Optional) Configure Groq Whisper Large API** in `.env`:
   - Open `.env` and set `GROQ_API_KEY=gsk_...` and `GROQ_WHISPER_MODEL=whisper-large-v3-turbo` (or `whisper-large-v3`).
   - Leave `GROQ_API_KEY` empty if you only want to use the free local `whisper` container (`base` model).
4. **Build and start both containers**:
   ```bash
   docker compose up --build
   ```
   - On the first start, the `whisper` container downloads the `faster-whisper` `base` model (~145 MB) into the persistent `whisper_cache` Docker volume so future restarts are instant.
5. **Verify both containers are running**:
   - **Web UI**: Open `http://localhost:8000`
   - **Interactive API Docs (Swagger)**: Open `http://localhost:8000/docs`
   - **Separate Whisper Container Health**: Open `http://localhost:8001/health`

### Option 2: Run Without Docker (Local Python)

1. Install **Python 3.10+** and **ffmpeg** (`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Ubuntu/Debian).
2. Start the Whisper worker in Terminal 1:
   ```bash
   cd whisper_service
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --host 0.0.0.0 --port 8001
   ```
3. Start the API server in Terminal 2:
   ```bash
   cp .env.example .env
   # Ensure WHISPER_SERVICE_URL=http://127.0.0.1:8001 in .env
   ./start.sh        # macOS / Linux (or run start.bat on Windows)
   ```

---

## Using the REST API

### 1. Transcribe a YouTube, Facebook, or Instagram Link
```bash
curl -X POST http://localhost:8000/api/transcribe \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "engine": "faster_whisper",
    "whisper_model": "base"
  }'
```
*(Change `"engine": "groq"` to route to Groq's Whisper Large API instead.)*

### 2. Transcribe a Local Video or Audio File
```bash
curl -X POST http://localhost:8000/api/transcribe/upload \
  -F "file=@./video.mp4" \
  -F "engine=faster_whisper" \
  -F "whisper_model=base"
```

### 3. Poll Job Status & Export (`srt`, `vtt`, `txt`, `plain`, `json`)
```bash
curl http://localhost:8000/api/jobs/<JOB_ID>
curl -L "http://localhost:8000/api/jobs/<JOB_ID>/export?fmt=srt" -o subtitles.srt
```

---

## Connecting the MCP Layer

Use `mcp_server/mcp_config.example.json` in Claude Desktop, Cursor, or any stdio MCP client:

```json
{
  "mcpServers": {
    "clipscribe": {
      "command": "docker",
      "args": [
        "compose", "-f", "/ABSOLUTE/PATH/TO/video-transcription-service/docker-compose.yml",
        "exec", "-T", "api", "python", "-m", "mcp_server.server"
      ]
    }
  }
}
```

**Exposed MCP tools:**
- `transcribe_link`: Link-to-transcript (`url`, `engine`, `language`, `whisper_model`, `output_format`, `prefer_captions`)
- `transcribe_media_file`: Video/audio file-to-transcript (`file_path`, `engine`, `language`, `whisper_model`, `output_format`)
- `list_transcription_engines`: Reports configured backends (`whisper_container`, `groq`, `openai`)

---

## Running Automated Tests

```bash
python3 -m unittest discover -s tests -v
```
