#!/usr/bin/env python3
"""
FilmFeed SSS-Grade Ultra Fast Multi-Threaded Parallel Downloader
Accelerates HTTP downloads using parallel byte-range streams with intra-chunk resume (.meta.json),
exponential backoff with decorrelated jitter, strict SigV4/Cloudflare R2 header compliance,
and machine-readable JSON IPC output to stdout.
"""

import argparse
import atexit
import base64
import json
import os
import random
import re
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# Force IPv4 socket resolution to prevent broken IPv6 timeouts on GitHub Actions and cloud runners
try:
    _orig_getaddrinfo = socket.getaddrinfo
    def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _ipv4_getaddrinfo
except Exception:
    pass

# Set socket timeout default to 30 seconds
socket.setdefaulttimeout(30)

# Configure stdout and stderr for UTF-8 encoding
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Global tracking for cleanup
_ACTIVE_DOWNLOADS = {}
_CLEANUP_LOCK = threading.Lock()


def emit_ipc(event_type: str, **kwargs):
    """Emit a machine-readable JSON line to stdout."""
    payload = {"type": event_type, **kwargs}
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def normalize_media_url(url: str) -> str:
    """Normalize known upstream media provider URLs."""
    if not url:
        return ""
    # Pixeldrain web preview /u/{id} -> direct API /api/file/{id}?download
    m_px = re.search(r"pixeldrain\.com/u/([a-zA-Z0-9_-]+)", url)
    if m_px:
        return f"https://pixeldrain.com/api/file/{m_px.group(1)}?download"
    return url


def get_provider_headers(url: str, referer: str = None, user_agent: str = None) -> dict:
    """
    Construct strictly compliant HTTP headers for media hosts.
    Always includes 'Accept-Encoding: identity' to prevent Cloudflare edge
    compression timeouts and AWS SigV4 signature mismatches.
    """
    headers = {
        "User-Agent": user_agent or DEFAULT_UA,
        "Accept-Encoding": "identity",
        "Accept": "*/*",
        "Connection": "keep-alive",
    }

    parsed = urllib.parse.urlsplit(url)

    if referer:
        headers["Referer"] = referer
    elif "pixeldrain.com" in url:
        headers["Referer"] = "https://pixeldrain.com/"
    elif "playsza" in url or "csplayer" in url:
        headers["Referer"] = f"{parsed.scheme}://{parsed.netloc}/"
        headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"

    # Pixeldrain API Key Authentication (Basic auth)
    if "pixeldrain.com" in url:
        api_key = os.environ.get("PIXELDRAIN_API_KEY", "").strip()
        if api_key:
            auth_token = base64.b64encode(f":{api_key}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {auth_token}"

    return headers


def get_file_info(url: str, headers: dict = None) -> tuple:
    """
    Determine Content-Length and Range support using HTTP GET Range probe (Range: bytes=0-1024).
    NEVER uses HTTP HEAD on media URLs because presigned SigV4 R2/S3 URLs strictly reject HEAD with 403.
    Returns: (total_size: int, supports_range: bool)
    """
    url = normalize_media_url(url)
    h = get_provider_headers(url)
    if headers:
        h.update(headers)

    # 1. Primary probe: HTTP GET with Range: bytes=0-1024
    h_probe = dict(h)
    h_probe["Range"] = "bytes=0-1024"

    try:
        req = urllib.request.Request(url, headers=h_probe, method="GET")
        with urllib.request.urlopen(req, timeout=15) as resp:
            ctype = resp.headers.get("Content-Type", "").lower()
            if "text/html" in ctype and "application/" not in ctype:
                raise RuntimeError(f"Server returned an HTML page ({ctype}) instead of media stream.")

            # HTTP 206 Partial Content -> Range is supported!
            cr = resp.headers.get("Content-Range", "")
            if cr and "/" in cr:
                total_str = cr.split("/")[-1].strip()
                if total_str.isdigit():
                    return int(total_str), True

            # Server returned HTTP 200 (ignored Range header)
            clen = resp.headers.get("Content-Length")
            if clen and clen.isdigit():
                return int(clen), False

    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404, 410):
            # Fatal HTTP status from upstream
            raise RuntimeError(f"HTTP {e.code} ({e.reason}) accessing media URL.")
        # If server rejects 0-1024 range with 416 (Range Not Satisfiable), file might be <= 1024 bytes
        if e.code == 416:
            cr = e.headers.get("Content-Range", "")
            if cr and "/" in cr:
                total_str = cr.split("/")[-1].strip()
                if total_str.isdigit():
                    return int(total_str), True
    except Exception as e:
        if "HTML page" in str(e):
            raise

    # 2. Secondary fallback probe: HTTP GET with Range: bytes=0-1
    try:
        h_probe_small = dict(h)
        h_probe_small["Range"] = "bytes=0-1"
        req = urllib.request.Request(url, headers=h_probe_small, method="GET")
        with urllib.request.urlopen(req, timeout=12) as resp:
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

    # 3. Third fallback probe: Stream GET 1KB to inspect Content-Length without HEAD
    try:
        h_stream = dict(h)
        if "Range" in h_stream:
            del h_stream["Range"]
        req = urllib.request.Request(url, headers=h_stream, method="GET")
        with urllib.request.urlopen(req, timeout=12) as resp:
            ctype = resp.headers.get("Content-Type", "").lower()
            if "text/html" in ctype:
                raise RuntimeError(f"Server returned an HTML page ({ctype}) instead of media stream.")
            clen = resp.headers.get("Content-Length")
            accept_ranges = resp.headers.get("Accept-Ranges", "").lower()
            supports_range = "bytes" in accept_ranges
            if clen and clen.isdigit():
                return int(clen), supports_range
    except Exception:
        pass

    return 0, False


def load_or_init_meta(dest_path: str, url: str, total_size: int, num_parts: int) -> dict:
    """Load existing chunk metadata or initialize a new resume manifest."""
    meta_path = f"{dest_path}.meta.json"
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            base_url = url.split("?")[0]
            meta_base_url = (meta.get("url") or "").split("?")[0]
            if (
                (meta.get("url") == url or meta_base_url == base_url)
                and meta.get("total_size") == total_size
                and len(meta.get("parts", [])) == num_parts
            ):
                meta["url"] = url  # Update to freshest presigned signature token
                return meta
        except Exception:
            pass

    # Initialize new chunk partition
    chunk_size = total_size // num_parts
    parts = []
    for i in range(num_parts):
        start = i * chunk_size
        end = total_size - 1 if i == num_parts - 1 else (i + 1) * chunk_size - 1
        expected = end - start + 1
        parts.append({
            "part_num": i,
            "start": start,
            "end": end,
            "expected_size": expected,
            "done": False,
        })

    meta = {
        "url": url,
        "total_size": total_size,
        "num_parts": num_parts,
        "parts": parts,
    }
    save_meta(dest_path, meta)
    return meta


def save_meta(dest_path: str, meta: dict):
    """Atomically write download state to {dest_path}.meta.json."""
    meta_path = f"{dest_path}.meta.json"
    temp_meta = f"{meta_path}.tmp"
    try:
        with open(temp_meta, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        if os.path.exists(meta_path):
            os.remove(meta_path)
        os.rename(temp_meta, meta_path)
    except Exception:
        if os.path.exists(temp_meta):
            try:
                os.remove(temp_meta)
            except Exception:
                pass


def cleanup_artifacts(dest_path: str, num_parts: int, remove_completed: bool = False):
    """Scavenge .part* and .meta.json files on completion or unrecoverable error."""
    with _CLEANUP_LOCK:
        meta_path = f"{dest_path}.meta.json"
        if os.path.exists(meta_path):
            try:
                os.remove(meta_path)
            except Exception:
                pass

        for i in range(num_parts + 4):
            part_file = f"{dest_path}.part{i}"
            if os.path.exists(part_file):
                try:
                    os.remove(part_file)
                except Exception:
                    pass

        if remove_completed and os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception:
                pass


def download_chunk(
    url: str,
    dest_path: str,
    part_info: dict,
    progress_dict: dict,
    meta_dict: dict,
    meta_lock: threading.Lock,
    stop_event: threading.Event,
    referer: str = None,
    user_agent: str = None,
    max_retries: int = 5,
) -> bool:
    """
    Download a single byte-range chunk with intra-chunk resumption via file seek/append
    and exponential backoff with decorrelated jitter.
    """
    part_num = part_info["part_num"]
    part_start = part_info["start"]
    part_end = part_info["end"]
    expected_size = part_info["expected_size"]
    part_file = f"{dest_path}.part{part_num}"

    # Check if part was already fully downloaded
    existing_bytes = os.path.getsize(part_file) if os.path.exists(part_file) else 0
    if existing_bytes >= expected_size:
        progress_dict[part_num] = expected_size
        with meta_lock:
            part_info["done"] = True
            save_meta(dest_path, meta_dict)
        return True

    for attempt in range(1, max_retries + 1):
        if stop_event.is_set():
            return False

        existing_bytes = os.path.getsize(part_file) if os.path.exists(part_file) else 0
        if existing_bytes >= expected_size:
            progress_dict[part_num] = expected_size
            with meta_lock:
                part_info["done"] = True
                save_meta(dest_path, meta_dict)
            return True

        current_start = part_start + existing_bytes
        headers = get_provider_headers(url, referer=referer, user_agent=user_agent)
        headers["Range"] = f"bytes={current_start}-{part_end}"

        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=35) as resp:
                mode = "ab" if existing_bytes > 0 else "wb"
                with open(part_file, mode) as f:
                    while not stop_event.is_set():
                        chunk = resp.read(256 * 1024)  # 256KB buffer
                        if not chunk:
                            break
                        f.write(chunk)
                        existing_bytes += len(chunk)
                        progress_dict[part_num] = existing_bytes
                        if existing_bytes % (2 * 1024 * 1024) < 256 * 1024:
                            try:
                                f.flush()
                            except Exception:
                                pass
                    try:
                        f.flush()
                    except Exception:
                        pass

            if existing_bytes >= expected_size:
                progress_dict[part_num] = expected_size
                with meta_lock:
                    part_info["done"] = True
                    save_meta(dest_path, meta_dict)
                return True

        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404, 410):
                stop_event.set()
                emit_ipc("error", message=f"HTTP {e.code} ({e.reason}) on chunk {part_num}", code=e.code)
                return False
            # Transient error, apply jittered backoff
        except Exception:
            pass

        if attempt < max_retries and not stop_event.is_set():
            # Exponential backoff with decorrelated jitter
            sleep_sec = min(0.4 * (2 ** (attempt - 1)) + random.uniform(0.1, 0.5), 15.0)
            time.sleep(sleep_sec)

    return False


def stream_download(
    url: str,
    dest_path: str,
    total_size: int = 0,
    referer: str = None,
    user_agent: str = None,
    max_retries: int = 5,
) -> bool:
    """
    Resilient single-stream downloader for non-ranged media endpoints or small files.
    """
    url = normalize_media_url(url)
    headers = get_provider_headers(url, referer=referer, user_agent=user_agent)

    existing_bytes = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
    if total_size > 0 and existing_bytes >= total_size:
        emit_ipc("complete", success=True, size=existing_bytes, dest_path=dest_path, elapsed_seconds=0.0)
        return True

    start_time = time.time()
    last_emit = start_time

    for attempt in range(1, max_retries + 1):
        try:
            req_headers = dict(headers)
            if existing_bytes > 0:
                req_headers["Range"] = f"bytes={existing_bytes}-"

            req = urllib.request.Request(url, headers=req_headers, method="GET")
            with urllib.request.urlopen(req, timeout=40) as resp:
                ctype = resp.headers.get("Content-Type", "").lower()
                if "text/html" in ctype:
                    raise RuntimeError("Server returned an HTML page instead of a media stream.")

                if total_size <= 0:
                    cr = resp.headers.get("Content-Range", "")
                    if cr and "/" in cr:
                        t_str = cr.split("/")[-1].strip()
                        if t_str.isdigit():
                            total_size = int(t_str)
                    if total_size <= 0:
                        clen = resp.headers.get("Content-Length")
                        if clen and clen.isdigit():
                            total_size = existing_bytes + int(clen)

                mode = "ab" if existing_bytes > 0 and resp.status == 206 else "wb"
                if mode == "wb":
                    existing_bytes = 0

                with open(dest_path, mode) as f:
                    while True:
                        buf = resp.read(512 * 1024)
                        if not buf:
                            break
                        f.write(buf)
                        existing_bytes += len(buf)

                        now = time.time()
                        if now - last_emit >= 0.9:
                            last_emit = now
                            elapsed = max(now - start_time, 0.001)
                            speed_mb = round((existing_bytes / (1024 * 1024)) / elapsed, 2)
                            pct = round((existing_bytes / total_size) * 100, 1) if total_size > 0 else 0.0
                            remaining = max(total_size - existing_bytes, 0)
                            speed_bps = existing_bytes / elapsed
                            eta = int(remaining / max(speed_bps, 1)) if total_size > 0 else 0
                            emit_ipc(
                                "progress",
                                downloaded=existing_bytes,
                                total=total_size,
                                percent=pct,
                                speed_mb=speed_mb,
                                eta_seconds=eta,
                            )

            final_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
            if final_size > 1000000 or (total_size > 0 and final_size >= total_size):
                emit_ipc(
                    "complete",
                    success=True,
                    size=final_size,
                    dest_path=dest_path,
                    elapsed_seconds=round(time.time() - start_time, 2),
                )
                return True

        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404, 410):
                emit_ipc("error", message=f"HTTP {e.code} ({e.reason})", code=e.code)
                return False
        except Exception:
            pass

        if attempt < max_retries:
            sleep_sec = min(0.5 * (2 ** (attempt - 1)) + random.uniform(0.1, 0.5), 15.0)
            time.sleep(sleep_sec)

    emit_ipc("error", message="Single-stream download failed after max retries", code=500)
    return False


def parallel_download(
    url: str,
    dest_path: str,
    num_threads: int = 4,
    referer: str = None,
    user_agent: str = None,
    retries: int = 5,
) -> bool:
    """
    Main entry point for SSS-grade multi-threaded chunked downloading.
    """
    url = normalize_media_url(url)
    num_threads = min(max(num_threads, 1), 8)

    # Register active download for graceful process signal cleanup
    with _CLEANUP_LOCK:
        _ACTIVE_DOWNLOADS[dest_path] = (num_threads, False)

    start_time = time.time()

    # Probe file size and byte-range capability
    try:
        size, supports_range = get_file_info(url, headers={"Referer": referer} if referer else None)
    except Exception as e:
        emit_ipc("error", message=str(e), code=403 if "403" in str(e) else 500)
        cleanup_artifacts(dest_path, num_threads, remove_completed=True)
        return False

    # Fallback to single-stream if small file or byte ranges unsupported
    if size < 5 * 1024 * 1024 or not supports_range:
        success = stream_download(
            url,
            dest_path,
            total_size=size,
            referer=referer,
            user_agent=user_agent,
            max_retries=retries,
        )
        if success:
            cleanup_artifacts(dest_path, num_threads)
        return success

    meta = load_or_init_meta(dest_path, url, size, num_threads)
    meta_lock = threading.Lock()
    stop_event = threading.Event()

    progress_dict = {}
    part_files = []
    for p in meta["parts"]:
        p_num = p["part_num"]
        pf = f"{dest_path}.part{p_num}"
        part_files.append(pf)
        current_p_size = os.path.getsize(pf) if os.path.exists(pf) else 0
        progress_dict[p_num] = min(current_p_size, p["expected_size"])

    last_report = start_time

    with ThreadPoolExecutor(max_workers=num_threads) as executor:
        futures = {
            executor.submit(
                download_chunk,
                url,
                dest_path,
                p,
                progress_dict,
                meta,
                meta_lock,
                stop_event,
                referer,
                user_agent,
                retries,
            ): p["part_num"]
            for p in meta["parts"]
        }

        while not all(f.done() for f in futures):
            now = time.time()
            if now - last_report >= 0.9:
                last_report = now
                downloaded = sum(progress_dict.values())
                pct = round((downloaded / size) * 100, 1) if size > 0 else 0.0
                elapsed = max(now - start_time, 0.001)
                speed_mb = round((downloaded / (1024 * 1024)) / elapsed, 2)
                remaining = max(size - downloaded, 0)
                speed_bps = downloaded / elapsed
                eta = int(remaining / max(speed_bps, 1)) if size > 0 else 0
                emit_ipc(
                    "progress",
                    downloaded=downloaded,
                    total=size,
                    percent=pct,
                    speed_mb=speed_mb,
                    eta_seconds=eta,
                )
            time.sleep(0.4)

        results = [f.result() for f in futures]

    if not all(results):
        # If any chunk failed, check if we should fallback to stream
        if stop_event.is_set():
            cleanup_artifacts(dest_path, num_threads)
            return False
        emit_ipc("error", message="Parallel chunk download failed, attempting single stream fallback...", code=500)
        return stream_download(url, dest_path, total_size=size, referer=referer, user_agent=user_agent)

    # Emit 100% progress before assembling
    emit_ipc(
        "progress",
        downloaded=size,
        total=size,
        percent=100.0,
        speed_mb=round((size / (1024 * 1024)) / max(time.time() - start_time, 0.001), 2),
        eta_seconds=0,
    )

    # Assemble chunks into destination file
    temp_assembled = f"{dest_path}.assembled.tmp"
    try:
        last_asm_heartbeat = time.time()
        with open(temp_assembled, "wb") as outfile:
            for pf in part_files:
                if not os.path.exists(pf):
                    raise RuntimeError(f"Part file missing: {pf}")
                with open(pf, "rb") as infile:
                    while True:
                        buf = infile.read(4 * 1024 * 1024)  # 4MB transfer buffer
                        if not buf:
                            break
                        outfile.write(buf)
                        now_asm = time.time()
                        if now_asm - last_asm_heartbeat >= 2.0:
                            last_asm_heartbeat = now_asm
                            emit_ipc(
                                "progress",
                                downloaded=size,
                                total=size,
                                percent=100.0,
                                speed_mb=round((size / (1024 * 1024)) / max(now_asm - start_time, 0.001), 2),
                                eta_seconds=0,
                                assembling=True,
                            )

        if os.path.exists(dest_path):
            os.remove(dest_path)
        os.rename(temp_assembled, dest_path)

        final_size = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0

        # Mark completed in active registry
        with _CLEANUP_LOCK:
            _ACTIVE_DOWNLOADS[dest_path] = (num_threads, True)

        cleanup_artifacts(dest_path, num_threads)

        emit_ipc(
            "complete",
            success=True,
            size=final_size,
            dest_path=dest_path,
            elapsed_seconds=round(time.time() - start_time, 2),
        )
        return True

    except Exception as assemble_err:
        if os.path.exists(temp_assembled):
            try:
                os.remove(temp_assembled)
            except Exception:
                pass
        emit_ipc("error", message=f"Chunk assembly error: {assemble_err}", code=500)
        return False


def _sig_handler(signum, frame):
    """Signal handler for graceful termination."""
    sys.exit(1)


# Register signal and exit handlers
try:
    signal.signal(signal.SIGINT, _sig_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _sig_handler)
except Exception:
    pass


def _exit_cleanup():
    """Ensure completed downloads have their temporary artifacts cleaned up."""
    with _CLEANUP_LOCK:
        for dest, (num_parts, is_done) in list(_ACTIVE_DOWNLOADS.items()):
            if is_done:
                cleanup_artifacts(dest, num_parts)


atexit.register(_exit_cleanup)


def main():
    parser = argparse.ArgumentParser(
        description="FilmFeed SSS-Grade Multi-Threaded Parallel Downloader",
        add_help=True,
    )
    parser.add_argument("url", nargs="?", default=None, help="Media source URL to download")
    parser.add_argument("dest", nargs="?", default=None, help="Destination local file path")
    parser.add_argument(
        "legacy_threads",
        nargs="?",
        default=None,
        help="Positional threads argument for backwards compatibility (optional)",
    )
    parser.add_argument("--threads", type=int, default=4, help="Number of parallel chunk threads (default: 4)")
    parser.add_argument("--chunk-size", type=int, default=None, help="Optional chunk size in bytes")
    parser.add_argument("--retries", type=int, default=5, help="Maximum retry attempts per chunk (default: 5)")
    parser.add_argument("--referer", type=str, default=None, help="Custom HTTP Referer header")
    parser.add_argument("--user-agent", type=str, default=None, help="Custom HTTP User-Agent header")

    args = parser.parse_args()

    if not args.url or not args.dest:
        emit_ipc("error", message="Missing required arguments: url and dest", code=2)
        sys.exit(2)

    # Support positional legacy threads: e.g. python fast_downloader.py <url> <dest> 4
    threads = args.threads
    if args.legacy_threads:
        try:
            threads = int(args.legacy_threads)
        except ValueError:
            pass

    dest_dir = os.path.dirname(os.path.abspath(args.dest))
    os.makedirs(dest_dir, exist_ok=True)

    success = parallel_download(
        url=args.url,
        dest_path=args.dest,
        num_threads=threads,
        referer=args.referer,
        user_agent=args.user_agent,
        retries=args.retries,
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
