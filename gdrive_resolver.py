import re
import os
import json
import requests
from bs4 import BeautifulSoup

def get_cartoons_file():
    candidates = [
        os.path.join(os.path.dirname(__file__), "data/cartoons.json"),
        os.path.join(os.path.dirname(__file__), "../data/cartoons.json"),
        os.path.abspath("data/cartoons.json"),
        r"C:\Users\akash\Desktop\cinesubz\scraped_movies\movies.json"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None

def get_anime_movies_file():
    candidates = [
        os.path.join(os.path.dirname(__file__), "data/anime_movies.json"),
        os.path.join(os.path.dirname(__file__), "../data/anime_movies.json"),
        os.path.abspath("data/anime_movies.json"),
        r"C:\Users\akash\Desktop\anime\movies.json"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None

def get_anime_series_file():
    candidates = [
        os.path.join(os.path.dirname(__file__), "data/anime_series.json"),
        os.path.join(os.path.dirname(__file__), "../data/anime_series.json"),
        os.path.abspath("data/anime_series.json"),
        r"C:\Users\akash\Desktop\anime\series.json"
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None

def get_anime_series_episodes(url):
    sf = get_anime_series_file()
    if not sf:
        return None
    try:
        with open(sf, "r", encoding="utf-8") as f:
            data = json.load(f)
            clean_url = url.strip().rstrip("/")
            for s in data.get("series", []):
                s_url = (s.get("url") or "").strip().rstrip("/")
                if s_url == clean_url or clean_url in s_url or s_url in clean_url:
                    poster = s.get("backdrop") or s.get("poster") or ""
                    eps = [
                        {
                            "season": 1,
                            "episode": ep.get("n", i + 1),
                            "title": ep.get("title") or f"Episode {i + 1}",
                            "url": ep.get("url") or s_url,
                        }
                        for i, ep in enumerate(s.get("episodes", []))
                    ]
                    return {
                        "success": True,
                        "title": s.get("title", "Anime Series").replace(" | සිංහල උපසිරැසි සමඟ", "").strip(),
                        "poster": poster,
                        "backdrop": s.get("backdrop") or poster,
                        "episodes": eps,
                    }
    except Exception:
        pass
    return None

def load_cartoons_map():
    cf = get_cartoons_file()
    if not cf:
        return {}
    try:
        with open(cf, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {
                m.get("embed_url"): m for m in data.get("movies", []) if m.get("embed_url")
            } | {
                m.get("watch_page"): m for m in data.get("movies", []) if m.get("watch_page")
            } | {
                m.get("embed_page"): m for m in data.get("movies", []) if m.get("embed_page")
            }
    except Exception:
        return {}

def load_anime_movies_map():
    af = get_anime_movies_file()
    if not af:
        return {}
    try:
        with open(af, "r", encoding="utf-8") as f:
            data = json.load(f)
            out = {}
            for m in data.get("movies", []):
                if m.get("url"):
                    out[m["url"]] = m
                for link in m.get("links", []):
                    if link.get("resolved"):
                        out[link["resolved"]] = m
                    if link.get("href"):
                        out[link["href"]] = m
            return out
    except Exception:
        return {}

def resolve_gdrive_movie(url, requested_quality=None):
    # 1. Check if Anime Movie
    anime_map = load_anime_movies_map()
    anime_meta = anime_map.get(url)

    cartoons = load_cartoons_map()
    meta = cartoons.get(url)

    file_id = None
    chosen_quality = "720p HD"
    is_anime = False
    is_cartoon = False

    if anime_meta:
        is_anime = True
        links = anime_meta.get("links", [])
        chosen_link = None

        # Prioritize Google Drive links exclusively over Telegram/bot links
        drive_links = [
            l for l in links
            if (l.get("source") or "").lower() == "drive"
            or "drive.google.com" in (l.get("resolved") or "")
        ]
        pool = drive_links if drive_links else links

        if requested_quality:
            rq = requested_quality.lower()
            for l in pool:
                q = (l.get("quality") or "").lower()
                if rq in q:
                    chosen_link = l
                    break

        if not chosen_link and pool:
            # Prefer 720p, then 1080p, then 480p, else first
            chosen_link = (
                next((l for l in pool if "720" in (l.get("quality") or "")), None)
                or next((l for l in pool if "1080" in (l.get("quality") or "")), None)
                or next((l for l in pool if "480" in (l.get("quality") or "")), None)
                or pool[0]
            )

        if chosen_link and chosen_link.get("resolved"):
            resolved_url = chosen_link["resolved"]
            chosen_quality = chosen_link.get("quality") or "720p HD"
            m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", resolved_url)
            if m_id:
                file_id = m_id.group(1)

    if not file_id:
        # Check standard cartoon or direct drive URL
        m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", url)
        if m_id:
            file_id = m_id.group(1)
        elif meta and meta.get("embed_url"):
            is_cartoon = True
            m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", meta["embed_url"])
            if m_id:
                file_id = m_id.group(1)

    if not file_id:
        return {"success": False, "error": "Could not identify Google Drive file ID from URL"}

    session = requests.Session()
    uc_url = f"https://drive.google.com/uc?id={file_id}&export=download"
    resp = session.get(uc_url, timeout=25)

    soup = BeautifulSoup(resp.text, "html.parser")
    form = soup.find("form")
    direct_url = None
    content_len = 0
    filename = None

    if form:
        dl_action = form.get("action")
        inputs = {inp.get("name"): inp.get("value") for inp in form.find_all("input") if inp.get("name")}
        params = "&".join([f"{k}={v}" for k, v in inputs.items()])
        direct_url = f"{dl_action}?{params}"
    else:
        direct_url = uc_url

    # Check headers with stream request
    try:
        h_resp = session.get(direct_url, headers={"User-Agent": "Mozilla/5.0"}, stream=True, timeout=15)
        if h_resp.status_code == 200:
            clen = h_resp.headers.get("Content-Length")
            if clen and clen.isdigit():
                content_len = int(clen)
            cdisp = h_resp.headers.get("Content-Disposition") or ""
            fn_m = re.search(r'filename="([^"]+)"', cdisp)
            if fn_m:
                filename = fn_m.group(1)
            h_resp.close()
    except Exception:
        pass

    size_mb = round(content_len / (1024 * 1024), 2) if content_len else 0
    size_text = f"{round(size_mb / 1024, 2)} GB" if size_mb > 1024 else f"{size_mb} MB"

    if is_anime:
        raw_title = anime_meta.get("title", "Anime Movie")
        title = raw_title.replace(" | සිංහල උපසිරැසි සමඟ", "").strip()
        poster = anime_meta.get("poster") or anime_meta.get("backdrop") or ""
        backdrop = anime_meta.get("backdrop") or poster
        description = anime_meta.get("description") or "Official Anime Release with Sinhala Subtitles."
        return {
            "success": True,
            "title": title,
            "poster": poster,
            "backdrop": backdrop,
            "description": description,
            "quality": chosen_quality,
            "size_text": size_text,
            "direct_url": direct_url,
            "is_anime": True,
            "is_cartoon": False,
            "gdrive_id": file_id,
        }

    title = meta.get("title") if meta else (filename or "Sinhala Dubbed Cartoon")
    poster = meta.get("banner") if meta else "https://yt3.ggpht.com/2mgb7U29xiD32lXvFZM1Ml4-m50CBNDaS6mSo2DmFuEcffRvPXmaGkN5FVfMOvkhnJ-MErGT08qPxw=s320-nd-v1-rwa"
    description = meta.get("description") if meta else "Sinhala Dubbed Cartoon / Movie hosted on Google Drive."

    return {
        "success": True,
        "title": title,
        "poster": poster,
        "backdrop": poster,
        "description": description,
        "quality": "720p HD",
        "size_text": size_text,
        "direct_url": direct_url,
        "is_cartoon": True,
        "is_anime": False,
        "gdrive_id": file_id,
    }

if __name__ == "__main__":
    import sys
    test_url = sys.argv[1] if len(sys.argv) > 1 else "https://drive.google.com/file/d/1M9x6vMiFI-Ikb-O8LH0jJQ9YSub9ap4G/preview"
    q = sys.argv[2] if len(sys.argv) > 2 else None
    res = resolve_gdrive_movie(test_url, q)
    print(json.dumps(res, indent=2, ensure_ascii=False))
