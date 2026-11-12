#!/usr/bin/env python3
"""
Adult Video Resolver for FilmFeed VIP Vault
Extracts metadata, direct MP4 streams, and downloads videos via yt-dlp.
"""

import sys
import json
import argparse
import subprocess
import os

def resolve_adult_video(url, requested_quality="720p", download_path=None):
    try:
        import yt_dlp
    except ImportError:
        return {"success": False, "error": "yt-dlp is not installed"}

    # Target format selection based on requested quality
    height_map = {
        "1080p": 1080,
        "720p": 720,
        "480p": 480,
        "360p": 360
    }
    max_height = height_map.get(requested_quality, 720)

    # yt-dlp format string: best video under or equal to requested height + best audio
    format_spec = f"bestvideo[height<={max_height}]+bestaudio/best[height<={max_height}]/best"

    ydl_opts = {
        "format": format_spec,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    }

    if download_path:
        ydl_opts["outtmpl"] = download_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=bool(download_path))
            if not info:
                return {"success": False, "error": "Failed to extract video information"}

            # Pick best available direct format URL
            stream_url = info.get("url")
            selected_height = info.get("height") or max_height

            formats = info.get("formats", [])
            if not stream_url and formats:
                # Find matching or highest quality format with direct URL
                matching = [f for f in formats if f.get("url") and (f.get("height") or 0) <= max_height]
                if matching:
                    best_f = matching[-1]
                    stream_url = best_f.get("url")
                    selected_height = best_f.get("height", max_height)
                else:
                    stream_url = formats[-1].get("url")

            # Format duration as mm:ss or hh:mm:ss
            duration_sec = info.get("duration") or 0
            if duration_sec >= 3600:
                h = duration_sec // 3600
                m = (duration_sec % 3600) // 60
                s = duration_sec % 60
                dur_str = f"{h:02d}:{m:02d}:{s:02d}"
            else:
                m = duration_sec // 60
                s = duration_sec % 60
                dur_str = f"{m:02d}:{s:02d}"

            thumbnail = info.get("thumbnail") or ""
            if not thumbnail and info.get("thumbnails"):
                thumbnail = info["thumbnails"][-1].get("url", "")

            result = {
                "success": True,
                "id": info.get("id"),
                "title": info.get("title") or "VIP 18+ Exclusive Video",
                "duration": duration_sec,
                "duration_formatted": dur_str,
                "views": info.get("view_count") or 0,
                "thumbnail": thumbnail,
                "direct_url": stream_url,
                "quality": f"{selected_height}p" if selected_height else requested_quality,
                "is_adult": True,
                "webpage_url": info.get("webpage_url") or url
            }

            if download_path and os.path.exists(download_path):
                result["downloaded_file"] = download_path
                result["file_size"] = os.path.getsize(download_path)

            return result

    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="FilmFeed VIP Adult Video Resolver")
    parser.add_argument("url", help="Adult video page URL (xHamster, etc.)")
    parser.add_argument("--quality", default="720p", help="Target resolution: 1080p, 720p, 480p (default: 720p)")
    parser.add_argument("--download", help="File destination path to download video to")

    args = parser.parse_args()

    res = resolve_adult_video(args.url, requested_quality=args.quality, download_path=args.download)
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()
