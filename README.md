# ClipScribe — Video Transcription Service

Timestamped transcription service for YouTube, Facebook, Instagram, and local video/audio files, migrated to Node.js 22 + Express + TypeScript.

## Features

- **Video Link & Local Upload Modes**: Submit YouTube, Facebook, or Instagram URLs or upload local media files (`.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.mp3`, `.wav`, `.m4a`, `.ogg`, `.flac`).
- **Multi-Engine Transcription**:
  - YouTube native captions fast-path via HTTP
  - Dedicated `faster-whisper` HTTP container (`WHISPER_SERVICE_URL`)
  - Groq Whisper API (`GROQ_API_KEY`)
  - OpenAI Whisper API (`OPENAI_API_KEY`)
  - Built-in Demo Mode for instant previewing
- **Interactive Transcript Viewer**: Live keyword search with highlights, clickable timestamps, copy with/without timestamps, and recent job history.
- **Export Formats**: Download transcripts as `.srt`, `.vtt`, timestamped `.txt`, plain `.txt`, or `.json`.

## Running Locally

```bash
npm install
npm run dev
```

The server listens on `http://0.0.0.0:3000`. Configure optional backend keys in `.env` (see `.env.example`).
