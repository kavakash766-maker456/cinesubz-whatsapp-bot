#!/usr/bin/env python3
"""
SinhalaSub.LK Resolver & Fallback Engine for FilmFeed Bot
Provides direct high-speed mp4 resolution and search fallback when CineSubz is unavailable.
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from bs4 import BeautifulSoup

BASE = "https://sinhalasub.lk"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
FINAL_LINK_RE = re.compile(r"var\s+zluFinalLink\s*=\s*['\"](.*?)['\"]\s*;")


def http_get(url: str, tries: int = 3, timeout: int = 20) -> str:
    headers = {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE + "/",
    }
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except Exception as exc:
            if attempt == tries:
                return ""
            time.sleep(1.0 * attempt)
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
    
    for a in soup.select("a[href*='/movies/']"):
        href = (a.get("href") or "").strip()
        m = re.match(r"https?://sinhalasub\.lk/movies/([a-z0-9\-]{4,})/?", href)
        if not m:
            continue
        slug = m.group(1)
        if slug in seen:
            continue
        seen.add(slug)
        
        title = (a.get("title") or "").strip()
        if not title:
            h3 = a.find(["h3", "span"])
            title = h3.get_text(" ", strip=True) if h3 else slug
            
        img = a.find("img")
        poster = (img.get("src") or img.get("data-original") or "").strip() if img else ""
        results.append({
            "title": title,
            "url": href,
            "poster": poster,
            "slug": slug
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
        
    resolved_quality = target_row["quality"] or requested_quality or "720p"
    
    return {
        "success": True,
        "source": "sinhalasub.lk",
        "title": title,
        "year": year,
        "poster": poster,
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
