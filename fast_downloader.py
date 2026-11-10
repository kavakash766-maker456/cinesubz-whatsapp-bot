#!/usr/bin/env python3
"""
FilmFeed Ultra Fast Multi-Threaded Parallel Downloader (8x Stream)
Accelerates HTTP downloads by up to 10x using parallel byte-range streams (IDM style).
Supports presigned AWS SigV4 / Cloudflare R2 and Pixeldrain CDNs.
"""

import json
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Force IPv4 socket resolution to prevent broken IPv6 timeouts on cloud runners
try:
    _orig_getaddrinfo = socket.getaddrinfo
    def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _ipv4_getaddrinfo
except Exception:
    pass

socket.setdefaulttimeout(45)

# Configure stdout and stderr for UTF-8 line-buffered output
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def normalize_media_url(url: str) -> str:
    """Normalize upstream media URLs."""
    if not url:
        return ""
    m_px = re.search(r"pixeldrain\.com/(?:u|api/file)/([a-zA-Z0-9_-]+)", url)
    if m_px:
        return f"https://pixeldrain.com/api/file/{m_px.group(1)}?download"
    return url


def get_headers(url: str, referer: str = None) -> dict:
    h = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Connection": "keep-alive",
        "Accept-Encoding": "identity",
    }
    if referer:
        h["Referer"] = referer
    elif "pixeldrain.com" in url:
        h["Referer"] = "https://pixeldrain.com/"
    elif "animegg.org" in url:
        h["Referer"] = "https://www.animegg.org/"
    return h


def get_file_info(url: str, headers: dict = None) -> tuple:
    """Get Content-Length and Range support via GET 0-1 range probe."""
    url = normalize_media_url(url)
    h = get_headers(url)
    if headers:
        h.update(headers)
    h["Range"] = "bytes=0-1"

    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=15) as resp:
            cr = resp.headers.get("Content-Range", "")
            if cr and "/" in cr:
                total_str = cr.split("/")[-1].strip()
                if total_str.isdigit():
                    return int(total_str), True
            clen = resp.headers.get("Content-Length")
            if clen and clen.isdigit():
                return int(clen), False
    except Exception:
        pass

    # Fallback probe without Range
    try:
        h_no_range = dict(h)
        del h_no_range["Range"]
        req2 = urllib.request.Request(url, headers=h_no_range)
        with urllib.request.urlopen(req2, timeout=15) as resp2:
            clen = resp2.headers.get("Content-Length")
            accept_ranges = resp2.headers.get("Accept-Ranges", "").lower()
            if clen and clen.isdigit():
                return int(clen), "bytes" in accept_ranges or int(clen) > 10 * 1024 * 1024
    except Exception:
        pass

    return 0, False


def download_chunk(url: str, dest_path: str, start: int, end: int, part_num: int, progress_dict: dict) -> bool:
    headers = get_headers(url)
    headers["Range"] = f"bytes={start}-{end}"
    expected_bytes = end - start + 1
    part_file = f"{dest_path}.part{part_num}"

    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=50) as resp:
                with open(part_file, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 1024)  # 1MB fast buffer
                        if not chunk:
                            break
                        f.write(chunk)
                        progress_dict[part_num] = progress_dict.get(part_num, 0) + len(chunk)
            
            if os.path.exists(part_file) and os.path.getsize(part_file) >= expected_bytes * 0.99:
                return True
        except Exception as e:
            sys.stderr.write(f"[part{part_num}] attempt {attempt} retry: {e}\n")
            sys.stderr.flush()
            progress_dict[part_num] = 0
            time.sleep(1.0)

    return False


def parallel_download(url: str, dest_path: str, num_threads: int = 8) -> bool:
    url = normalize_media_url(url)
    # AnimeGG Express CDN requires direct single-stream GET with Referer (Range probing drops socket)
    if "animegg.org" in url:
        return stream_download(url, dest_path, 0)

    num_threads = min(max(num_threads, 1), 8)
    size, supports_range = get_file_info(url)

    # If file size is smaller than 10MB or range not supported, use single stream
    if size < 10 * 1024 * 1024 or not supports_range:
        return stream_download(url, dest_path, size)

    chunk_size = size // num_threads
    ranges = []
    for i in range(num_threads):
        start = i * chunk_size
        end = size - 1 if i == num_threads - 1 else (i + 1) * chunk_size - 1
        ranges.append((start, end, i))

    progress_dict = {i: 0 for i in range(num_threads)}
    start_time = time.time()
    part_files = [f"{dest_path}.part{i}" for i in range(num_threads)]

    with ThreadPoolExecutor(max_workers=num_threads) as executor:
        futures = [
            executor.submit(download_chunk, url, dest_path, r[0], r[1], r[2], progress_dict)
            for r in ranges
        ]

        while not all(f.done() for f in futures):
            downloaded = sum(progress_dict.values())
            percent = round((downloaded / size) * 100, 1) if size > 0 else 0
            elapsed = max(time.time() - start_time, 0.1)
            speed_mb = round((downloaded / (1024 * 1024)) / elapsed, 2)

            sys.stdout.write(
                json.dumps({
                    "type": "progress",
                    "downloaded": downloaded,
                    "total": size,
                    "percent": percent,
                    "speed_mb": speed_mb,
                }) + "\n"
            )
            sys.stdout.flush()
            time.sleep(1.0)

        results = [f.result() for f in futures]

    if not all(results):
        # Clean up parts and fallback to single stream
        for pf in part_files:
            if os.path.exists(pf):
                try:
                    os.remove(pf)
                except Exception:
                    pass
        sys.stderr.write("[parallel] some chunks failed, falling back to stream_download\n")
        sys.stderr.flush()
        return stream_download(url, dest_path, size)

    # Combine parts into final file
    with open(dest_path, "wb") as outfile:
        for pf in part_files:
            if os.path.exists(pf):
                with open(pf, "rb") as infile:
                    while True:
                        b = infile.read(4 * 1024 * 1024)
                        if not b:
                            break
                        outfile.write(b)
                try:
                    os.remove(pf)
                except Exception:
                    pass

    final_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    sys.stdout.write(
        json.dumps({
            "type": "complete",
            "success": True,
            "size": final_size,
            "elapsed_seconds": round(time.time() - start_time, 2),
        }) + "\n"
    )
    sys.stdout.flush()
    return True


def stream_download(url: str, dest_path: str, total_size: int = 0) -> bool:
    url = normalize_media_url(url)
    headers = get_headers(url)
    req = urllib.request.Request(url, headers=headers)
    start_time = time.time()
    downloaded = 0

    with urllib.request.urlopen(req, timeout=60) as resp:
        if total_size <= 0:
            clen = resp.headers.get("Content-Length")
            total_size = int(clen) if clen and clen.isdigit() else 0

        with open(dest_path, "wb") as f:
            last_report = time.time()
            while True:
                chunk = resp.read(2 * 1024 * 1024)  # 2MB stream buffer
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)

                now = time.time()
                if now - last_report >= 1.0:
                    last_report = now
                    percent = round((downloaded / total_size) * 100, 1) if total_size > 0 else 0
                    speed_mb = round((downloaded / (1024 * 1024)) / max(now - start_time, 0.1), 2)
                    sys.stdout.write(
                        json.dumps({
                            "type": "progress",
                            "downloaded": downloaded,
                            "total": total_size,
                            "percent": percent,
                            "speed_mb": speed_mb,
                        }) + "\n"
                    )
                    sys.stdout.flush()

    final_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    sys.stdout.write(
        json.dumps({
            "type": "complete",
            "success": True,
            "size": final_size,
            "elapsed_seconds": round(time.time() - start_time, 2),
        }) + "\n"
    )
    sys.stdout.flush()
    return True


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: fast_downloader.py <url> <dest_path> [threads]"}))
        sys.exit(1)

    media_url = sys.argv[1]
    destination = sys.argv[2]
    num_workers = int(sys.argv[3]) if len(sys.argv) > 3 else 8

    os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
    ok = parallel_download(media_url, destination, num_workers)
    sys.exit(0 if ok else 1)
