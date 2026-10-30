#!/usr/bin/env python3
"""
CineSubz Resolver for WhatsApp Auto-Bot
Resolves movie metadata, poster, and high-speed direct download link.
"""

import argparse
import base64
import hashlib
import html
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

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


HTTP_SESSION = None

def get_http_session():
    global HTTP_SESSION
    if HTTP_SESSION is None:
        import requests
        HTTP_SESSION = requests.Session()
        HTTP_SESSION.headers.update({
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": "https://cinesubz.lk/",
            "Connection": "keep-alive",
        })
    return HTTP_SESSION


def http_get(url, opener=None, headers=None, timeout=TIMEOUT):
    # Normalize cinesubz.net / cinesubz.co to cinesubz.lk for fast direct access
    clean_url = re.sub(r"https?://(www\.)?cinesubz\.(net|co)/", "https://cinesubz.lk/", url)
    sess = get_http_session()
    h = {}
    if headers:
        h.update(headers)

    last_err = None
    for attempt in range(1, 4):
        try:
            r = sess.get(clean_url, headers=h, timeout=min(timeout, 20))
            if r.status_code == 200:
                return r.content, dict(r.headers), str(r.url)
            elif r.status_code in (301, 302, 303, 307, 308) and r.headers.get("Location"):
                redir_url = urllib.parse.urljoin(clean_url, r.headers["Location"])
                return http_get(redir_url, opener, headers, timeout)
            else:
                last_err = RuntimeError(f"HTTP {r.status_code} fetching {clean_url}")
        except Exception as e:
            last_err = e
            if attempt < 3:
                time.sleep(0.5 * attempt)

    h_urllib = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*"}
    h_urllib.update(headers or {})
    req = urllib.request.Request(clean_url, headers=h_urllib)
    op = opener or _opener()
    try:
        with op.open(req, timeout=timeout) as r:
            return r.read(), dict(r.headers), r.url
    except Exception as op_err:
        raise RuntimeError(f"Network error fetching {clean_url}: {last_err or op_err}")


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
# step 1: scrape movie / episode / series page
# --------------------------------------------------------------------------
def clean_page_title(raw: str) -> str:
    if not raw:
        return ""
    title = html.unescape(raw).strip()
    # Strip site branding suffix e.g. " - CineSubz.lk", " | CineSubz", " - CineSubz"
    title = re.sub(r"\s*[-|–—•]\s*CineSubz(?:\.(?:lk|net|co|com|org))?\b.*$", "", title, flags=re.I).strip()
    # Strip site branding prefix e.g. "CineSubz.lk - "
    title = re.sub(r"^cinesubz(?:\.(?:lk|net|co|com|org))?\s*[-|–—•]\s*", "", title, flags=re.I).strip()
    # Strip trailing Sinhala subtitle tags if appended as suffix
    title = re.sub(r"\s*[-|–—•]\s*(?:සිංහල\s*උපසිරැසි.*|sinhala\s*subtitles?|sinhala\s*sub)\b.*$", "", title, flags=re.I).strip()
    return re.sub(r"\s+", " ", title).strip()


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
            banner["backdrop"] = (img.attrs.get("src") or "").strip()
    poster = root.find(cls="poster-img")
    if poster:
        banner["poster"] = (poster.attrs.get("src") or "").strip()
    if not banner.get("poster"):
        m = re.search(
            r'property=["\']og:image["\']\s+content=["\']([^"\']+)', html
        ) or re.search(r'content=["\']([^"\']+)["\']\s+property=["\']og:image', html)
        if m:
            banner["poster"] = m.group(1).strip()
    if not banner.get("backdrop") and banner.get("poster"):
        banner["backdrop"] = banner["poster"]

    details = {}
    title_cand = ""

    # 1. details-title
    t = first(cls="details-title")
    if t and t.text().strip():
        title_cand = clean_page_title(t.text())

    # 2. entry-title
    if not title_cand:
        et = root.find(cls="entry-title")
        if et and et.text().strip():
            title_cand = clean_page_title(et.text())

    # 3. h1 tag (excluding generic headings like "Download Links")
    if not title_cand:
        for h1_node in root.find_all(tag="h1"):
            h1_text = h1_node.text().strip()
            if h1_text and not re.search(r"\b(download|links|direct & telegram)\b", h1_text, re.I):
                c = clean_page_title(h1_text)
                if c:
                    title_cand = c
                    break

    # 4. og:title meta
    if not title_cand:
        m_og_title = (
            re.search(r'property=["\']og:title["\']\s+content=["\']([^"\']+)', html)
            or re.search(r'content=["\']([^"\']+)["\']\s+property=["\']og:title', html)
        )
        if m_og_title:
            title_cand = clean_page_title(m_og_title.group(1))

    # 5. <title> HTML tag
    if not title_cand:
        t_tag = root.find(tag="title")
        if t_tag and t_tag.text().strip():
            title_cand = clean_page_title(t_tag.text())
        else:
            m_title_tag = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
            if m_title_tag:
                title_cand = clean_page_title(m_title_tag.group(1))

    # 6. Fallback: URL slug
    if not title_cand:
        slug = final_url.rstrip("/").split("/")[-1].replace("-", " ")
        title_cand = clean_page_title(slug).title()

    if title_cand:
        details["title"] = title_cand

    m = re.search(r"\((\d{4})\)", details.get("title", ""))
    if m:
        details["year"] = int(m.group(1))
    else:
        m_y = re.search(r"\b(19\d\d|20\d\d)\b", details.get("title", ""))
        if m_y:
            details["year"] = int(m_y.group(1))
        else:
            y_elem = first(cls="data-year") or first(cls="year") or first(cls="release-year")
            if y_elem:
                m_elem = re.search(r"\b(19\d\d|20\d\d)\b", y_elem.text())
                if m_elem:
                    details["year"] = int(m_elem.group(1))

    q = first(cls="data-quality")
    if q:
        details["quality"] = q.text()
    imdb = first(cls="data-imdb")
    if imdb:
        m = re.search(r"IMDb:\s*([\d.]+)", imdb.text())
        if m:
            details["imdb"] = float(m.group(1))

    desc = root.find(cls="details-desc") or root.find(cls="entry-content") or root.find(cls="description")
    description = desc.text() if desc else ""
    if not description:
        # Fallback to og:description meta
        m_desc = re.search(r'property=["\']og:description["\']\s+content=["\']([^"\']+)', html) or \
                 re.search(r'name=["\']description["\']\s+content=["\']([^"\']+)', html)
        if m_desc:
            description = m_desc.group(1).strip()

    if description:
        description = re.sub(r"\s+", " ", description).strip()
        # Remove trailing complete collection or repeat tags
        description = re.sub(r"Avatar Complete Collection.*", "", description)
        description = re.sub(r"තවත් ලස්සන කතාවකින්.*", "", description).strip()

    entries = []
    # Movie pages use movie-download-* classes; episode pages use plain
    # download-* classes (e.g. /episodes/lanterns-1x1/). Accept both.
    items = root.find_all(cls="movie-download-link-item") or root.find_all(
        cls="download-link-item"
    )
    for item in items:
        a = item.find(tag="a")
        if not a:
            continue
        type_n = item.find(cls="movie-download-type") or item.find(
            cls="download-type"
        )
        meta_n = item.find(cls="movie-download-meta") or item.find(
            cls="download-meta"
        )
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

    # Fallback: scan for any links pointing to zt-links if items was empty
    if not entries:
        for a in root.find_all(tag="a"):
            href = a.attrs.get("href", "")
            if "/zt-links/" in href or "/zt-" in href or "/api-" in href or ("/api" in href and "cinesubz" in href):
                text = a.text().strip()
                parent_text = a.parent.text().strip() if a.parent else text
                m = re.search(r"([\d.]+)\s*(GB|MB|TB|KB)", parent_text, re.I)
                size_bytes = None
                if m:
                    mult = {"KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
                    size_bytes = int(float(m.group(1)) * mult[m.group(2).upper()])
                m_q = re.search(r"(1080p|720p|480p|360p|2160p|4K)", parent_text, re.I)
                q_str = m_q.group(1) if m_q else "HD"
                entries.append(
                    {
                        "label": text or "Direct Download",
                        "meta": parent_text,
                        "quality": q_str,
                        "size_text": (m.group(0) if m else None),
                        "size_bytes": size_bytes,
                        "language": "Sinhala Sub",
                        "zt_url": urllib.parse.urljoin(final_url, href),
                    }
                )

    # TV series pages carry no download links themselves; they list episodes
    # Support .episode-link, .ep-item, or any a[href*="/episodes/"]
    episodes = []
    seen_ep_urls = set()
    for a in root.find_all(tag="a"):
        raw_href = a.attrs.get("href", "").strip()
        cls_name = str(a.attrs.get("class", ""))
        if not raw_href or "#respond" in raw_href or "#comments" in raw_href:
            continue
        # Strip fragment and query for clean url matching
        href = re.sub(r"[?#].*$", "", raw_href).strip()
        if not href or href in seen_ep_urls:
            continue
        is_ep = "episode-link" in cls_name or "/episodes/" in href or "episode" in cls_name
        if not is_ep:
            continue
        if href.endswith("/episodes/") or href.endswith("/episodes"):
            continue

        ep_title_n = a.find(cls="ep-title")
        ep_title = ep_title_n.text().strip() if ep_title_n else a.text().strip()
        # Filter out common false-positive buttons
        if ep_title.lower() in ("cancel", "next", "prev", "previous", "reply", "next episode", "prev episode", "home"):
            continue

        seen_ep_urls.add(href)

        try:
            season = int(a.attrs.get("data-season") or 0)
        except (TypeError, ValueError):
            season = 0
        try:
            ep_num = int(a.attrs.get("data-episode") or 0)
        except (TypeError, ValueError):
            ep_num = 0

        # Fallback regex extraction from href and title
        if season == 0 or ep_num == 0:
            m_se = (
                re.search(r"[-_]s(\d+)e(\d+)", href, re.I)
                or re.search(r"(\d+)x(\d+)", href, re.I)
                or re.search(r"s(\d+)e(\d+)", ep_title, re.I)
                or re.search(r"(\d+)x(\d+)", ep_title, re.I)
            )
            if m_se:
                if season == 0: season = int(m_se.group(1))
                if ep_num == 0: ep_num = int(m_se.group(2))
            else:
                m_s = re.search(r"season[-_]?(\d+)", href, re.I) or re.search(r"season\s*(\d+)", ep_title, re.I)
                m_e = re.search(r"episode[-_]?(\d+)", href, re.I) or re.search(r"ep(?:isode)?\s*(\d+)", ep_title, re.I)
                if m_s and season == 0: season = int(m_s.group(1))
                if m_e and ep_num == 0: ep_num = int(m_e.group(1))

        if season == 0:
            season = 1

        episodes.append(
            {
                "season": season,
                "episode": ep_num,
                "title": ep_title or f"Episode {ep_num or len(episodes) + 1}",
                "url": urllib.parse.urljoin(final_url, href),
            }
        )

    episodes.sort(key=lambda x: (x["season"], x["episode"]))

    return {
        "source_url": url,
        "final_url": final_url,
        "banner": banner,
        "details": details,
        "description": description,
        "downloads": entries,
        "episodes": episodes,
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
    m = re.search(r'<a[^>]+id=["\']link["\'][^>]+href=["\']([^"\']+)["\']', html) or re.search(r'<a[^>]+href=["\']([^"\']+)["\'][^>]+id=["\']link["\']', html) or re.search(r'<a id="link" href="([^"]+)"', html)
    parent_url = None
    m_prev = re.search(r'<a[^>]+class=["\'][^"\']*prev-lnk[^"\']*["\'][^>]+href=["\']([^"\']+)["\']', html) or re.search(r'<a[^>]+href=["\']([^"\']+)["\'][^>]+class=["\'][^"\']*prev-lnk[^"\']*["\']', html)
    if m_prev:
        parent_url = m_prev.group(1).strip()

    if not m:
        return {"kind": "error", "url": None, "reason": "no #link on zt page", "parent_url": parent_url}
    original = m.group(1)
    mapped = map_zt_href(original, html)
    if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", mapped):
        return {"kind": "telegram", "url": mapped, "original": original, "parent_url": parent_url}

    parts = urllib.parse.urlsplit(mapped)
    bare = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    urls = [bare] if bare == mapped or not parts.query else [bare, mapped]
    return {"kind": "direct", "url": bare, "urls": urls, "original": original, "parent_url": parent_url}


def _resolve_one(drive_url: str):
    parts = urllib.parse.urlsplit(drive_url)
    host = f"{parts.scheme}://{parts.netloc}"
    path = parts.path

    import requests
    sess = requests.Session()
    sess.headers.update({
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive",
    })

    try:
        sess.get(host + path, timeout=12)
    except Exception:
        return []

    try:
        r_api = sess.get(
            f"{host}/api/download-data{path}",
            headers={"Accept": "application/json", "Referer": host + path},
            timeout=12,
        )
        data = r_api.json()
    except Exception:
        return []
    if not data.get("success"):
        return []
    target = host + data["redirect"]

    try:
        r_page = sess.get(target, headers={"Referer": host + "/"}, timeout=12)
        page = r_page.text
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
            r_post = sess.post(
                target,
                data=bytes.fromhex(hp),
                headers={
                    "Content-Type": "application/octet-stream",
                    "Referer": target,
                    "Origin": host,
                },
                timeout=12,
            )
            raw = r_post.content
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
            # Break early once we have found a high-speed direct file download link
            if any(ext in final.lower() for ext in (".mp4", ".mkv", "pixeldrain", "kdrive", "supercloud", "cloudflarestorage", "aws4")):
                break
    return found


def make_thumbnail_b64(image_url: str) -> str:
    if not image_url or not image_url.startswith("http"):
        return ""
    try:
        from PIL import Image
        import io, base64
        # Downscale TMDB original URLs to w300 to fetch in milliseconds instead of downloading 5MB
        fast_url = re.sub(r"/t/p/(original|w\d+)/", "/t/p/w300/", image_url)
        req = urllib.request.Request(fast_url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = r.read()
        im = Image.open(io.BytesIO(data))
        im.thumbnail((250, 250))
        if im.mode != "RGB":
            im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=75, optimize=True)
        return base64.b64encode(out.getvalue()).decode("ascii")
    except Exception:
        return ""


def resolve_baiscopes_movie(movie_url: str, requested_quality: str = None):
    """Scrapes Baiscopes.lk page directly for intermediate/direct download links, with SinhalaSub/CineSubz fallbacks."""
    body, _, final_url = http_get(movie_url)
    html = body.decode("utf-8", "replace")
    root = parse_html(html)

    title = ""
    h1 = root.find(tag="h1")
    if h1:
        title = re.split(r"\s*\|\s*", h1.text())[0].strip()
    if not title:
        title = movie_url.rstrip("/").split("/")[-1].replace("-", " ").title()

    poster = ""
    p_img = root.find(cls="poster")
    if p_img:
        img_el = p_img.find(tag="img")
        if img_el:
            poster = img_el.attrs.get("data-src") or img_el.attrs.get("src") or ""
    if not poster:
        m_og = re.search(r'property=["\']og:image["\']\s+content=["\']([^"\']+)', html)
        if m_og:
            poster = m_og.group(1).strip()

    dl_links = []
    for row in root.find_all(tag="tr"):
        a_tag = row.find(tag="a")
        if not a_tag:
            continue
        href = a_tag.attrs.get("href", "")
        if "/links/" in href or ("baiscopes.lk" not in href and any(x in href.lower() for x in ["pixeldrain", "supercloud", "drive.google", ".mp4", ".mkv"])):
            dl_links.append(href)

    if not dl_links:
        for a in root.find_all(tag="a"):
            href = a.attrs.get("href", "")
            if "/links/" in href:
                dl_links.append(href)

    for intermediate_url in dl_links:
        if "/links/" in intermediate_url:
            try:
                i_body, _, _ = http_get(intermediate_url)
                i_html = i_body.decode("utf-8", "replace")
                i_root = parse_html(i_html)
                for a in i_root.find_all(tag="a"):
                    href = a.attrs.get("href", "")
                    txt = a.text().lower()
                    if ("download" in txt or "click here" in txt or "file" in txt) and href.startswith("http") and "baiscopes.lk" not in href:
                        thumb = make_thumbnail_b64(poster)
                        return {
                            "success": True,
                            "title": title,
                            "poster": poster,
                            "backdrop": poster,
                            "thumbnail_b64": thumb,
                            "quality": requested_quality or "720p",
                            "size_text": "",
                            "direct_url": href,
                        }
            except Exception:
                pass
        elif intermediate_url.startswith("http"):
            thumb = make_thumbnail_b64(poster)
            return {
                "success": True,
                "title": title,
                "poster": poster,
                "backdrop": poster,
                "thumbnail_b64": thumb,
                "quality": requested_quality or "720p",
                "size_text": "",
                "direct_url": intermediate_url,
            }

    # Fallback: Search SinhalaSub then CineSubz
    clean_name = re.sub(r"(sinhala\s*subtitles?|සිංහල\s*උපසිරැසි.*|\b(19\d\d|20\d\d)\b)", "", title, flags=re.I).strip()
    if clean_name:
        try:
            from sinhalasub_resolver import search_sinhalasub, resolve_sinhalasub_movie
            sh_cands = search_sinhalasub(clean_name)
            if sh_cands:
                res = resolve_sinhalasub_movie(sh_cands[0]["url"], requested_quality)
                if res.get("success"):
                    res["fallback_from"] = "Baiscopes"
                    return res
        except Exception:
            pass

        try:
            s_body, _, _ = http_get(f"https://cinesubz.lk/?s={urllib.parse.quote(clean_name)}")
            s_root = parse_html(s_body.decode("utf-8", "replace"))
            for a in s_root.find_all(tag="a"):
                href = a.attrs.get("href", "")
                if "/movies/" in href and not href.endswith("/movies/"):
                    res = resolve_direct_link(href, requested_quality, _depth=1)
                    if res.get("success"):
                        res["fallback_from"] = "Baiscopes"
                        return res
        except Exception:
            pass

    return {"error": f"No download links found on Baiscopes page: {movie_url}"}


def resolve_direct_link(
    movie_url: str, requested_quality: str = None, _depth: int = 0
):
    movie_url = re.sub(r"https?://(www\.)?cinesubz\.(net|co)/", "https://cinesubz.lk/", movie_url)
    if "sinhalasub" in movie_url:
        try:
            from sinhalasub_resolver import resolve_sinhalasub_movie
            return resolve_sinhalasub_movie(movie_url, requested_quality)
        except Exception as e:
            return {"error": f"Sinhalasub resolver error: {e}"}

    if "baiscope" in movie_url:
        try:
            return resolve_baiscopes_movie(movie_url, requested_quality)
        except Exception as e:
            pass

    # Direct zt-links or intermediate redirect link support (/zt-links/, /api-, /zt-, ?r=)
    is_zt = (
        "/zt-links/" in movie_url
        or "?r=" in movie_url
        or "cinesubz.net/zt-" in movie_url
        or "cinesubz.lk/zt-" in movie_url
        or "/api-" in movie_url
        or ("cinesubz" in movie_url and "/api" in movie_url)
    ) and not any(k in movie_url for k in ("/movies/", "/tvshows/", "/series/", "/episodes/"))
    if is_zt:
        found_link = None
        try:
            got = get_drive_url(movie_url)
            if got.get("parent_url"):
                found_link = got["parent_url"]
            if got.get("kind") == "telegram":
                return {
                    "success": True,
                    "title": "Movie Download",
                    "poster": "",
                    "backdrop": "",
                    "description": "",
                    "quality": requested_quality or "720p",
                    "size_text": "",
                    "direct_url": got["url"],
                    "is_telegram": True,
                }
            candidates = []
            for u in got.get("urls") or [got.get("url")]:
                if u:
                    candidates.extend(_resolve_one(u))
            file_urls = [
                c for c in candidates
                if not re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", c)
            ]

            title = "Movie Download"
            poster = ""
            backdrop = ""
            description = ""
            year = None
            raw_target = got.get("url") or ""
            if raw_target:
                fname = urllib.parse.unquote(raw_target.split("/")[-1])
                fname = re.sub(r"\[CineSubz\.[a-z]+\]", "", fname, flags=re.I)
                fname = re.sub(r"\.(mp4|mkv|avi)$", "", fname, flags=re.I).strip()
                if fname:
                    title = fname
                # Query CineSubz for title to retrieve official poster, TMDB backdrop, and parent movie page
                m_search = re.search(r"^([a-zA-Z0-9\s]+?)(?:\s*\(\d{4}\)|\s+\d{4}|\s+WEB|\s+Hindi|\s+Telugu|\s+Tamil|\s+Sinhala)", title)
                search_q = m_search.group(1).strip() if m_search else title.split()[0]
                if search_q and len(search_q) >= 3:
                    try:
                        s_body, _, _ = http_get(f"https://cinesubz.lk/?s={urllib.parse.quote(search_q)}")
                        s_root = parse_html(s_body.decode("utf-8", "replace"))
                        for a in s_root.find_all(tag="a"):
                            href = a.attrs.get("href", "")
                            if "/movies/" in href and not href.endswith("/movies/"):
                                found_link = href
                                break
                        if found_link:
                            meta_m = scrape_movie(found_link)
                            if meta_m.get("details", {}).get("title"):
                                title = meta_m["details"]["title"]
                            year = meta_m.get("details", {}).get("year")
                            poster = meta_m.get("banner", {}).get("poster") or ""
                            backdrop = meta_m.get("banner", {}).get("backdrop") or ""
                            description = meta_m.get("description") or ""
                    except Exception:
                        pass

            # If user explicitly requested a quality that differs from current zt filename (e.g. 720p requested on 480p link),
            # resolve directly through parent movie page so user gets the exact requested quality!
            if found_link and requested_quality and _depth == 0:
                cur_q = "480p" if "480p" in title.lower() else "720p" if "720p" in title.lower() else "1080p" if "1080p" in title.lower() else ""
                req_q = requested_quality.lower()
                if cur_q and req_q not in cur_q:
                    alt_res = resolve_direct_link(found_link, requested_quality, _depth=_depth + 1)
                    if alt_res.get("success"):
                        return alt_res

            if file_urls:
                thumb = make_thumbnail_b64(backdrop or poster or "")
                return {
                    "success": True,
                    "title": title,
                    "year": year,
                    "poster": poster,
                    "backdrop": backdrop,
                    "thumbnail_b64": thumb,
                    "description": description,
                    "quality": requested_quality or "720p",
                    "size_text": "",
                    "direct_url": file_urls[0],
                }
            tg_cand = [c for c in candidates if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", c)]
            if tg_cand:
                thumb = make_thumbnail_b64(backdrop or poster or "")
                return {
                    "success": True,
                    "title": title,
                    "year": year,
                    "poster": poster,
                    "backdrop": backdrop,
                    "thumbnail_b64": thumb,
                    "description": description,
                    "quality": requested_quality or "720p",
                    "size_text": "",
                    "direct_url": tg_cand[0],
                    "is_telegram": True,
                }

            # If direct decryption on zt link was empty, try parent movie page
            if found_link and _depth == 0:
                alt_res = resolve_direct_link(found_link, requested_quality, _depth=_depth + 1)
                if alt_res.get("success"):
                    return alt_res
        except Exception as e:
            if found_link and _depth == 0:
                alt_res = resolve_direct_link(found_link, requested_quality, _depth=_depth + 1)
                if alt_res.get("success"):
                    return alt_res
            return {"error": f"Failed to decrypt CineSubz link: {e}"}

        return {"error": f"Could not extract direct stream link from: {movie_url}"}

    try:
        movie = scrape_movie(movie_url)
    except Exception as scrape_err:
        movie = {"downloads": [], "details": {}, "error": str(scrape_err)}

    downloads = movie.get("downloads") or []
    episodes = movie.get("episodes") or []

    # TV series page: no direct links -> follow the first available episode.
    # (The web app requests episode URLs directly; this is a fallback so a
    # pasted series URL still works in WhatsApp.)
    if not downloads and episodes and _depth == 0:
        first_ep = episodes[0]
        result = resolve_direct_link(
            first_ep["url"], requested_quality, _depth=_depth + 1
        )
        if result.get("success"):
            result["series_title"] = movie["details"].get("title")
            result["series_url"] = movie_url
            result["episode_count"] = len(episodes)
            return result
    if not downloads:
        if _depth == 0:
            clean_name = movie.get("details", {}).get("title") or movie_url.rstrip("/").split("/")[-1].replace("-", " ")
            clean_name = re.sub(r"(sinhala\s*subtitles?|සිංහල\s*උපසිරැසි.*|\b(19\d\d|20\d\d)\b)", "", clean_name, flags=re.I).strip()
            if clean_name:
                try:
                    from sinhalasub_resolver import search_sinhalasub, resolve_sinhalasub_movie
                    sh_cands = search_sinhalasub(clean_name)
                    if sh_cands:
                        res = resolve_sinhalasub_movie(sh_cands[0]["url"], requested_quality)
                        if res.get("success"):
                            res["fallback_from"] = "CineSubz"
                            return res
                except Exception:
                    pass
                try:
                    b_path = os.path.join(os.path.dirname(__file__), "../web/src/data/baiscopes_movies.json")
                    if os.path.exists(b_path):
                        with open(b_path, "r", encoding="utf-8") as bf:
                            b_items = json.load(bf)
                            for bi in b_items:
                                if clean_name.lower() in (bi.get("title") or "").lower():
                                    res = resolve_baiscopes_movie(bi["url"], requested_quality)
                                    if res.get("success"):
                                        res["fallback_from"] = "CineSubz"
                                        return res
                except Exception:
                    pass
        return {"error": "No download links found on movie page", "movie": movie}

    # Filter/sort by requested quality if specified, but fall back to others if it fails
    ordered_entries = []
    if requested_quality:
        rq = requested_quality.lower()
        for d in downloads:
            meta = (d.get("meta") or "").lower()
            q = (d.get("quality") or "").lower()
            lbl = (d.get("label") or "").lower()
            if rq in meta or rq in q or rq in lbl:
                ordered_entries.append(d)
        for d in downloads:
            if d not in ordered_entries:
                ordered_entries.append(d)
    else:
        ordered_entries = list(downloads)

    title = movie["details"].get("title", "Movie")
    ep_m = re.search(r"(\d+)[x\u00d7](\d+)", title)
    if ep_m:
        show = re.sub(r"\s*[:\-]\s*\d+[x\u00d7]\d+.*$", "", title).strip()
        if show:
            title = "%s S%02dE%02d" % (show, int(ep_m.group(1)), int(ep_m.group(2)))

    last_error = "No direct file URL resolved"
    for entry in ordered_entries:
        try:
            got = get_drive_url(entry["zt_url"])
            if got.get("kind") == "telegram":
                return {
                    "success": True,
                    "title": title,
                    "poster": movie["banner"].get("poster") or movie["details"].get("poster", ""),
                    "backdrop": movie["banner"].get("backdrop") or movie["details"].get("backdrop", ""),
                    "description": movie.get("description") or movie["details"].get("description", ""),
                    "quality": entry.get("quality") or requested_quality or "720p",
                    "size_text": entry.get("size_text", ""),
                    "direct_url": got["url"],
                    "is_telegram": True,
                }
            if got.get("kind") != "direct":
                last_error = "Failed to map zt link"
                continue

            candidates = []
            for u in got.get("urls") or [got.get("url")]:
                if u:
                    candidates.extend(_resolve_one(u))

            file_urls = [
                c
                for c in candidates
                if not re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", c)
            ]
            if file_urls:
                thumb = make_thumbnail_b64(movie["banner"].get("backdrop") or movie["banner"].get("poster") or movie["details"].get("poster", ""))
                return {
                    "success": True,
                    "title": title,
                    "year": movie["details"].get("year"),
                    "poster": movie["banner"].get("poster") or movie["details"].get("poster", ""),
                    "backdrop": movie["banner"].get("backdrop") or movie["details"].get("backdrop", ""),
                    "thumbnail_b64": thumb,
                    "description": movie.get("description") or movie["details"].get("description", ""),
                    "quality": entry.get("quality") or requested_quality,
                    "size_text": entry.get("size_text"),
                    "direct_url": file_urls[0],
                }

            tg_cand = [c for c in candidates if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", c)]
            if tg_cand:
                thumb = make_thumbnail_b64(movie["banner"].get("backdrop") or movie["banner"].get("poster") or movie["details"].get("poster", ""))
                return {
                    "success": True,
                    "title": title,
                    "poster": movie["banner"].get("poster") or movie["details"].get("poster", ""),
                    "backdrop": movie["banner"].get("backdrop") or movie["details"].get("backdrop", ""),
                    "thumbnail_b64": thumb,
                    "description": movie.get("description") or movie["details"].get("description", ""),
                    "quality": entry.get("quality") or requested_quality or "720p",
                    "size_text": entry.get("size_text", ""),
                    "direct_url": tg_cand[0],
                    "is_telegram": True,
                }
        except Exception as e:
            last_error = str(e)
            continue

    if _depth == 0:
        clean_name = movie.get("details", {}).get("title") or movie_url.rstrip("/").split("/")[-1].replace("-", " ")
        clean_name = re.sub(r"(sinhala\s*subtitles?|සිංහල\s*උපසිරැසි.*|\b(19\d\d|20\d\d)\b)", "", clean_name, flags=re.I).strip()
        if clean_name:
            try:
                from sinhalasub_resolver import search_sinhalasub, resolve_sinhalasub_movie
                sh_cands = search_sinhalasub(clean_name)
                if sh_cands:
                    res = resolve_sinhalasub_movie(sh_cands[0]["url"], requested_quality)
                    if res.get("success"):
                        res["fallback_from"] = "CineSubz"
                        return res
            except Exception:
                pass

    return {"error": last_error, "movie": movie}



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="CineSubz movie / episode / TV series URL or Google Drive URL")
    ap.add_argument("--quality", default=None, help="Target quality (e.g. 1080p, 720p)")
    ap.add_argument(
        "--episodes",
        action="store_true",
        help="List all episodes of a TV series page instead of resolving a download",
    )
    ap.add_argument(
        "--download-gdrive",
        dest="download_output",
        default=None,
        help="Download Google Drive cartoon/movie directly to specified output file path",
    )
    args = ap.parse_args()

    # Direct Google Drive downloader using gdown
    if args.download_output:
        file_id = None
        folder_id = None
        g_res = {}

        m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", args.url)
        if m_id:
            file_id = m_id.group(1)
        else:
            m_f = re.search(r"/folders/([a-zA-Z0-9_-]+)", args.url)
            if m_f:
                folder_id = m_f.group(1)
            else:
                try:
                    from gdrive_resolver import resolve_gdrive_movie
                    g_res = resolve_gdrive_movie(args.url, args.quality) or {}
                    file_id = g_res.get("gdrive_id") or g_res.get("file_id")
                    folder_id = g_res.get("folder_id")
                    if not file_id and g_res.get("direct_url"):
                        m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", g_res["direct_url"])
                        if m_id:
                            file_id = m_id.group(1)
                        else:
                            m_f = re.search(r"/folders/([a-zA-Z0-9_-]+)", g_res["direct_url"])
                            if m_f:
                                folder_id = m_f.group(1)
                except Exception:
                    pass

        # Handle Folder download via gdown (list files quickly and select target video)
        if folder_id and not file_id:
            try:
                import gdown
                folder_url = f"https://drive.google.com/drive/folders/{folder_id}"
                files = gdown.download_folder(url=folder_url, skip_download=True, quiet=True)
                if files:
                    v_files = [f for f in files if any(f.path.lower().endswith(ext) for ext in [".mp4", ".mkv", ".avi"])]
                    chosen_f = v_files[0] if v_files else files[0]
                    file_id = chosen_f.id
            except Exception:
                pass

        # Direct file ID download via gdown
        if file_id:
            try:
                import gdown
                res = gdown.download(id=file_id, output=args.download_output, quiet=False)
                if res and os.path.exists(args.download_output) and os.path.getsize(args.download_output) > 5000000:
                    print(json.dumps({"success": True, "path": args.download_output, "size": os.path.getsize(args.download_output)}))
                    return
            except Exception as dl_err:
                pass

        # Fallback: stream direct_url (e.g. Cloudflare R2 or direct CDN stream)
        if g_res and g_res.get("direct_url") and g_res["direct_url"].startswith("http"):
            try:
                try:
                    from fast_downloader import parallel_download
                    ok = parallel_download(g_res["direct_url"], args.download_output, 8)
                    if ok and os.path.exists(args.download_output) and os.path.getsize(args.download_output) > 5000000:
                        print(json.dumps({"success": True, "path": args.download_output, "size": os.path.getsize(args.download_output)}))
                        return
                except Exception:
                    pass

                req = urllib.request.Request(g_res["direct_url"], headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=120) as resp, open(args.download_output, "wb") as out_f:
                    while True:
                        chunk = resp.read(2 * 1024 * 1024)
                        if not chunk:
                            break
                        out_f.write(chunk)
                if os.path.exists(args.download_output) and os.path.getsize(args.download_output) > 5000000:
                    print(json.dumps({"success": True, "path": args.download_output, "size": os.path.getsize(args.download_output)}))
                    return
            except Exception as s_err:
                pass

        print(json.dumps({"success": False, "error": "Could not identify Google Drive file or folder from URL"}))
        return

    if args.episodes:
        # Check if Anime Series from local json first!
        try:
            from gdrive_resolver import get_anime_series_episodes
            anime_series_data = get_anime_series_episodes(args.url)
            if anime_series_data and anime_series_data.get("episodes"):
                print(json.dumps(anime_series_data, ensure_ascii=False, indent=2))
                return
        except Exception:
            pass

        # Check if SinhalaSub TV Series
        if "sinhalasub" in args.url:
            try:
                from sinhalasub_resolver import get_sinhalasub_series_episodes
                sh_series = get_sinhalasub_series_episodes(args.url)
                if sh_series.get("episodes"):
                    print(json.dumps(sh_series, ensure_ascii=False, indent=2))
                    return
            except Exception:
                pass

        # If an individual episode URL was given (e.g. /episodes/show-1x1/), discover parent series page
        if "/episodes/" in args.url:
            try:
                ep_body, _, _ = http_get(args.url)
                ep_html = ep_body.decode("utf-8", "replace")
                all_parents = re.findall(
                    r'href=["\']((?:https?://[^"\']*)?/(?:tvshows|series)/[^/"\'\?]+/?)[^"\']*["\']',
                    ep_html,
                    re.I,
                )
                for p_cand in all_parents:
                    p_url = urllib.parse.urljoin(args.url, p_cand.strip())
                    if p_url.rstrip("/").endswith(("/tvshows", "/series", "/feed")):
                        continue
                    p_data = scrape_movie(p_url)
                    if p_data.get("episodes"):
                        p_title = p_data["details"].get("title")
                        if not p_title or p_title.strip().lower() in ("series", "tv series", "movie"):
                            slug = p_url.rstrip("/").split("/")[-1]
                            slug = re.sub(r"-(?:tv-)?series$", "", slug, flags=re.I)
                            p_title = slug.replace("-", " ").title()
                        out = {
                            "success": True,
                            "title": p_title or "TV Series",
                            "poster": p_data["banner"].get("poster"),
                            "backdrop": p_data["banner"].get("backdrop") or p_data["banner"].get("poster"),
                            "episodes": p_data.get("episodes") or [],
                        }
                        print(json.dumps(out, ensure_ascii=False, indent=2))
                        return
            except Exception:
                pass

            # Fallback: derive series slug directly from episode URL
            try:
                ep_slug = args.url.rstrip("/").split("/")[-1]
                s_slug = re.sub(r"[-_](?:s?\d+[-_]?e\d+|\d+x\d+|episode[-_]?\d+).*", "", ep_slug, flags=re.I)
                if s_slug and s_slug != ep_slug:
                    for cand_slug in (f"{s_slug}-tv-series", s_slug):
                        cand_url = f"https://cinesubz.lk/tvshows/{cand_slug}/"
                        try:
                            cand_data = scrape_movie(cand_url)
                            if cand_data.get("episodes"):
                                c_title = cand_data["details"].get("title") or s_slug.replace("-", " ").title()
                                out = {
                                    "success": True,
                                    "title": c_title,
                                    "poster": cand_data["banner"].get("poster"),
                                    "backdrop": cand_data["banner"].get("backdrop") or cand_data["banner"].get("poster"),
                                    "episodes": cand_data.get("episodes") or [],
                                }
                                print(json.dumps(out, ensure_ascii=False, indent=2))
                                return
                        except Exception:
                            pass
            except Exception:
                pass

        data = scrape_movie(args.url)
        s_title = data["details"].get("title")
        if not s_title or s_title.strip().lower() in ("series", "tv series", "movie"):
            slug = args.url.rstrip("/").split("/")[-1]
            slug = re.sub(r"-(?:tv-)?series$", "", slug, flags=re.I)
            s_title = slug.replace("-", " ").title()
        out = {
            "success": bool(data.get("episodes")),
            "title": s_title or "Series",
            "poster": data["banner"].get("poster"),
            "backdrop": data["banner"].get("backdrop") or data["banner"].get("poster"),
            "episodes": data.get("episodes") or [],
        }

        # If still no episodes on episode URL, treat single episode as season 1 ep 1
        if not out["episodes"] and "/episodes/" in args.url:
            ep_title = data["details"].get("title") or args.url.rstrip("/").split("/")[-1].replace("-", " ")
            out["success"] = True
            out["episodes"] = [{"season": 1, "episode": 1, "title": ep_title, "url": args.url}]

        if not out["episodes"]:
            # If CineSubz returned 0 episodes, try SinhalaSub search fallback
            clean_title = data["details"].get("title") or args.url.rstrip("/").split("/")[-1].replace("-", " ")
            clean_title = re.sub(r"(sinhala\s*subtitles?|සිංහල\s*උපසිරැසි.*|\b(19\d\d|20\d\d)\b)", "", clean_title, flags=re.I).strip()
            if clean_title:
                try:
                    from sinhalasub_resolver import search_sinhalasub, get_sinhalasub_series_episodes
                    cands = search_sinhalasub(clean_title)
                    for cand in cands:
                        if "/tvshows/" in cand["url"]:
                            fb_eps = get_sinhalasub_series_episodes(cand["url"])
                            if fb_eps.get("episodes"):
                                print(json.dumps(fb_eps, ensure_ascii=False, indent=2))
                                return
                except Exception:
                    pass
            out["error"] = "No episodes found on this page"
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    # Handle Google Drive, Anime & Sinhala Dubbed Cartoons directly (only if not a CineSubz URL)
    is_cinesubz = "cinesubz" in args.url or "/zt-links/" in args.url or "/episodes/" in args.url
    is_gdrive_or_anime = (
        not is_cinesubz
        and (
            "drive.google.com" in args.url
            or "animekaizen" in args.url
            or "cartoons" in args.url
            or "lakvision" in args.url
            or "slanimeclub" in args.url
            or "animeclub" in args.url
        )
    )

    if is_gdrive_or_anime:
        try:
            from gdrive_resolver import resolve_gdrive_movie
        except ImportError:
            sys.path.insert(0, os.path.dirname(__file__))
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
            from gdrive_resolver import resolve_gdrive_movie

        result = resolve_gdrive_movie(args.url, args.quality)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    result = resolve_direct_link(args.url, args.quality)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
