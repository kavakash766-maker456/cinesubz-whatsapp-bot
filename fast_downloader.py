#!/usr/bin/env python3
"""
FilmFeed Ultra Fast Multi-Threaded Parallel Downloader
Accelerates HTTP downloads by up to 10x using parallel byte-range streams (IDM style).
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def get_file_info(url: str, headers: dict = None) -> tuple:
    """Get Content-Length and Range support via HEAD or GET range."""
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            clen = resp.headers.get("Content-Length")
            accept_ranges = resp.headers.get("Accept-Ranges", "")
            size = int(clen) if clen and clen.isdigit() else 0
            supports_range = (
                accept_ranges.lower() == "bytes"
                or size > 5 * 1024 * 1024
            )
            return size, supports_range
    except Exception:
        # Try range 0-1
        try:
            h["Range"] = "bytes=0-1"
            req2 = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req2, timeout=20) as resp:
                cr = resp.headers.get("Content-Range", "")
                if "/" in cr:
                    total = cr.split("/")[-1]
                    if total.isdigit():
                        return int(total), True
        except Exception:
            pass
    return 0, False


def download_chunk(url: str, dest_path: str, start: int, end: int, part_num: int, progress_dict: dict) -> bool:
    headers = {
        "User-Agent": UA,
        "Range": f"bytes={start}-{end}",
    }
    req = urllib.request.Request(url, headers=headers)
    part_file = f"{dest_path}.part{part_num}"
    
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                with open(part_file, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 1024) # 1MB buffer
                        if not chunk:
                            break
                        f.write(chunk)
                        progress_dict[part_num] = progress_dict.get(part_num, 0) + len(chunk)
            return True
        except Exception:
            time.sleep(1)
            progress_dict[part_num] = 0
    return False


def parallel_download(url: str, dest_path: str, num_threads: int = 8) -> bool:
    size, supports_range = get_file_info(url)
    
    # If file size is smaller than 10MB or range not supported, do high-speed single stream
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

        # Monitor progress while downloading
        while not all(f.done() for f in futures):
            downloaded = sum(progress_dict.values())
            percent = round((downloaded / size) * 100, 1) if size > 0 else 0
            elapsed = time.time() - start_time
            speed_mb = round((downloaded / (1024 * 1024)) / max(elapsed, 0.1), 2)
            
            # Output structured JSON line for node index.js to parse
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
        # Clean up parts and fallback to stream
        for pf in part_files:
            if os.path.exists(pf):
                try:
                    os.remove(pf)
                except Exception:
                    pass
        return stream_download(url, dest_path, size)

    # Combine parts into final destination
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
            "elapsed_seconds": round(time.time() - start_time, 2)
        }) + "\n"
    )
    sys.stdout.flush()
    return True


def stream_download(url: str, dest_path: str, total_size: int = 0) -> bool:
    headers = {"User-Agent": UA}
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
                chunk = resp.read(2 * 1024 * 1024) # 2MB buffer
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
            "elapsed_seconds": round(time.time() - start_time, 2)
        }) + "\n"
    )
    sys.stdout.flush()
    return True


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: fast_downloader.py <url> <dest_path> [threads]"}))
        sys.exit(1)
        
    url = sys.argv[1]
    dest = sys.argv[2]
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    success = parallel_download(url, dest, threads)
    sys.exit(0 if success else 1)
