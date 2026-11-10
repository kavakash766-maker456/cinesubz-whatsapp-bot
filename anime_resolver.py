#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FilmFeed Anime Engine - Fast Direct MP4 Scraper & Resolver
Targets: AnimeGG (High speed, unencrypted direct MP4 streams at 720p & 1080p)
"""

import sys
import os
import re
import json
import argparse
import httpx
from bs4 import BeautifulSoup
from urllib.parse import quote, unquote, urlparse

# Ensure UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = "https://www.animegg.org"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.animegg.org/"
}

def clean_text(text: str) -> str:
    if not text:
        return ""
    return re.sub(r"\s+", " ", text).strip()

def search_anime(query: str) -> list:
    """Search anime by keyword on AnimeGG."""
    url = f"{BASE_URL}/search/?q={quote(query)}"
    try:
        with httpx.Client(timeout=12.0) as client:
            resp = client.get(url, headers=HEADERS)
            if resp.status_code != 200:
                return []
            soup = BeautifulSoup(resp.text, "html.parser")
            results = []
            
            # Find series cards
            for card in soup.find_all("li", class_="mse"):
                a_tag = card.find("a", href=True)
                if not a_tag or "/series/" not in a_tag["href"]:
                    continue
                
                href = a_tag["href"].strip()
                slug = href.replace("/series/", "").strip("/")
                
                img_tag = card.find("img")
                poster = img_tag["src"] if img_tag and "src" in img_tag.attrs else ""
                if poster and not poster.startswith("http"):
                    poster = f"{BASE_URL}{poster}"
                
                title_tag = card.find("strong")
                title = clean_text(title_tag.text) if title_tag else clean_text(a_tag.text)
                
                # episode count or extra info
                info_tag = card.find("span")
                info = clean_text(info_tag.text) if info_tag else ""
                
                results.append({
                    "slug": slug,
                    "title": title,
                    "url": f"{BASE_URL}/series/{slug}",
                    "poster": poster,
                    "info": info
                })
            
            # Fallback if li.mse not found, check any a with /series/
            if not results:
                seen_slugs = set()
                for a in soup.find_all("a", href=True):
                    if "/series/" in a["href"]:
                        slug = a["href"].replace("/series/", "").strip("/")
                        if slug in seen_slugs or not slug:
                            continue
                        seen_slugs.add(slug)
                        results.append({
                            "slug": slug,
                            "title": clean_text(a.text) or slug.replace("-", " ").title(),
                            "url": f"{BASE_URL}/series/{slug}",
                            "poster": "",
                            "info": ""
                        })
            
            return results
    except Exception as e:
        sys.stderr.write(f"[ANIME SEARCH ERROR] {e}\n")
        return []

def _fetch_series_episodes_direct(slug: str) -> dict:
    """Internal helper to scrape series page directly."""
    url = f"{BASE_URL}/series/{slug}"
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(url, headers=HEADERS)
            if resp.status_code != 200:
                return {"success": False, "error": f"HTTP {resp.status_code}", "episodes": []}
            
            soup = BeautifulSoup(resp.text, "html.parser")
            
            # Metadata
            title = slug.replace("-", " ").title()
            if soup.title and soup.title.text:
                title = re.sub(r"^Watch\s+", "", soup.title.text, flags=re.I)
                title = re.sub(r"\s+Episodes.*$", "", title, flags=re.I).strip()
            
            poster = ""
            for img in soup.find_all("img"):
                src = img.get("src", "")
                if src and ("vidcache.net" in src or "poster" in src or "/static/" in src):
                    poster = src if src.startswith("http") else f"{BASE_URL}{src}"
                    break
            
            desc_div = soup.find("div", class_="desc") or soup.find("div", class_="sinopse")
            description = clean_text(desc_div.text) if desc_div else ""
            
            # Episodes
            episodes = []
            seen_numbers = set()
            
            # AnimeGG lists episodes in a list or tab
            for a in soup.find_all("a", href=True):
                href = a["href"].strip()
                if "-episode-" in href:
                    # extract episode number
                    m = re.search(r"-episode-(\d+)", href)
                    if not m:
                        continue
                    ep_num = int(m.group(1))
                    if ep_num in seen_numbers:
                        continue
                    seen_numbers.add(ep_num)
                    
                    ep_slug = href.strip("/")
                    ep_title = clean_text(a.text) or f"Episode {ep_num}"
                    episodes.append({
                        "episode": ep_num,
                        "title": ep_title,
                        "slug": ep_slug,
                        "url": f"{BASE_URL}/{ep_slug}" if not href.startswith("http") else href
                    })
            
            # Sort episodes ascending: 1, 2, 3...
            episodes.sort(key=lambda x: x["episode"])
            
            return {
                "success": True,
                "title": title,
                "slug": slug,
                "poster": poster,
                "description": description,
                "total_episodes": len(episodes),
                "episodes": episodes
            }
    except Exception as e:
        sys.stderr.write(f"[ANIME EPISODES ERROR] {e}\n")
        return {"success": False, "error": str(e), "episodes": []}

def get_series_episodes(slug: str) -> dict:
    """Fetch all episodes and metadata for an anime series with auto-search fallback."""
    clean = slug.strip()
    # Strip protocol and domain if full URL passed
    if "animegg.org" in clean:
        clean = clean.split("/series/")[-1].split("/")[0].strip()
    elif clean.startswith("http"):
        parts = [p for p in clean.rstrip("/").split("/") if p]
        clean = parts[-1] if parts else clean

    # Direct fetch attempt
    res = _fetch_series_episodes_direct(clean)
    if res.get("success") and len(res.get("episodes", [])) > 0:
        return res

    # Fallback: search AnimeGG if direct slug yields no episodes
    search_q = clean.replace("-", " ")
    sys.stderr.write(f"[ANIME RESOLVER] Direct slug '{clean}' had 0 episodes. Searching AnimeGG for '{search_q}'...\n")
    matches = search_anime(search_q)
    if matches:
        best_slug = matches[0]["slug"]
        sys.stderr.write(f"[ANIME RESOLVER] Best search match: '{best_slug}'. Fetching episodes...\n")
        res2 = _fetch_series_episodes_direct(best_slug)
        if res2.get("success") and len(res2.get("episodes", [])) > 0:
            return res2

    return res

def resolve_episode_mp4(episode_slug: str, quality_pref: str = "720p") -> dict:
    """Resolve direct MP4 link from an episode page via its embed videoSources."""
    ep_slug = episode_slug.strip("/")
    url = f"{BASE_URL}/{ep_slug}" if not ep_slug.startswith("http") else ep_slug
    
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(url, headers=HEADERS)
            if resp.status_code != 200:
                return {"success": False, "error": f"Episode page HTTP {resp.status_code}"}
            
            soup = BeautifulSoup(resp.text, "html.parser")
            
            # Extract embed iframes
            embed_ids = []
            for ifr in soup.find_all("iframe", src=True):
                src = ifr["src"]
                m = re.search(r"/embed/(\d+)", src)
                if m:
                    embed_ids.append(m.group(1))
            
            # Also check tab links data-id or href
            for a in soup.find_all("a"):
                data_id = a.get("data-id")
                if data_id and data_id.isdigit():
                    embed_ids.append(data_id)
            
            embed_ids = list(dict.fromkeys(embed_ids))
            if not embed_ids:
                return {"success": False, "error": "No embed player found on episode page"}
            
            # Try each embed to find videoSources
            sources = []
            for emb_id in embed_ids:
                emb_url = f"{BASE_URL}/embed/{emb_id}"
                emb_resp = client.get(emb_url, headers=HEADERS)
                if emb_resp.status_code != 200:
                    continue
                
                # Find var videoSources = [...]
                m = re.search(r"var\s+videoSources\s*=\s*(\[[\s\S]*?\]);", emb_resp.text)
                if not m:
                    continue
                
                raw_json = m.group(1)
                # Parse JavaScript object literal to standard JSON
                clean_json = re.sub(r"([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:", r'\1"\2":', raw_json)
                clean_json = re.sub(r":\s*'([^']*)'", r': "\1"', clean_json)
                
                try:
                    parsed_sources = json.loads(clean_json)
                    for s in parsed_sources:
                        file_path = s.get("file", "")
                        label = s.get("label", "unknown")
                        if file_path:
                            stream_url = file_path if file_path.startswith("http") else f"{BASE_URL}{file_path}"
                            sources.append({
                                "quality": label,
                                "url": stream_url,
                                "referer": f"{BASE_URL}/",
                                "is_mp4": ".mp4" in stream_url
                            })
                    if sources:
                        break
                except Exception as parse_err:
                    sys.stderr.write(f"[PARSE ERROR] {parse_err}\n")
                    continue
            
            if not sources:
                return {"success": False, "error": "No direct video streams found in embed players"}
            
            # Match preferred quality
            selected = None
            pref_lower = quality_pref.lower()
            for s in sources:
                if pref_lower in s["quality"].lower():
                    selected = s
                    break
            
            # Fallback to 720p or highest available
            if not selected:
                for s in sources:
                    if "720" in s["quality"]:
                        selected = s
                        break
            if not selected:
                selected = sources[-1]
            
            return {
                "success": True,
                "quality": selected["quality"],
                "direct_link": selected["url"],
                "referer": selected["referer"],
                "all_sources": sources
            }
            
    except Exception as e:
        sys.stderr.write(f"[RESOLVE ERROR] {e}\n")
        return {"success": False, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="FilmFeed Anime Scraper & Resolver")
    parser.add_argument("--search", type=str, help="Search anime keyword")
    parser.add_argument("--episodes", type=str, help="Anime series slug to get episode list")
    parser.add_argument("--resolve", type=str, help="Episode slug to resolve direct MP4")
    parser.add_argument("--quality", type=str, default="720p", help="Preferred quality (720p, 1080p, 480p)")
    
    args = parser.parse_args()
    
    if args.search:
        results = search_anime(args.search)
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return
    
    if args.episodes:
        data = get_series_episodes(args.episodes)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
        
    if args.resolve:
        data = resolve_episode_mp4(args.resolve, quality_pref=args.quality)
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    
    parser.print_help()

if __name__ == "__main__":
    main()
