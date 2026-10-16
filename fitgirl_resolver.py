#!/usr/bin/env python3
"""
FilmFeed FitGirl Repacks Game Resolver
Parses FitGirl game posts, extracts multipart RAR mirrors, and resolves download URLs.
"""

import sys
import os
import json
import re
import html
import urllib.request
import urllib.parse
from typing import Optional, List, Dict, Any

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
SKIP_KEYWORDS = ["upcoming repacks", "all my repacks", "donation", "support fitgirl"]


def clean_html(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def fetch_json(url: str, params: Optional[dict] = None) -> Any:
    full_url = url
    if params:
        full_url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full_url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8", errors="ignore"))


def parse_game_post(post: dict) -> Optional[dict]:
    title_raw = post.get("title", {}).get("rendered", "")
    title = clean_html(title_raw)

    if any(k in title.lower() for k in SKIP_KEYWORDS):
        return None

    content = post.get("content", {}).get("rendered", "")
    link = post.get("link", "")
    date = (post.get("date", "") or "")[:10]

    # Poster image
    poster = ""
    m_img = re.search(r'<img[^>]*class="[^"]*alignleft[^"]*"[^>]*src="([^"]+)"', content)
    if not m_img:
        m_img = re.search(r'<img[^>]*src="([^"]+)"', content)
    if m_img:
        poster = m_img.group(1)

    # Repack size & original size
    repack_size = ""
    rs = re.search(r"Repack Size:.*?<strong>(.*?)</strong>", content, re.DOTALL | re.IGNORECASE)
    if rs:
        repack_size = clean_html(rs.group(1))

    original_size = ""
    os_m = re.search(r"Original Size[:\s]*(?:<strong>)?([^<]+)", content, re.IGNORECASE)
    if os_m:
        original_size = clean_html(os_m.group(1)).strip(", ")

    # Extract all archive links
    ff_links = re.findall(r'href="(https://fuckingfast\.co/[^"]+)"', content)
    dn_links = re.findall(r'href="(https://datanodes\.to/[^"]+)"', content)
    fk_links = re.findall(r'href="(https://filekeeper\.net/[^"]+)"', content)

    # Filter for .partN.rar core files
    def filter_core(links: List[str]) -> List[str]:
        core = [l for l in links if ".part" in l.lower() and ".rar" in l.lower()]
        return core if core else links

    ff_core = filter_core(ff_links)
    dn_core = filter_core(dn_links)
    fk_core = filter_core(fk_links)

    # Build part list based on available mirrors
    chosen_mirror = "fuckingfast"
    chosen_links = ff_core
    if not chosen_links or len(chosen_links) == 0:
        chosen_mirror = "datanodes"
        chosen_links = dn_core
    if not chosen_links or len(chosen_links) == 0:
        chosen_mirror = "filekeeper"
        chosen_links = fk_core

    parts = []
    for idx, l in enumerate(chosen_links, start=1):
        filename = f"Part_{idx:02d}.rar"
        # Try extracting real filename from hash or url
        if "#" in l:
            filename = l.split("#")[-1]
        elif "/" in l:
            cand = l.split("/")[-1]
            if ".rar" in cand.lower():
                filename = cand
        parts.append({
            "part": idx,
            "filename": filename,
            "url": l,
        })

    return {
        "success": True,
        "id": post.get("id"),
        "title": title,
        "url": link,
        "date": date,
        "poster": poster,
        "repack_size": repack_size or "500MB Parts",
        "original_size": original_size,
        "preferred_mirror": chosen_mirror,
        "total_parts": len(parts),
        "parts": parts,
        "mirrors": {
            "fuckingfast": ff_core,
            "datanodes": dn_core,
            "filekeeper": fk_core,
        }
    }


def resolve_fitgirl(query_or_url: str) -> dict:
    try:
        # Check if URL with slug or post ID
        slug_match = re.search(r"fitgirl-repacks\.site/([^/?#]+)/?", query_or_url)
        slug = slug_match.group(1) if slug_match else None

        if slug:
            posts = fetch_json("https://fitgirl-repacks.site/wp-json/wp/v2/posts", {"slug": slug})
            if posts and len(posts) > 0:
                parsed = parse_game_post(posts[0])
                if parsed:
                    return parsed

        # Search by query
        clean_query = query_or_url
        if "fitgirl-repacks.site" in clean_query:
            clean_query = re.sub(r"https?://fitgirl-repacks\.site/?", "", clean_query)
            clean_query = clean_query.replace("-", " ").strip("/ ")

        posts = fetch_json("https://fitgirl-repacks.site/wp-json/wp/v2/posts", {
            "search": clean_query,
            "per_page": 5,
        })
        for p in posts:
            res = parse_game_post(p)
            if res and res["total_parts"] > 0:
                return res

        return {"success": False, "error": f"No game repack or RAR parts found for: {query_or_url}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: fitgirl_resolver.py <url_or_search>"}))
        sys.exit(1)

    target = sys.argv[1].strip()
    result = resolve_fitgirl(target)
    print(json.dumps(result, ensure_ascii=False))
