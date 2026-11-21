"""Comprehensive tests covering URL parser, formatters, API server, separate Whisper container, and MCP layer."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import uvicorn
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import Platform, TranscriptSegment
from app.services.downloader import ExtractedMedia
from app.services.formatter import to_json_export, to_plain_txt, to_srt, to_timestamped_txt, to_vtt
from app.services.transcriber import TranscriptionResult
from app.services.url_parser import parse_video_url
from mcp_server.server import handle_jsonrpc_request
from whisper_service import main as whisper_main


class TestURLParser(unittest.TestCase):
    def test_youtube_variants(self) -> None:
        urls = [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?t=42",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://m.youtube.com/live/dQw4w9WgXcQ",
        ]
        for url in urls:
            parsed = parse_video_url(url)
            self.assertEqual(parsed.platform, Platform.YOUTUBE)
            self.assertEqual(parsed.video_id, "dQw4w9WgXcQ")
            self.assertEqual(parsed.canonical_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    def test_facebook_variants(self) -> None:
        p1 = parse_video_url("https://www.facebook.com/watch/?v=10153231379946729")
        self.assertEqual(p1.platform, Platform.FACEBOOK)
        self.assertEqual(p1.video_id, "10153231379946729")

        p2 = parse_video_url("https://www.facebook.com/reel/9876543210")
        self.assertEqual(p2.platform, Platform.FACEBOOK)
        self.assertEqual(p2.video_id, "9876543210")

        p3 = parse_video_url("https://fb.watch/abcXYZ123/")
        self.assertEqual(p3.platform, Platform.FACEBOOK)
        self.assertEqual(p3.video_id, "abcXYZ123")

    def test_instagram_variants(self) -> None:
        p1 = parse_video_url("https://www.instagram.com/reel/C8example123/")
        self.assertEqual(p1.platform, Platform.INSTAGRAM)
        self.assertEqual(p1.video_id, "C8example123")

        p2 = parse_video_url("https://instagram.com/p/ABC_123xyz/")
        self.assertEqual(p2.platform, Platform.INSTAGRAM)
        self.assertEqual(p2.video_id, "ABC_123xyz")

    def test_unsupported_url_raises(self) -> None:
        with self.assertRaises(ValueError):
            parse_video_url("https://example.com/video/123")


class TestFormatters(unittest.TestCase):
    def setUp(self) -> None:
        self.segments = [
            TranscriptSegment(id=1, start=0.0, end=4.5, text="Hello world."),
            TranscriptSegment(id=2, start=65.25, end=70.0, text="Second line here."),
        ]

    def test_srt_vtt_txt_json(self) -> None:
        self.assertIn("00:00:00,000 --> 00:00:04,500", to_srt(self.segments))
        self.assertTrue(to_vtt(self.segments).startswith("WEBVTT"))
        self.assertIn("[00:00 - 00:04] Hello world.", to_timestamped_txt(self.segments))
        self.assertEqual(to_plain_txt(self.segments), "Hello world. Second line here.")
        exported = json.loads(to_json_export(self.segments, {"platform": "youtube"}))
        self.assertEqual(len(exported["segments"]), 2)


class TestWhisperContainerService(unittest.TestCase):
    def test_whisper_service_health_and_transcribe(self) -> None:
        class FakeWhisperModel:
            def transcribe(self, path, language=None, vad_filter=True, beam_size=5):
                segs = [SimpleNamespace(start=0.0, end=3.2, text="Hello from separate container.")]
                info = SimpleNamespace(language=language or "en")
                return segs, info

        client = TestClient(whisper_main.app)
        health = client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["default_model"], "base")

        with patch.object(whisper_main, "get_whisper_model", return_value=FakeWhisperModel()):
            res = client.post(
                "/transcribe",
                files={"file": ("audio.mp3", b"ID3fake", "audio/mpeg")},
                data={"model": "base", "language": "en"},
            )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["engine_used"], "faster_whisper:base")
        self.assertEqual(body["segments"][0]["text"], "Hello from separate container.")


class TestTwoContainerAndAPIAndMCP(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        tmp_path = Path(self.tmp.name)
        self.settings = Settings(
            data_dir=tmp_path,
            db_path=tmp_path / "test_jobs.db",
            temp_dir=tmp_path / "tmp",
        )
        self.app = create_app(self.settings)
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.app.state.executor.shutdown(wait=True)
        self.tmp.cleanup()

    def _wait_for_terminal(self, job_id: str, timeout: float = 10.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            res = self.client.get(f"/api/jobs/{job_id}")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            if data["status"] in {"completed", "failed"}:
                return data
            time.sleep(0.05)
        self.fail(f"Job {job_id} did not finish within {timeout}s")

    def test_health_and_demo_and_exports(self) -> None:
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["default_whisper_model"], "base")

        sub = self.client.post(
            "/api/transcribe",
            json={"url": "https://www.instagram.com/reel/C8example123/", "engine": "demo"},
        )
        self.assertEqual(sub.status_code, 202)
        done = self._wait_for_terminal(sub.json()["id"])
        self.assertEqual(done["status"], "completed")

        for fmt in ("srt", "vtt", "txt", "plain", "json"):
            exp = self.client.get(f"/api/jobs/{done['id']}/export?fmt={fmt}")
            self.assertEqual(exp.status_code, 200)
            self.assertTrue(len(exp.text) > 10)

    def test_api_to_separate_whisper_container_over_live_http(self) -> None:
        """Boot the separate whisper_service on port 8791 and test API -> Whisper HTTP forwarding."""

        class FakeWhisperModel:
            def transcribe(self, path, language=None, vad_filter=True, beam_size=5):
                segs = [SimpleNamespace(start=0.0, end=1.0, text="Transcribed via separate whisper container.")]
                info = SimpleNamespace(language="en")
                return segs, info

        sample_mp4 = Path(self.tmp.name) / "clip.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                "-t", "1", "-c:a", "aac", str(sample_mp4),
            ],
            check=True,
            capture_output=True,
        )

        config = uvicorn.Config(whisper_main.app, host="127.0.0.1", port=8791, log_level="error")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)

        with patch.object(whisper_main, "get_whisper_model", return_value=FakeWhisperModel()):
            thread.start()
            for _ in range(40):
                if server.started:
                    break
                time.sleep(0.05)

            try:
                two_container_settings = Settings(
                    data_dir=Path(self.tmp.name) / "api2",
                    db_path=Path(self.tmp.name) / "api2" / "jobs.db",
                    temp_dir=Path(self.tmp.name) / "api2" / "tmp",
                    whisper_service_url="http://127.0.0.1:8791",
                    whisper_model="base",
                )
                api2 = create_app(two_container_settings)
                c2 = TestClient(api2)
                try:
                    with sample_mp4.open("rb") as fh:
                        res = c2.post(
                            "/api/transcribe/upload",
                            files={"file": ("clip.mp4", fh, "video/mp4")},
                            data={"engine": "faster_whisper", "whisper_model": "base"},
                        )
                    self.assertEqual(res.status_code, 202)
                    jid = res.json()["id"]
                    deadline = time.time() + 10.0
                    done = None
                    while time.time() < deadline:
                        r = c2.get(f"/api/jobs/{jid}").json()
                        if r["status"] in {"completed", "failed"}:
                            done = r
                            break
                        time.sleep(0.05)
                    assert done is not None
                    self.assertEqual(done["status"], "completed", f"Failed: {done}")
                    self.assertEqual(done["engine_used"], "faster_whisper:base")
                    self.assertEqual(done["segments"][0]["text"], "Transcribed via separate whisper container.")
                finally:
                    api2.state.executor.shutdown(wait=True)
            finally:
                server.should_exit = True
                thread.join(timeout=5)

    def test_mcp_layer_initialize_list_and_call_tools(self) -> None:
        init_resp = handle_jsonrpc_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, settings=self.settings)
        assert init_resp is not None
        self.assertEqual(init_resp["result"]["serverInfo"]["name"], "clipscribe-mcp")

        list_resp = handle_jsonrpc_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, settings=self.settings)
        assert list_resp is not None
        tool_names = {t["name"] for t in list_resp["result"]["tools"]}
        self.assertEqual(tool_names, {"transcribe_link", "transcribe_media_file", "list_transcription_engines"})

        # Call list_transcription_engines
        eng_resp = handle_jsonrpc_request(
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_transcription_engines", "arguments": {}}},
            settings=self.settings,
        )
        assert eng_resp is not None
        self.assertFalse(eng_resp["result"]["isError"])

        # Call transcribe_link in demo mode (SRT output)
        link_resp = handle_jsonrpc_request(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "transcribe_link",
                    "arguments": {
                        "url": "https://youtu.be/dQw4w9WgXcQ",
                        "engine": "demo",
                        "output_format": "srt",
                    },
                },
            },
            settings=self.settings,
        )
        assert link_resp is not None
        self.assertFalse(link_resp["result"]["isError"])
        self.assertIn("00:00:00,000 -->", link_resp["result"]["content"][0]["text"])

        # Call transcribe_media_file in demo mode (JSON output)
        dummy_mp4 = Path(self.tmp.name) / "demo.mp4"
        dummy_mp4.write_bytes(b"fake")
        file_resp = handle_jsonrpc_request(
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "transcribe_media_file",
                    "arguments": {
                        "file_path": str(dummy_mp4),
                        "engine": "demo",
                        "output_format": "json",
                    },
                },
            },
            settings=self.settings,
        )
        assert file_resp is not None
        self.assertFalse(file_resp["result"]["isError"])
        parsed_json = json.loads(file_resp["result"]["content"][0]["text"])
        self.assertEqual(parsed_json["metadata"]["platform"], "local")


if __name__ == "__main__":
    unittest.main()
