#!/usr/bin/env python3
"""
SinhalaSub.LK Resolver & Fallback Engine for FilmFeed Bot
Provides direct high-speed mp4 resolution and search fallback when CineSubz is unavailable.
"""

import io
import json
import re
import sys
import time
import base64
import urllib.parse
from bs4 import BeautifulSoup
import requests

BASE = "https://sinhalasub.lk"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
FINAL_LINK_RE = re.compile(r"var\s+zluFinalLink\s*=\s*['\"](.*?)['\"]\s*;")

session = requests.Session()
session.headers.update({
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE + "/",
})


def http_get(url: str, tries: int = 3, timeout: int = 15) -> str:
    for attempt in range(1, tries + 1):
        try:
            resp = session.get(url, timeout=timeout)
            if resp.status_code == 200:
                return resp.text
        except Exception:
            if attempt == tries:
                return ""
            time.sleep(0.5 * attempt)
    return ""


def make_thumbnail_b64(image_url: str) -> str:
    if not image_url or not image_url.startswith("http"):
        return ""
    try:
        from PIL import Image
        fast_url = re.sub(r"/t/p/(original|w\d+)/", "/t/p/w300/", image_url)
        r = session.get(fast_url, timeout=8)
        if r.status_code != 200:
            return ""
        im = Image.open(io.BytesIO(r.content))
        im.thumbnail((250, 250))
        if im.mode != "RGB":
            im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=75, optimize=True)
        raw = out.getvalue()
        if len(raw) < 32768:
            return base64.b64encode(raw).decode("ascii")
    except Exception:
        pass
    return ""


def search_sinhalasub(query: str) -> list:
    """Search sinhalasub.lk for query and return movie list."""
    clean_query = re.sub(r"\s*\(?\d{4}\)?", "", query).strip()
    clean_query = re.sub(r"[^a-zA-Z0-9\s]", " ", clean_query).strip()
    search_url = f"{BASE}/?s={urllib.parse.quote_plus(clean_query)}"
    
    html = http_get(search_url)
    if not html:
        return []
        
    soup = BeautifulSoup(html, "html.parser")
    results = []
    seen = set()
    
    for item in soup.select(".display-item, .item-box, article, .item"):
        a = item.find("a", href=True)
        if not a:
            continue
        href = a["href"].strip()
        if not re.search(r"/(movies|tvshows)/", href) or href.endswith(("/movies/", "/tvshows/")):
            continue
        if href in seen:
            continue
        seen.add(href)
        
        h3 = item.find("h3") or item.find(".title")
        title = h3.get_text(" ", strip=True) if h3 else (a.get("title") or "Movie")
        img = item.find("img")
        poster = (img.get("data-src") or img.get("data-original") or img.get("src") or "").strip() if img else ""
        results.append({
            "title": title,
            "url": href,
            "poster": poster,
        })
    return results


def resolve_sinhalasub_movie(movie_url: str, requested_quality: str = None) -> dict:
    """Scrape a sinhalasub.lk movie page and resolve direct CDN mp4 link."""
    html = http_get(movie_url)
    if not html:
        return {"error": "Failed to fetch sinhalasub movie page"}
        
    soup = BeautifulSoup(html, "html.parser")
    
    # Title & Poster
    title_el = soup.select_one(".details-title h3") or soup.select_one("h1")
    title = title_el.get_text(" ", strip=True) if title_el else "Movie"
    
    poster = ""
    p_img = soup.select_one("img.poster-img")
    if p_img:
        poster = (p_img.get("src") or "").strip()
    if not poster:
        og = soup.find("meta", attrs={"property": "og:image"})
        if og and og.get("content"):
            poster = og["content"].strip().split("?")[0]
            
    # Scale poster to TMDB HD
    poster = re.sub(r"/t/p/w\d+/", "/t/p/w780/", poster)
    backdrop = poster
    
    year = ""
    for p in soup.select(".details-info p"):
        if "Year" in p.get_text():
            ym = re.search(r"\b(19\d\d|20\d\d)\b", p.get_text())
            if ym:
                year = ym.group(1)
                break
                
    desc_el = soup.select_one(".details-desc")
    description = ""
    if desc_el:
        for bad in desc_el.select("script, style"):
            bad.decompose()
        description = re.sub(r"\s+", " ", desc_el.get_text(" ", strip=True)).strip()

    # Find download links
    link_rows = []
    for table in soup.select("#links table.links-table"):
        server = (table.get("id") or "").strip()
        for tr in table.select("tbody tr"):
            a = tr.select_one("td .link-opt a[href]")
            if not a:
                continue
            short_url = urllib.parse.urljoin(BASE, a["href"].strip())
            q_cell = tr.select_one("td span.quality") or (tr.select("td")[1] if len(tr.select("td")) > 1 else None)
            quality = q_cell.get_text(" ", strip=True) if q_cell else "720p"
            size_cell = tr.select("td")[-1].get_text(" ", strip=True) if tr.select("td") else ""
            
            link_rows.append({
                "short_url": short_url,
                "quality": quality,
                "size_label": size_cell,
                "server": server
            })
            
    if not link_rows:
        return {"error": "No download links found on sinhalasub page", "title": title}
        
    # Pick target quality
    target_row = None
    if requested_quality:
        rq = requested_quality.lower().strip()
        for r in link_rows:
            if rq in r["quality"].lower() or rq in r["size_label"].lower():
                target_row = r
                break
                
    if not target_row:
        target_row = link_rows[0]
        
    # Unlock short link to get zluFinalLink
    short_page = http_get(target_row["short_url"])
    if not short_page:
        return {"error": "Failed to fetch link unlocker page"}
        
    m = FINAL_LINK_RE.search(short_page)
    if not m:
        return {"error": "zluFinalLink not found in unlocker page"}
        
    direct_url = m.group(1).strip()
    if "pixeldrain.com/u/" in direct_url:
        direct_url = direct_url.replace("pixeldrain.com/u/", "pixeldrain.com/api/file/")
    if "pixeldrain.com/api/file/" in direct_url and "?download" not in direct_url:
        direct_url += "?download"
        
    resolved_quality = target_row["quality"] or requested_quality or "720p"
    thumb_b64 = make_thumbnail_b64(backdrop or poster)
    
    return {
        "success": True,
        "source": "sinhalasub.lk",
        "title": title,
        "year": year,
        "poster": poster,
        "backdrop": backdrop,
        "thumbnail_b64": thumb_b64,
        "description": description,
        "quality": resolved_quality,
        "size_text": target_row["size_label"],
        "direct_url": direct_url
    }


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = sys.argv[1]
        quality = sys.argv[2] if len(sys.argv) > 2 else "720p"
        if target.startswith("http"):
            res = resolve_sinhalasub_movie(target, quality)
        else:
            search_res = search_sinhalasub(target)
            if search_res:
                res = resolve_sinhalasub_movie(search_res[0]["url"], quality)
            else:
                res = {"error": f"No movie found on sinhalasub for '{target}'"}
        print(json.dumps(res, indent=2))
