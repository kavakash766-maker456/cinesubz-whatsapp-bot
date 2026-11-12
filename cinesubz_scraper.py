"""
CineSubz.lk Scraper
Handles movie/TV series scraping: search, details, posters, descriptions,
and one-click direct download link resolution.
"""

import base64
import hashlib
import html as html_module
import os
import re
import socket
import sys
import time
import urllib.parse

# Force IPv4 socket resolution to prevent broken IPv6 timeouts on GitHub Actions and cloud runners
try:
    _orig_getaddrinfo = socket.getaddrinfo
    def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _ipv4_getaddrinfo
except Exception:
    pass

# Prefer curl_cffi for Cloudflare TLS impersonation; fallback to requests
try:
    from curl_cffi import requests
    _USE_CURL = True
except ImportError:
    import requests
    _USE_CURL = False

from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = "https://cinesubz.lk"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TIMEOUT = 25
MAX_RETRIES = 2

# ---------------------------------------------------------------------------
# HTTP Session
# ---------------------------------------------------------------------------
_session = None


def _get_session():
    global _session
    if _session is None:
        if _USE_CURL:
            _session = requests.Session(impersonate="chrome124")
        else:
            _session = requests.Session()
        _session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE_URL + "/",
            "Connection": "keep-alive",
        })
    return _session


def http_get(url, **kwargs):
    """Fetch a URL with retries and redirect handling."""
    if url and "cinesubz." in url:
        url = re.sub(r"https?://(www\.)?cinesubz\.(?:net|co|com|org)", "https://cinesubz.lk", url)
    sess = _get_session()
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = sess.get(url, timeout=TIMEOUT, allow_redirects=True, **kwargs)
            if resp.status_code == 200:
                return resp.text, str(resp.url)
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location", "")
                if loc:
                    return http_get(urllib.parse.urljoin(url, loc))
        except Exception:
            if attempt == MAX_RETRIES:
                break
            time.sleep(0.5)
    return "", url


# ---------------------------------------------------------------------------
# Crypto helpers — CryptoJS-compatible AES decryption
# ---------------------------------------------------------------------------
def _evp_kdf(password, salt, key_len=32, iv_len=16):
    """OpenSSL EVP key derivation (CryptoJS compatible)."""
    total = b""
    d = b""
    while len(total) < key_len + iv_len:
        d = hashlib.md5(d + password + salt).digest()
        total += d
    return total[:key_len], total[key_len:key_len + iv_len]


def _aes_cbc_decrypt(key, iv, ciphertext):
    """AES-256-CBC decryption using the cryptography library."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    pad = plaintext[-1]
    if 1 <= pad <= 16 and plaintext.endswith(bytes([pad]) * pad):
        plaintext = plaintext[:-pad]
    return plaintext


def cryptojs_decrypt(b64_data, passphrase):
    """Decrypt a CryptoJS-encrypted string (Salted__ format)."""
    raw = base64.b64decode(b64_data)
    if raw[:8] == b"Salted__":
        salt = raw[8:16]
        body = raw[16:]
    else:
        salt = b""
        body = raw
    key, iv = _evp_kdf(passphrase.encode(), salt)
    plaintext = _aes_cbc_decrypt(key, iv, body)
    return plaintext.decode("utf-8", errors="ignore")


def unwrap_url(encrypted_blob, candidates):
    """Try a list of passphrases against an encrypted blob to find a direct URL."""
    for pw in candidates:
        try:
            plain = cryptojs_decrypt(encrypted_blob, pw).strip()
        except Exception:
            continue
        if plain.startswith("http://") or plain.startswith("https://"):
            return plain
        try:
            decoded = base64.b64decode(plain, validate=True).decode("utf-8")
            if decoded.startswith("http"):
                return decoded
        except Exception:
            pass
        if any(ext in plain.lower() for ext in (".mp4", ".mkv", "pixeldrain", "cloudflarestorage", "supercloud")):
            return plain
    return None


# ---------------------------------------------------------------------------
# Protobuf parsing — download-data response
# ---------------------------------------------------------------------------
def _read_varint(buf, i):
    result = 0
    shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7


def parse_protobuf_download(buf):
    """Parse protobuf DownloadData { string url = 1; string error = 2; }"""
    i = 0
    fields = {}
    while i < len(buf):
        tag, i = _read_varint(buf, i)
        field_num = tag >> 3
        wire_type = tag & 7
        if wire_type == 2:  # length-delimited
            length, i = _read_varint(buf, i)
            fields[field_num] = buf[i:i + length].decode("utf-8", "replace")
            i += length
        elif wire_type == 0:  # varint
            fields[field_num], i = _read_varint(buf, i)
        else:
            break
    return fields.get(1, ""), fields.get(2, "")


# ---------------------------------------------------------------------------
# Page title cleaning
# ---------------------------------------------------------------------------
def clean_title(raw):
    if not raw:
        return ""
    title = html_module.unescape(raw).strip()
    title = re.sub(r"\s*[-|–—•]\s*CineSubz(?:\.(?:lk|net|co|com|org))?\b.*$", "", title, flags=re.I)
    title = re.sub(r"^cinesubz(?:\.(?:lk|net|co|com|org))?\s*[-|–—•]\s*", "", title, flags=re.I)
    title = re.sub(r"\s*[-|–—•]\s*(?:සිංහල\s*උපසිරැසි.*|sinhala\s*subtitles?|sinhala\s*sub)\b.*$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip()


# ---------------------------------------------------------------------------
# Core Scraper
# ---------------------------------------------------------------------------
class CineSubzScraper:

    # -- Search ----------------------------------------------------------

    def search(self, query):
        """Search CineSubz for movies/TV shows. Returns list of results."""
        search_url = f"{BASE_URL}/?s={urllib.parse.quote_plus(query)}"
        page_html, _ = http_get(search_url)
        if not page_html:
            return []
        soup = BeautifulSoup(page_html, "lxml")

        results = []
        seen = set()

        for item in soup.select(".display-item, .item-box, article, .item, .post"):
            a = item.find("a", href=True)
            if not a:
                continue
            href = a["href"].strip()
            if not re.search(r"/(movies|tvshows|series)/", href):
                continue
            if href.endswith(("/movies/", "/tvshows/", "/series/")):
                continue
            if href in seen:
                continue
            seen.add(href)

            h3 = item.find("h3") or item.find(class_="title")
            title = h3.get_text(" ", strip=True) if h3 else (a.get("title") or "Untitled")
            title = clean_title(title)

            img = item.find("img")
            poster = ""
            if img:
                poster = (img.get("data-src") or img.get("data-original")
                          or img.get("src") or "").strip()

            is_series = "/tvshows/" in href or "/series/" in href

            text = item.get_text(" ", strip=True)
            year_match = re.search(r"\b(19\d{2}|20\d{2})\b", text)
            year = year_match.group(1) if year_match else None

            rating_match = re.search(r"★\s*([\d.]+)", text)
            rating = float(rating_match.group(1)) if rating_match else None

            results.append({
                "title": title,
                "url": href,
                "poster": poster,
                "year": year,
                "rating": rating,
                "is_series": is_series,
            })

        return results

    # -- Scrape latest ---------------------------------------------------

    def scrape_latest(self, page=1):
        """Scrape the homepage / latest movies listing."""
        url = f"{BASE_URL}/page/{page}/" if page > 1 else BASE_URL
        page_html, _ = http_get(url)
        if not page_html:
            return []
        soup = BeautifulSoup(page_html, "lxml")

        results = []
        seen = set()

        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if not re.search(r"/(movies|tvshows|series)/", href):
                continue
            if href.endswith(("/movies/", "/tvshows/", "/series/")):
                continue
            if href in seen:
                continue
            seen.add(href)

            img = a.find("img")
            poster = ""
            if img:
                poster = (img.get("data-src") or img.get("data-original")
                          or img.get("src") or "").strip()

            title_text = ""
            h = a.find(["h2", "h3", "h4"])
            if h:
                title_text = h.get_text(" ", strip=True)
            if not title_text:
                title_text = a.get("title") or a.get_text(" ", strip=True)
            title_text = clean_title(title_text)

            if title_text and title_text not in [r["title"] for r in results]:
                is_series = "/tvshows/" in href or "/series/" in href
                results.append({
                    "title": title_text,
                    "url": href,
                    "poster": poster,
                    "is_series": is_series,
                })

        return results

    # -- Movie / Episode page --------------------------------------------

    def get_movie(self, url, resolve_downloads=False):
        """
        Scrape a movie or episode page for full details.
        Returns dict with title, year, poster, description, downloads, episodes.
        """
        page_html, final_url = http_get(url)
        if not page_html:
            return {"error": "Failed to fetch page", "url": url}
        soup = BeautifulSoup(page_html, "lxml")

        # --- Title ---
        title = ""
        title_el = soup.select_one(".details-title h3") or soup.select_one(".details-title")
        if not title_el:
            title_el = soup.select_one("h1.entry-title") or soup.find("h1")
        if title_el:
            title = clean_title(title_el.get_text(" ", strip=True))
        if not title:
            og = soup.find("meta", attrs={"property": "og:title"})
            if og:
                title = clean_title(og.get("content", ""))
        if not title:
            t_tag = soup.find("title")
            if t_tag:
                title = clean_title(t_tag.get_text(strip=True))
        if not title:
            slug = final_url.rstrip("/").split("/")[-1].replace("-", " ")
            title = clean_title(slug).title()

        # --- Poster ---
        poster = ""
        p_img = soup.select_one("img.poster-img")
        if p_img:
            poster = (p_img.get("src") or "").strip()
        if not poster:
            og_img = soup.find("meta", attrs={"property": "og:image"})
            if og_img:
                poster = og_img.get("content", "").strip().split("?")[0]
        if not poster:
            splash = soup.select_one(".splash-bg img")
            if splash:
                poster = (splash.get("src") or "").strip()

        # --- Backdrop ---
        backdrop = ""
        splash = soup.select_one(".splash-bg img")
        if splash:
            backdrop = (splash.get("src") or "").strip()
        if not backdrop and poster:
            backdrop = poster

        # --- Year ---
        year = None
        year_match = re.search(r"\((\d{4})\)", title)
        if year_match:
            year = int(year_match.group(1))
        else:
            for p in soup.select(".details-info p, .data-year, .year, .release-year"):
                ym = re.search(r"\b(19\d{2}|20\d{2})\b", p.get_text())
                if ym:
                    year = int(ym.group(1))
                    break

        # --- Quality ---
        quality = ""
        q_el = soup.select_one(".data-quality")
        if q_el:
            quality = q_el.get_text(strip=True)

        # --- IMDb ---
        imdb = None
        imdb_el = soup.select_one(".data-imdb")
        if imdb_el:
            m = re.search(r"IMDb:\s*([\d.]+)", imdb_el.get_text())
            if m:
                imdb = float(m.group(1))
        if imdb is None:
            m = re.search(r"★\s*([\d.]+)", page_html)
            if m:
                imdb = float(m.group(1))

        # --- Description ---
        description = ""
        desc_el = (soup.select_one(".details-desc")
                   or soup.select_one(".entry-content")
                   or soup.select_one(".description"))
        if desc_el:
            for bad in desc_el.select("script, style"):
                bad.decompose()
            description = re.sub(r"\s+", " ", desc_el.get_text(" ", strip=True)).strip()
        if not description:
            og_desc = soup.find("meta", attrs={"property": "og:description"})
            if og_desc:
                description = og_desc.get("content", "").strip()
            if not description:
                meta_desc = soup.find("meta", attrs={"name": "description"})
                if meta_desc:
                    description = meta_desc.get("content", "").strip()

        # --- Download links ---
        downloads = self._parse_download_links(soup, final_url, page_html)

        # --- TV Series episodes ---
        episodes = self._parse_episodes(soup, final_url, page_html)

        result = {
            "title": title,
            "year": year,
            "poster": poster,
            "backdrop": backdrop,
            "quality": quality,
            "imdb": imdb,
            "description": description,
            "downloads": downloads,
            "episodes": episodes,
            "url": final_url,
        }

        if resolve_downloads and downloads:
            for d in downloads:
                d["direct_url"] = self.resolve_download_link(d["zt_url"])

        return result

    def _parse_download_links(self, soup, base_url, page_html):
        """Extract download link entries from a movie/episode page."""
        entries = []

        items = (soup.select(".movie-download-link-item")
                 or soup.select(".download-link-item"))

        for item in items:
            a = item.find("a", href=True)
            if not a:
                continue
            href = a["href"].strip()
            zt_url = urllib.parse.urljoin(base_url, href)

            type_el = (item.select_one(".movie-download-type")
                       or item.select_one(".download-type"))
            meta_el = (item.select_one(".movie-download-meta")
                       or item.select_one(".download-meta"))
            label = type_el.get_text(strip=True) if type_el else "Download"
            meta = meta_el.get_text(" ", strip=True) if meta_el else ""

            size_text = None
            m = re.search(r"([\d.]+)\s*(GB|MB|TB|KB)", meta, re.I)
            if m:
                size_text = m.group(0)

            bits = [b.strip() for b in meta.split("•")]
            quality = bits[0] if bits else ""

            entries.append({
                "label": label,
                "meta": meta,
                "quality": quality,
                "size_text": size_text,
                "zt_url": zt_url,
            })

        # Fallback: scan for any zt-links / api links
        if not entries:
            for a in soup.find_all("a", href=True):
                href = a["href"].strip()
                if "/zt-links/" in href or "/zt-" in href or "/api-" in href:
                    parent_text = a.parent.get_text(" ", strip=True) if a.parent else ""
                    m = re.search(r"([\d.]+)\s*(GB|MB|TB|KB)", parent_text, re.I)
                    size_text = m.group(0) if m else None
                    m_q = re.search(r"(1080p|720p|480p|360p|2160p|4K)", parent_text, re.I)
                    q_str = m_q.group(1) if m_q else "HD"
                    entries.append({
                        "label": a.get_text(strip=True) or "Direct Download",
                        "meta": parent_text,
                        "quality": q_str,
                        "size_text": size_text,
                        "zt_url": urllib.parse.urljoin(base_url, href),
                    })

        return entries

    def _parse_episodes(self, soup, base_url, page_html):
        """Extract TV series episodes from a series page."""
        episodes = []
        seen = set()

        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            cls = " ".join(a.get("class", []))
            if not href or "#respond" in href or "#comments" in href:
                continue
            href_clean = re.sub(r"[?#].*$", "", href).strip()
            if not href_clean or href_clean in seen:
                continue

            is_ep = ("episode-link" in cls or "/episodes/" in href_clean
                     or "episode" in cls)
            if not is_ep or href_clean.endswith("/episodes/"):
                continue

            ep_title_el = a.select_one(".ep-title")
            ep_title = ep_title_el.get_text(strip=True) if ep_title_el else a.get_text(strip=True)

            if ep_title.lower() in ("cancel", "next", "prev", "previous",
                                    "reply", "next episode", "prev episode", "home"):
                continue

            seen.add(href_clean)

            try:
                season = int(a.get("data-season") or 0)
            except (TypeError, ValueError):
                season = 0
            try:
                ep_num = int(a.get("data-episode") or 0)
            except (TypeError, ValueError):
                ep_num = 0

            if season == 0 or ep_num == 0:
                m_se = (re.search(r"[-_]s(\d+)e(\d+)", href_clean, re.I)
                        or re.search(r"(\d+)x(\d+)", href_clean, re.I)
                        or re.search(r"s(\d+)e(\d+)", ep_title, re.I)
                        or re.search(r"(\d+)x(\d+)", ep_title, re.I))
                if m_se:
                    if season == 0:
                        season = int(m_se.group(1))
                    if ep_num == 0:
                        ep_num = int(m_se.group(2))
                else:
                    m_s = re.search(r"season[-_]?(\d+)", href_clean, re.I)
                    m_e = re.search(r"episode[-_]?(\d+)", href_clean, re.I)
                    if m_s:
                        season = int(m_s.group(1))
                    if m_e:
                        ep_num = int(m_e.group(1))

            if season == 0:
                season = 1

            episodes.append({
                "season": season,
                "episode": ep_num,
                "title": ep_title or f"Episode {ep_num or len(episodes) + 1}",
                "url": urllib.parse.urljoin(base_url, href_clean),
            })

        episodes.sort(key=lambda x: (x["season"], x["episode"]))
        return episodes

    # -- Download link resolution -----------------------------------------

    def resolve_download_link(self, zt_url):
        """
        Resolve an intermediate zt-links URL to a direct download URL.
        Handles multiple redirect layers and CryptoJS-encrypted links.
        """
        if not zt_url:
            return None

        # Pixeldrain direct
        m_px = re.search(r"pixeldrain\.com/(?:u|api/file)/([a-zA-Z0-9_-]+)", zt_url)
        if m_px:
            return f"https://pixeldrain.com/api/file/{m_px.group(1)}?download"

        # Telegram
        if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", zt_url):
            return zt_url

        # Direct file URL — only if not a csplayer host
        if "csplayer" not in zt_url.lower() and any(ext in zt_url.lower() for ext in (".mp4", ".mkv", ".avi", ".zip", "cloudflarestorage.com")):
            return zt_url

        # Fetch the zt-links intermediate page
        try:
            page_html, _ = http_get(zt_url)
        except Exception:
            return None
        if not page_html:
            return None

        # Find <a id="link" href="...">
        m = (re.search(r'<a[^>]+id=["\']link["\'][^>]+href=["\']([^"\']+)["\']', page_html)
             or re.search(r'<a[^>]+href=["\']([^"\']+)["\'][^>]+id=["\']link["\']', page_html)
             or re.search(r'<a\s+id="link"\s+href="([^"]+)"', page_html))

        if not m:
            return None

        original_url = html.unescape(m.group(1).strip())
        mapped_url = self._map_zt_href(original_url, page_html)

        if re.match(r"https?://(www\.)?(telegram\.me|t\.me)/", mapped_url):
            return mapped_url

        # Direct file URL ONLY if not csplayer
        if "csplayer" not in mapped_url.lower():
            m_px = re.search(r"pixeldrain\.com/(?:u|api/file)/([a-zA-Z0-9_-]+)", mapped_url)
            if m_px:
                return f"https://pixeldrain.com/api/file/{m_px.group(1)}?download"
            if any(ext in mapped_url.lower() for ext in
                   (".mp4", ".mkv", ".avi", "cloudflarestorage.com", "supercloud", "kdrive", "workers.dev", "drive.google.com")):
                return mapped_url

        # Resolve through csplayer intermediate download page
        direct = self._resolve_csplayer(mapped_url)
        if direct:
            return direct
        if "csplayer" in mapped_url.lower():
            return None
        return mapped_url

    def _map_zt_href(self, original, zt_html):
        """Apply search/replace mappings found in the zt page's JavaScript."""
        mappings = []
        for mo in re.finditer(r"\{search:\[([^\]]+)\],replace:\"([^\"]+)\"\}", zt_html):
            searches = re.findall(r'"([^"]+)"', mo.group(1))
            mappings.append((searches, mo.group(2)))
        url = original
        for searches, repl in mappings:
            for s in searches:
                if s in url:
                    url = url.replace(s, repl)
                    return url
        return url

    def _resolve_csplayer(self, drive_url):
        """Resolve a csplayer intermediate URL through protobuf + AES decryption."""
        if not drive_url or "csplayer" not in drive_url.lower():
            if drive_url and any(ext in drive_url.lower() for ext in
                                (".mp4", ".mkv", "pixeldrain", "cloudflarestorage", "supercloud", "kdrive", "drive.google")):
                return drive_url
            return None

        try:
            import subprocess, json
            js_script = os.path.join(os.path.dirname(__file__), "csplayer_resolver.js")
            node_cmd = "node"
            res = subprocess.run([node_cmd, js_script, drive_url], capture_output=True, text=True, timeout=30)
            if res.returncode == 0 and res.stdout:
                json_match = re.search(r"\{[\s\S]*\}", res.stdout)
                if json_match:
                    data = json.loads(json_match.group(0))
                    if data.get("success") and data.get("direct_url"):
                        return data["direct_url"]
        except Exception:
            pass

        parts = urllib.parse.urlsplit(drive_url)
        host = f"{parts.scheme}://{parts.netloc}"
        path = parts.path
        sess = _get_session()

        # Session warmup - lightweight ping to establish cookies without buffering full media
        try:
            sess.get(f"{host}/", headers={"Referer": "https://cinesubz.lk/"}, timeout=6)
        except Exception:
            pass

        # Query the API for download data
        data = {}
        for _ in range(2):
            try:
                r = sess.get(
                    f"{host}/api/download-data{path}",
                    headers={"Accept": "application/json", "Referer": host + path},
                    timeout=12,
                )
                data = r.json()
                if data.get("redirect"):
                    break
            except Exception:
                time.sleep(0.5)

        if not data.get("redirect"):
            return None

        target = host + data["redirect"]

        # Fetch the download page
        page = ""
        for _ in range(2):
            try:
                r = sess.get(target, headers={"Referer": host + "/"}, timeout=12)
                page = r.text
                if "dl-links" in page:
                    break
            except Exception:
                time.sleep(0.5)

        if "dl-links" not in page:
            return None

        # Extract hex payloads
        payloads = []
        seen = set()
        for mo in re.finditer(r"'([0-9a-f]{300,})'", page):
            if mo.group(1) not in seen:
                seen.add(mo.group(1))
                payloads.append(mo.group(1))

        # Extract passphrase candidates
        candidates = sorted(
            {s for s in re.findall(r"'([A-Za-z0-9_\-]{4,24})'", page)
             if not s.startswith(("http", "div", "span", "imag", "butt"))},
            key=len,
        )

        resolved_files = []
        telegram_links = []

        # Try each payload
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

            blob, _ = parse_protobuf_download(raw)
            if not blob:
                continue

            final = unwrap_url(blob, candidates)
            if final:
                # Prioritize direct file links over telegram
                if any(ext in final.lower() for ext in (".mp4", ".mkv", "pixeldrain", "cloudflarestorage", "aws4", "kdrive", "supercloud")):
                    return final
                elif "telegram" in final.lower() or "t.me" in final.lower():
                    telegram_links.append(final)
                else:
                    resolved_files.append(final)

        if resolved_files:
            return resolved_files[0]
        if telegram_links:
            return telegram_links[0]
        return None

    # -- High-level convenience methods -----------------------------------

    def get_movie_details(self, url):
        return self.get_movie(url, resolve_downloads=True)

    def get_series(self, url):
        return self.get_movie(url, resolve_downloads=False)

    def get_episode(self, url, resolve=True):
        return self.get_movie(url, resolve_downloads=resolve)

    def search_and_get(self, query, index=0, quality=None):
        results = self.search(query)
        if not results:
            return {"error": f"No results found for '{query}'"}
        if index >= len(results):
            return {"error": f"Index {index} out of range ({len(results)} results)"}
        chosen = results[index]
        details = self.get_movie(chosen["url"], resolve_downloads=True)
        details["search_index"] = index
        details["total_results"] = len(results)
        if quality:
            details = self._filter_by_quality(details, quality)
        return details

    def _filter_by_quality(self, movie_data, quality):
        q = quality.lower().strip()
        q_num = q.rstrip("p")
        for d in movie_data.get("downloads", []):
            dq = (d.get("quality") or "").lower()
            meta = (d.get("meta") or "").lower()
            if q in dq or q in meta or (q_num and (q_num in dq or q_num in meta)):
                if not d.get("direct_url"):
                    d["direct_url"] = self.resolve_download_link(d["zt_url"])
                movie_data["preferred_download"] = d
                return movie_data
        if movie_data.get("downloads"):
            movie_data["preferred_download"] = movie_data["downloads"][0]
        return movie_data
