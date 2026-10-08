#!/usr/bin/env python3
"""
CineSubz Resolver for WhatsApp Auto-Bot
Resolves movie metadata, poster, and high-speed direct download link.
"""

import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TIMEOUT = 45


# --------------------------------------------------------------------------
# tiny HTML tree
# --------------------------------------------------------------------------
class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children = []
        self.parent = parent

    def classes(self):
        return (self.attrs.get("class") or "").split()

    def has_class(self, name):
        return name in self.classes()

    def text(self):
        out = []
        for c in self.children:
            out.append(c.text() if isinstance(c, Node) else c)
        return re.sub(r"\s+", " ", "".join(out)).strip()

    def iter(self):
        for c in self.children:
            if isinstance(c, Node):
                yield c
                yield from c.iter()

    def find_all(self, cls=None, tag=None):
        return [
            n
            for n in self.iter()
            if (cls is None or n.has_class(cls)) and (tag is None or n.tag == tag)
        ]

    def find(self, cls=None, tag=None):
        r = self.find_all(cls, tag)
        return r[0] if r else None


class TreeBuilder(HTMLParser):
    VOID = {
        "img",
        "br",
        "hr",
        "meta",
        "link",
        "input",
        "source",
        "area",
        "base",
        "col",
        "embed",
        "param",
        "track",
        "wbr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        if tag not in self.VOID:
            self.cur = n

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if data:
            self.cur.children.append(data)


def parse_html(html):
    b = TreeBuilder()
    b.feed(html)
    return b.root


# --------------------------------------------------------------------------
# crypto helpers (CryptoJS-compatible passphrase AES)
# --------------------------------------------------------------------------
def _evp_kdf(pw: bytes, salt: bytes, klen=32, ilen=16):
    total, d = b"", b""
    while len(total) < klen + ilen:
        d = hashlib.md5(d + pw + salt).digest()
        total += d
    return total[:klen], total[klen : klen + ilen]


def _aes_cbc_decrypt(key: bytes, iv: bytes, body: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        d = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        return d.update(body) + d.finalize()
    except ImportError:
        pass
    try:
        from Crypto.Cipher import AES

        return AES.new(key, AES.MODE_CBC, iv).decrypt(body)
    except ImportError:
        pass
    p = subprocess.run(
        [
            "openssl",
            "enc",
            "-d",
            "-aes-256-cbc",
            "-nopad",
            "-K",
            key.hex(),
            "-iv",
            iv.hex(),
        ],
        input=body,
        capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError("no working AES backend (install 'cryptography' or openssl)")
    return p.stdout


def cryptojs_decrypt(b64: str, passphrase: str) -> str:
    raw = base64.b64decode(b64)
    if raw[:8] == b"Salted__":
        key, iv = _evp_kdf(passphrase.encode(), raw[8:16])
        body = raw[16:]
    else:
        key, iv = _evp_kdf(passphrase.encode(), b"")
        body = raw
    pt = _aes_cbc_decrypt(key, iv, body)
    pad = pt[-1]
    if 1 <= pad <= 16 and pt.endswith(bytes([pad]) * pad):
        pt = pt[:-pad]
    return pt.decode("utf-8", errors="ignore")


def unwrap_url(encrypted_blob: str, candidates):
    for pw in candidates:
        try:
            plain = cryptojs_decrypt(encrypted_blob, pw).strip()
        except Exception:
            continue
        try:
            decoded = base64.b64decode(plain, validate=True).decode("utf-8")
        except Exception:
            continue
        if decoded.startswith("http"):
            return decoded, pw
    return None, None


# --------------------------------------------------------------------------
# protobuf DownloadData { string url = 1; string error = 2; }
# --------------------------------------------------------------------------
def _varint(buf, i):
    n = s = 0
    while True:
        c = buf[i]
        i += 1
        n |= (c & 0x7F) << s
        if not c & 0x80:
            return n, i
        s += 7


def parse_download_data(buf: bytes):
    i, out = 0, {}
    while i < len(buf):
        tag, i = _varint(buf, i)
        fn, wt = tag >> 3, tag & 7
        if wt == 2:
            ln, i = _varint(buf, i)
            out[fn] = buf[i : i + ln].decode("utf-8", "replace")
            i += ln
        elif wt == 0:
            out[fn], i = _varint(buf, i)
        else:
            break
    return out.get(1, ""), out.get(2, "")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def _opener(cookie_jar=None):
    handlers = []
    if cookie_jar is not None:
        handlers.append(urllib.request.HTTPCookieProcessor(cookie_jar))
    return urllib.request.build_opener(*handlers)


def http_get(url, opener=None, headers=None, timeout=TIMEOUT):
    h = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    op = opener or _opener()
    with op.open(req, timeout=timeout) as r:
        return r.read(), dict(r.headers), r.url


def http_get_noredirect(url, timeout=TIMEOUT):
    class NoRedir(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    op = urllib.request.build_opener(NoRedir)
    hdrs = {
        "User-Agent": UA,
        "Range": "bytes=0-1023",
        "Accept-Encoding": "identity",
    }
    req = urllib.request.Request(url, headers=hdrs)
    redirects = 0
    while True:
        try:
            with op.open(req, timeout=timeout) as r:
                return r.status, dict(r.headers), r.geturl(), redirects
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                redirects += 1
                req = urllib.request.Request(
                    urllib.parse.urljoin(url, e.headers["Location"]), headers=hdrs
                )
                continue
            return e.code, dict(e.headers), url, redirects


# --------------------------------------------------------------------------
# step 1: scrape movie page
# --------------------------------------------------------------------------
def scrape_movie(url: str, log=sys.stderr.write):
    body, _, final_url = http_get(url)
    html = body.decode("utf-8", "replace")
    root = parse_html(html)

    def first(cls, tag=None):
        return root.find(cls=cls, tag=tag)

    banner = {}
    splash = root.find(cls="splash-bg")
    if splash:
        img = splash.find(tag="img")
        if img:
            banner["backdrop"] = img.attrs.get("src")
    poster = root.find(cls="poster-img")
    if poster:
        banner["poster"] = poster.attrs.get("src")
    if "poster" not in banner:
        m = re.search(
            r'property=["\']og:image["\']\s+content=["\']([^"\']+)', html
        ) or re.search(r'content=["\']([^"\']+)["\']\s+property=["\']og:image', html)
        if m:
            banner.setdefault("poster", m.group(1))

    details = {}
    t = first(cls="details-title")
    if t:
        details["title"] = t.text()
    m = re.search(r"\((\d{4})\)", details.get("title", ""))
    if m:
        details["year"] = int(m.group(1))
    q = first(cls="data-quality")
    if q:
        details["quality"] = q.text()
    imdb = first(cls="data-imdb")
    if imdb:
        m = re.search(r"IMDb:\s*([\d.]+)", imdb.text())
        if m:
            details["imdb"] = float(m.group(1))

    desc = root.find(cls="details-desc")
    description = desc.text() if desc else ""
    if description:
        description = re.sub(r"\s+", " ", description).strip()

    entries = []
    for item in root.find_all(cls="movie-download-link-item"):
        a = item.find(tag="a")
        if not a:
            continue
        type_n = item.find(cls="movie-download-type")
        meta_n = item.find(cls="movie-download-meta")
        meta = meta_n.text() if meta_n else ""
        size_bytes = None
        m = re.search(r"([\d.]+)\s*(GB|MB|TB|KB)", meta, re.I)
        if m:
            mult = {"KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
            size_bytes = int(float(m.group(1)) * mult[m.group(2).upper()])
        bits = [b.strip() for b in meta.split("•")]
        entries.append(
            {
                "label": type_n.text() if type_n else "Download",
                "meta": meta,
                "quality": bits[0] if bits else "",
                "size_text": (m.group(0) if m else None),
                "size_bytes": size_bytes,
                "language": bits[-1] if len(bits) > 2 else None,
                "zt_url": urllib.parse.urljoin(final_url, a.attrs.get("href", "")),
            }
        )

    return {
        "source_url": url,
        "final_url": final_url,
        "banner": banner,
        "details": details,
        "description": description,
        "downloads": entries,
    }


# --------------------------------------------------------------------------
# step 2: map zt links
# --------------------------------------------------------------------------
def map_zt_href(original: str, zt_html: str) -> str:
    mappings = []
    for mo in re.finditer(r"\{search:\[([^\]]+)\],replace:\"([^\"]+)\"\}", zt_html):
        searches = re.findall(r"\"([^\"]+)\"", mo.group(1))
        mappings.append((searches, mo.group(2)))
    url = original
    for searches, repl in mappings:
        for s in searches:
            if s in url:
                url = url.replace(s, repl)
                return url
    return url


def get_drive_url(zt_url: str):
    body, _, _ = http_get(zt_url)
    html = body.decode("utf-8", "replace")
    m = re.search(r'<a id="link" href="([^"]+)"', html)
    if not m:
        return {"kind": "error", "url": None, "reason": "no #link on zt page"}
    original = m.group(1)
    mapped = map_zt_href(original, html)
    if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", mapped):
        return {"kind": "telegram", "url": mapped, "original": original}

    parts = urllib.parse.urlsplit(mapped)
    bare = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    urls = [bare] if bare == mapped or not parts.query else [bare, mapped]
    return {"kind": "direct", "url": bare, "urls": urls, "original": original}


def _resolve_one(drive_url: str):
    parts = urllib.parse.urlsplit(drive_url)
    host = f"{parts.scheme}://{parts.netloc}"
    path = parts.path

    jar = http.cookiejar.CookieJar()
    op = _opener(jar)

    def get(url, headers=None):
        h = {"User-Agent": UA}
        h.update(headers or {})
        with op.open(urllib.request.Request(url, headers=h), timeout=TIMEOUT) as r:
            return r.read()

    try:
        get(host + path)
    except Exception:
        return []

    try:
        data = json.loads(
            get(
                f"{host}/api/download-data{path}", {"Accept": "application/json"}
            ).decode()
        )
    except Exception:
        return []
    if not data.get("success"):
        return []
    target = host + data["redirect"]

    try:
        page = get(target, {"Referer": host + "/"}).decode("utf-8", "replace")
    except Exception:
        return []
    if "dl-links" not in page:
        return []

    payloads, seen = [], set()
    for mo in re.finditer(r"'([0-9a-f]{300,})'", page):
        if mo.group(1) not in seen:
            seen.add(mo.group(1))
            payloads.append(mo.group(1))
    candidates = sorted(
        {
            s
            for s in re.findall(r"'([A-Za-z0-9_\-]{4,24})'", page)
            if not s.startswith(("http", "div", "span", "imag", "butt"))
        },
        key=len,
    )

    found = []
    for hp in payloads:
        try:
            req = urllib.request.Request(
                target,
                data=bytes.fromhex(hp),
                method="POST",
                headers={
                    "User-Agent": UA,
                    "Content-Type": "application/octet-stream",
                    "Referer": target,
                    "Origin": host,
                },
            )
            with op.open(req, timeout=TIMEOUT) as r:
                raw = r.read()
        except Exception:
            continue
        if raw[:1] == b"{":
            continue
        blob, _ = parse_download_data(raw)
        if not blob:
            continue
        final, _ = unwrap_url(blob, candidates)
        if final and final not in found:
            found.append(final)
    return found


def resolve_direct_link(movie_url: str, requested_quality: str = None):
    movie = scrape_movie(movie_url)
    downloads = movie["downloads"]
    if not downloads:
        return {"error": "No download links found on movie page", "movie": movie}

    # Filter/sort by requested quality if specified
    target_entry = None
    if requested_quality:
        rq = requested_quality.lower()
        for d in downloads:
            meta = (d.get("meta") or "").lower()
            q = (d.get("quality") or "").lower()
            lbl = (d.get("label") or "").lower()
            if rq in meta or rq in q or rq in lbl:
                target_entry = d
                break

    if not target_entry and downloads:
        target_entry = downloads[0]

    got = get_drive_url(target_entry["zt_url"])
    if got["kind"] == "telegram":
        return {
            "error": "Telegram link only",
            "telegram_url": got["url"],
            "movie": movie,
        }
    if got["kind"] != "direct":
        return {"error": "Failed to map zt link", "movie": movie}

    candidates = []
    for u in got.get("urls") or [got["url"]]:
        candidates.extend(_resolve_one(u))

    file_urls = [
        c
        for c in candidates
        if not re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", c)
    ]
    if not file_urls:
        return {"error": "No direct file URL resolved", "movie": movie}

    direct_url = file_urls[0]

    return {
        "success": True,
        "title": movie["details"].get("title", "Movie"),
        "year": movie["details"].get("year"),
        "poster": movie["banner"].get("poster"),
        "backdrop": movie["banner"].get("backdrop"),
        "description": movie["description"],
        "quality": target_entry.get("quality") or requested_quality,
        "size_text": target_entry.get("size_text"),
        "direct_url": direct_url,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="CineSubz movie URL")
    ap.add_argument("--quality", default=None, help="Target quality (e.g. 1080p, 720p)")
    args = ap.parse_args()

    result = resolve_direct_link(args.url, args.quality)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
