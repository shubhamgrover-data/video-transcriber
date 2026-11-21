import type { Platform } from "../models.ts";

export interface ParsedVideoURL {
  platform: Platform;
  originalUrl: string;
  canonicalUrl: string;
  videoId: string | null;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "fb.watch",
  "www.fb.watch",
]);

const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
]);

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseVideoUrl(rawUrl: string): ParsedVideoURL {
  let url = (rawUrl || "").trim();
  if (!url) {
    throw new Error("Please provide a video URL.");
  }

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error("Invalid URL format.");
  }

  if (YOUTUBE_HOSTS.has(host)) {
    return parseYoutube(url, parsed, host);
  }
  if (FACEBOOK_HOSTS.has(host)) {
    return parseFacebook(url, parsed, host);
  }
  if (INSTAGRAM_HOSTS.has(host)) {
    return parseInstagram(url, parsed);
  }

  throw new Error(
    "Unsupported URL. Supported platforms are YouTube (youtube.com, youtu.be), " +
      "Facebook (facebook.com, fb.watch), and Instagram (instagram.com).",
  );
}

function parseYoutube(url: string, parsed: URL, host: string): ParsedVideoURL {
  let videoId: string | null = null;
  const pathParts = parsed.pathname.split("/").filter(Boolean);

  if (host.includes("youtu.be")) {
    if (pathParts.length > 0) {
      videoId = pathParts[0];
    }
  } else {
    const vParam = parsed.searchParams.get("v");
    if (vParam) {
      videoId = vParam;
    } else if (
      pathParts.length >= 2 &&
      ["shorts", "embed", "live", "v"].includes(pathParts[0])
    ) {
      videoId = pathParts[1];
    }
  }

  if (!videoId || !YT_ID_RE.test(videoId)) {
    throw new Error(
      "Could not extract a valid 11-character YouTube video ID from this URL.",
    );
  }

  return {
    platform: "youtube",
    originalUrl: url,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

function parseFacebook(url: string, parsed: URL, host: string): ParsedVideoURL {
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;
  let canonical: string;

  if (host.includes("fb.watch")) {
    if (pathParts.length === 0) {
      throw new Error("Invalid fb.watch short link.");
    }
    videoId = pathParts[0];
    canonical = `https://fb.watch/${videoId}/`;
  } else {
    const vParam = parsed.searchParams.get("v");
    if (vParam) {
      videoId = vParam;
      canonical = `https://www.facebook.com/watch/?v=${videoId}`;
    } else if (pathParts.includes("reel")) {
      const idx = pathParts.indexOf("reel");
      if (idx + 1 < pathParts.length) {
        videoId = pathParts[idx + 1];
        canonical = `https://www.facebook.com/reel/${videoId}`;
      } else {
        throw new Error("Invalid Facebook Reel URL.");
      }
    } else if (pathParts.includes("videos")) {
      const idx = pathParts.indexOf("videos");
      if (idx + 1 < pathParts.length) {
        videoId = pathParts[idx + 1];
      }
      canonical = `https://www.facebook.com${parsed.pathname}`;
    } else if (pathParts.includes("share") && pathParts.length >= 3) {
      videoId = pathParts[2];
      canonical = `https://www.facebook.com${parsed.pathname}`;
    } else {
      throw new Error(
        "Please provide a direct Facebook video, Watch, or Reel URL " +
          "(e.g. facebook.com/watch/?v=..., facebook.com/reel/..., or fb.watch/...).",
      );
    }
  }

  return {
    platform: "facebook",
    originalUrl: url,
    canonicalUrl: canonical,
    videoId,
  };
}

function parseInstagram(url: string, parsed: URL): ParsedVideoURL {
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (
    pathParts.length >= 2 &&
    ["reel", "reels", "p", "tv"].includes(pathParts[0])
  ) {
    const kind =
      pathParts[0] === "reel" || pathParts[0] === "reels"
        ? "reel"
        : pathParts[0];
    const shortcode = pathParts[1];
    return {
      platform: "instagram",
      originalUrl: url,
      canonicalUrl: `https://www.instagram.com/${kind}/${shortcode}/`,
      videoId: shortcode,
    };
  }

  throw new Error(
    "Please provide a direct Instagram Reel, Post, or TV URL " +
      "(e.g. instagram.com/reel/... or instagram.com/p/...).",
  );
}
