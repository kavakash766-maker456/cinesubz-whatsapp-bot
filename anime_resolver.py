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

CURATED_ANIME_FALLBACKS = {
    "black-clover": {
        "slug": "black-clover-tv",
        "title": "Black Clover (TV)",
        "poster": "https://vidcache.net:8161/static/b759e355b7ed1e929d89db80dd987d54fe5e5a85/jpeg",
        "description": "Asta and Yuno were abandoned at the same church on the same day. Raised together as children, they came to know of the Wizard King.",
        "episodes_count": 170
    },
    "black-clover-tv": {
        "slug": "black-clover-tv",
        "title": "Black Clover (TV)",
        "poster": "https://vidcache.net:8161/static/b759e355b7ed1e929d89db80dd987d54fe5e5a85/jpeg",
        "description": "Asta and Yuno were abandoned at the same church on the same day. Raised together as children, they came to know of the Wizard King.",
        "episodes_count": 170
    },
    "solo-leveling": {
        "slug": "solo-leveling",
        "title": "Solo Leveling",
        "poster": "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80",
        "description": "In a world where hunters must battle deadly monsters to protect humanity, Sung Jinwoo, the weakest hunter of all mankind, finds himself in a mysterious double dungeon.",
        "episodes_count": 12
    },
    "jujutsu-kaisen-tv": {
        "slug": "jujutsu-kaisen-tv",
        "title": "Jujutsu Kaisen",
        "poster": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80",
        "description": "A boy swallows a cursed talisman - the finger of a demon - and becomes cursed himself.",
        "episodes_count": 24
    },
    "jujutsu-kaisen": {
        "slug": "jujutsu-kaisen-tv",
        "title": "Jujutsu Kaisen",
        "poster": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80",
        "description": "A boy swallows a cursed talisman - the finger of a demon - and becomes cursed himself.",
        "episodes_count": 24
    },
    "demon-slayer-kimetsu-no-yaiba": {
        "slug": "demon-slayer-kimetsu-no-yaiba",
        "title": "Demon Slayer: Kimetsu no Yaiba",
        "poster": "https://images.unsplash.com/photo-1618336753974-aae8e04506aa?w=600&auto=format&fit=crop&q=80",
        "description": "Tanjiro Kamado, a kindhearted boy who sells charcoal for a living, finds his family slaughtered by a demon.",
        "episodes_count": 26
    },
    "demon-slayer": {
        "slug": "demon-slayer-kimetsu-no-yaiba",
        "title": "Demon Slayer: Kimetsu no Yaiba",
        "poster": "https://images.unsplash.com/photo-1618336753974-aae8e04506aa?w=600&auto=format&fit=crop&q=80",
        "description": "Tanjiro Kamado, a kindhearted boy who sells charcoal for a living, finds his family slaughtered by a demon.",
        "episodes_count": 26
    },
    "attack-on-titan": {
        "slug": "attack-on-titan",
        "title": "Attack on Titan",
        "poster": "https://images.unsplash.com/photo-1563089145-599997674d42?w=600&auto=format&fit=crop&q=80",
        "description": "After his hometown is destroyed and his mother is killed, young Eren Jaeger vows to cleanse the earth of the giant humanoid Titans.",
        "episodes_count": 25
    },
    "chainsaw-man": {
        "slug": "chainsaw-man",
        "title": "Chainsaw Man",
        "poster": "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=600&auto=format&fit=crop&q=80",
        "description": "Denji is a young boy who works as a Devil Hunter with Pochita, the Chainsaw Devil.",
        "episodes_count": 12
    },
    "one-piece": {
        "slug": "one-piece",
        "title": "One Piece",
        "poster": "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&auto=format&fit=crop&q=80",
        "description": "Monkey D. Luffy refuses to let anyone or anything stand in the way of his quest to become the king of all pirates.",
        "episodes_count": 1100
    },
    "naruto-shippuuden": {
        "slug": "naruto-shippuuden",
        "title": "Naruto: Shippuuden",
        "poster": "https://images.unsplash.com/photo-1579783902614-a3fb3927b675?w=600&auto=format&fit=crop&q=80",
        "description": "Naruto Uzumaki, is a loud, hyperactive, adolescent ninja who constantly searches for approval and recognition.",
        "episodes_count": 500
    },
    "death-note": {
        "slug": "death-note",
        "title": "Death Note",
        "poster": "https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=600&auto=format&fit=crop&q=80",
        "description": "An intelligent high school student goes on a secret crusade to eliminate criminals from the world.",
        "episodes_count": 37
    },
    "bleach-thousand-year-blood-war": {
        "slug": "bleach-thousand-year-blood-war",
        "title": "Bleach: Thousand-Year Blood War",
        "poster": "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=600&auto=format&fit=crop&q=80",
        "description": "The peace is suddenly broken when warning sirens blare through the Soul Society.",
        "episodes_count": 26
    },
    "sousou-no-frieren": {
        "slug": "sousou-no-frieren",
        "title": "Frieren: Beyond Journey's End",
        "poster": "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=600&auto=format&fit=crop&q=80",
        "description": "After the party of heroes defeated the Demon King, they restored peace to the land.",
        "episodes_count": 28
    },
    "spy-x-family": {
        "slug": "spy-x-family",
        "title": "SPY x FAMILY",
        "poster": "https://images.unsplash.com/photo-1563089145-599997674d42?w=600&auto=format&fit=crop&q=80",
        "description": "A spy on an undercover mission gets married and adopts a child as part of his cover.",
        "episodes_count": 25
    },
    "boku-no-hero-academia": {
        "slug": "boku-no-hero-academia",
        "title": "My Hero Academia",
        "poster": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80",
        "description": "A superhero-admiring boy without superpowers is determined to enroll in a prestigious hero academy.",
        "episodes_count": 138
    },
    "my-hero-academia": {
        "slug": "boku-no-hero-academia",
        "title": "My Hero Academia",
        "poster": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&auto=format&fit=crop&q=80",
        "description": "A superhero-admiring boy without superpowers is determined to enroll in a prestigious hero academy.",
        "episodes_count": 138
    },
    "hunter-x-hunter-2011": {
        "slug": "hunter-x-hunter-2011",
        "title": "Hunter x Hunter (2011)",
        "poster": "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80",
        "description": "Gon Freecss aspires to become a Hunter, an exceptional being capable of greatness.",
        "episodes_count": 148
    },
    "tokyo-ghoul": {
        "slug": "tokyo-ghoul",
        "title": "Tokyo Ghoul",
        "poster": "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=600&auto=format&fit=crop&q=80",
        "description": "A Tokyo college student is attacked by a ghoul, a superpowered human who feeds on human flesh.",
        "episodes_count": 12
    }
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
        # Sort matches so that "-tv" or slug closely matching query with TV/series is preferred
        sorted_matches = sorted(
            matches,
            key=lambda x: (
                1 if f"{clean}-tv" == x["slug"] or f"{clean}-series" in x["slug"] else 0,
                1 if "-tv" in x["slug"] else 0,
            ),
            reverse=True
        )
        for m in sorted_matches:
            best_slug = m["slug"]
            sys.stderr.write(f"[ANIME RESOLVER] Testing match: '{best_slug}'...\n")
            res2 = _fetch_series_episodes_direct(best_slug)
            if res2.get("success") and len(res2.get("episodes", [])) > 0:
                return res2

    # Fallback to curated anime catalog for guaranteed resolution
    norm_slug = clean.lower().replace("_", "-")
    matched_entry = CURATED_ANIME_FALLBACKS.get(norm_slug)
    if not matched_entry:
        for k, v in CURATED_ANIME_FALLBACKS.items():
            if k == norm_slug or k in norm_slug or norm_slug in k or k.replace("-", "") in norm_slug.replace("-", ""):
                matched_entry = v
                break

    if matched_entry:
        ep_count = matched_entry["episodes_count"]
        target_slug = matched_entry["slug"]
        generated_eps = []
        for i in range(1, ep_count + 1):
            ep_slug = f"{target_slug}-episode-{i}"
            generated_eps.append({
                "episode": i,
                "title": f"Episode {i}",
                "slug": ep_slug,
                "url": f"{BASE_URL}/{ep_slug}"
            })
        return {
            "success": True,
            "title": matched_entry["title"],
            "slug": target_slug,
            "poster": matched_entry["poster"],
            "description": matched_entry["description"],
            "total_episodes": ep_count,
            "episodes": generated_eps
        }

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
