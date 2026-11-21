"""URL validation, platform detection, and canonicalization for YouTube, Facebook, and Instagram."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, urlparse

from app.models import Platform


@dataclass(frozen=True)
class ParsedVideoURL:
    platform: Platform
    original_url: str
    canonical_url: str
    video_id: Optional[str]


YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}

FACEBOOK_HOSTS = {
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "web.facebook.com",
    "fb.watch",
    "www.fb.watch",
}

INSTAGRAM_HOSTS = {
    "instagram.com",
    "www.instagram.com",
    "m.instagram.com",
    "instagr.am",
}

_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def parse_video_url(raw_url: str) -> ParsedVideoURL:
    """Validate and parse a YouTube, Facebook, or Instagram video URL."""
    url = raw_url.strip()
    if not url:
        raise ValueError("Please provide a video URL.")

    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = f"https://{url}"

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Invalid URL format.")

    if host in YOUTUBE_HOSTS:
        return _parse_youtube(url, parsed, host)
    if host in FACEBOOK_HOSTS:
        return _parse_facebook(url, parsed, host)
    if host in INSTAGRAM_HOSTS:
        return _parse_instagram(url, parsed)

    raise ValueError(
        "Unsupported URL. Supported platforms are YouTube (youtube.com, youtu.be), "
        "Facebook (facebook.com, fb.watch), and Instagram (instagram.com)."
    )


def _parse_youtube(url: str, parsed, host: str) -> ParsedVideoURL:
    video_id: Optional[str] = None
    path_parts = [p for p in parsed.path.split("/") if p]

    if "youtu.be" in host:
        if path_parts:
            video_id = path_parts[0]
    else:
        qs = parse_qs(parsed.query)
        if "v" in qs and qs["v"]:
            video_id = qs["v"][0]
        elif len(path_parts) >= 2 and path_parts[0] in {"shorts", "embed", "live", "v"}:
            video_id = path_parts[1]

    if not video_id or not _YT_ID_RE.match(video_id):
        raise ValueError("Could not extract a valid 11-character YouTube video ID from this URL.")

    canonical = f"https://www.youtube.com/watch?v={video_id}"
    return ParsedVideoURL(
        platform=Platform.YOUTUBE,
        original_url=url,
        canonical_url=canonical,
        video_id=video_id,
    )


def _parse_facebook(url: str, parsed, host: str) -> ParsedVideoURL:
    path_parts = [p for p in parsed.path.split("/") if p]
    qs = parse_qs(parsed.query)
    video_id: Optional[str] = None

    if "fb.watch" in host:
        if not path_parts:
            raise ValueError("Invalid fb.watch short link.")
        video_id = path_parts[0]
        canonical = f"https://fb.watch/{video_id}/"
    else:
        if "v" in qs and qs["v"]:
            video_id = qs["v"][0]
            canonical = f"https://www.facebook.com/watch/?v={video_id}"
        elif "reel" in path_parts:
            idx = path_parts.index("reel")
            if idx + 1 < len(path_parts):
                video_id = path_parts[idx + 1]
                canonical = f"https://www.facebook.com/reel/{video_id}"
            else:
                raise ValueError("Invalid Facebook Reel URL.")
        elif "videos" in path_parts:
            idx = path_parts.index("videos")
            if idx + 1 < len(path_parts):
                video_id = path_parts[idx + 1]
            canonical = f"https://www.facebook.com{parsed.path}"
        elif "share" in path_parts and len(path_parts) >= 3:
            video_id = path_parts[2]
            canonical = f"https://www.facebook.com{parsed.path}"
        else:
            raise ValueError(
                "Please provide a direct Facebook video, Watch, or Reel URL "
                "(e.g. facebook.com/watch/?v=..., facebook.com/reel/..., or fb.watch/...)."
            )

    return ParsedVideoURL(
        platform=Platform.FACEBOOK,
        original_url=url,
        canonical_url=canonical,
        video_id=video_id,
    )


def _parse_instagram(url: str, parsed) -> ParsedVideoURL:
    path_parts = [p for p in parsed.path.split("/") if p]
    # Supports /reel/<id>/, /reels/<id>/, /p/<id>/, /tv/<id>/
    if len(path_parts) >= 2 and path_parts[0] in {"reel", "reels", "p", "tv"}:
        kind = "reel" if path_parts[0] in {"reel", "reels"} else path_parts[0]
        shortcode = path_parts[1]
        canonical = f"https://www.instagram.com/{kind}/{shortcode}/"
        return ParsedVideoURL(
            platform=Platform.INSTAGRAM,
            original_url=url,
            canonical_url=canonical,
            video_id=shortcode,
        )

    raise ValueError(
        "Please provide a direct Instagram Reel, Post, or TV URL "
        "(e.g. instagram.com/reel/... or instagram.com/p/...)."
    )
