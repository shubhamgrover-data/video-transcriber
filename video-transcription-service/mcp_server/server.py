"""MCP server exposing ClipScribe's reusable link-to-transcript and file-to-transcript utilities.

Works with any MCP-compatible client (Claude Desktop, Cursor, Gemini CLI, etc.) over stdio.
Uses the official `mcp` Python SDK when installed, and includes a built-in JSON-RPC 2.0 stdio
handler so the server and its tool dispatch layer remain testable and runnable anywhere.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, List, Optional

from app.config import Settings, get_settings
from app.models import ALLOWED_WHISPER_MODELS, TranscriptionEngine
from app.services.pipeline import transcribe_file, transcribe_url
from app.services.transcriber import detect_available_engines

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "clipscribe-mcp", "version": "1.0.0"}

TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "name": "transcribe_link",
        "description": (
            "Transcribe a YouTube, Facebook, or Instagram video link with timestamps. "
            "Preprocesses audio and routes to the separate faster-whisper container (base by default) "
            "or Groq Whisper Large API based on the chosen engine."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "YouTube, Facebook, or Instagram video URL.",
                },
                "engine": {
                    "type": "string",
                    "enum": ["auto", "faster_whisper", "groq", "openai", "demo"],
                    "default": "auto",
                    "description": "Transcription backend: separate faster-whisper container, Groq API, OpenAI API, auto, or demo.",
                },
                "language": {
                    "type": "string",
                    "description": "Optional ISO-639-1 language code (e.g. 'en', 'hi'). Omit for auto-detect.",
                },
                "whisper_model": {
                    "type": "string",
                    "enum": list(ALLOWED_WHISPER_MODELS),
                    "description": "Whisper model size for the separate faster-whisper container (default: base).",
                },
                "output_format": {
                    "type": "string",
                    "enum": ["json", "srt", "vtt", "txt", "plain"],
                    "default": "json",
                    "description": "Desired transcript output format.",
                },
                "prefer_captions": {
                    "type": "boolean",
                    "default": True,
                    "description": "For YouTube links, use native captions fast-path when available.",
                },
            },
            "required": ["url"],
        },
    },
    {
        "name": "transcribe_media_file",
        "description": (
            "Transcribe a local video or audio file (MP4, MOV, MKV, MP3, WAV, M4A, etc.) with timestamps. "
            "Extracts 16kHz mono audio with ffmpeg and routes to the separate faster-whisper container or Groq Whisper Large API."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the local video or audio file to transcribe.",
                },
                "engine": {
                    "type": "string",
                    "enum": ["auto", "faster_whisper", "groq", "openai", "demo"],
                    "default": "auto",
                    "description": "Transcription backend: separate faster-whisper container, Groq API, OpenAI API, auto, or demo.",
                },
                "language": {
                    "type": "string",
                    "description": "Optional ISO-639-1 language code (e.g. 'en', 'hi'). Omit for auto-detect.",
                },
                "whisper_model": {
                    "type": "string",
                    "enum": list(ALLOWED_WHISPER_MODELS),
                    "description": "Whisper model size for the separate faster-whisper container (default: base).",
                },
                "output_format": {
                    "type": "string",
                    "enum": ["json", "srt", "vtt", "txt", "plain"],
                    "default": "json",
                    "description": "Desired transcript output format.",
                },
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "list_transcription_engines",
        "description": "Check which transcription backends (separate faster-whisper container, Groq API, OpenAI API) are currently configured.",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
]


def call_mcp_tool(
    name: str,
    arguments: Optional[Dict[str, Any]] = None,
    *,
    settings: Optional[Settings] = None,
) -> str:
    """Execute an MCP tool by delegating directly to ClipScribe's reusable core utilities."""
    args = arguments or {}
    cfg = settings or get_settings()

    if name == "list_transcription_engines":
        return json.dumps(
            {
                "default_engine": cfg.default_engine,
                "whisper_service_url": cfg.whisper_service_url or None,
                "default_whisper_model": cfg.whisper_model,
                "groq_model": cfg.groq_model,
                "available_engines": detect_available_engines(cfg),
            },
            indent=2,
        )

    if name == "transcribe_link":
        url = str(args.get("url", "")).strip()
        if not url:
            raise ValueError("Missing required argument: 'url'.")
        engine = TranscriptionEngine(str(args.get("engine", "auto")))
        output = transcribe_url(
            url,
            engine=engine,
            language=args.get("language") or None,
            whisper_model=args.get("whisper_model") or None,
            prefer_captions=bool(args.get("prefer_captions", True)),
            settings=cfg,
        )
        return output.format_as(str(args.get("output_format", "json")))

    if name == "transcribe_media_file":
        file_path = str(args.get("file_path", "")).strip()
        if not file_path:
            raise ValueError("Missing required argument: 'file_path'.")
        engine = TranscriptionEngine(str(args.get("engine", "auto")))
        output = transcribe_file(
            file_path,
            engine=engine,
            language=args.get("language") or None,
            whisper_model=args.get("whisper_model") or None,
            settings=cfg,
        )
        return output.format_as(str(args.get("output_format", "json")))

    raise ValueError(f"Unknown MCP tool: {name}")


def handle_jsonrpc_request(
    request: Dict[str, Any],
    *,
    settings: Optional[Settings] = None,
) -> Optional[Dict[str, Any]]:
    """Process a single MCP JSON-RPC 2.0 request object."""
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params") or {}

    if method == "notifications/initialized":
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"tools": TOOL_DEFINITIONS},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments") or {}
        try:
            text_result = call_mcp_tool(tool_name, tool_args, settings=settings)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": text_result}],
                    "isError": False,
                },
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def run_stdio_server() -> None:
    """Run the MCP server over stdin/stdout (newline-delimited JSON-RPC 2.0)."""
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            err = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {exc}"},
            }
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()
            continue

        resp = handle_jsonrpc_request(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    run_stdio_server()
