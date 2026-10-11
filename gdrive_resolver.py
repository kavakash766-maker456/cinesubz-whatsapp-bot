import sys
import re
import os
import json
import requests
from bs4 import BeautifulSoup

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
}

def find_file(names):
    base_dirs = [
        os.path.join(os.path.dirname(__file__), "data"),
        os.path.join(os.path.dirname(__file__), "../data"),
        os.path.join(os.path.dirname(__file__), "../web/src/data"),
        os.path.abspath("data"),
    ]
    for d in base_dirs:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return p
    return None

def get_cartoons_file():
    return find_file(["cartoons.json"])

def get_anime_movies_file():
    return find_file(["animekaizen_movies.json", "anime_movies.json"])

def get_anime_series_file():
    return find_file(["animekaizen_series.json", "anime_series.json"])

def resolve_animekaizen_open_url(open_url):
    """Fetch AnimeKaizen redirect page and extract destination Google Drive URL"""
    try:
        r = requests.get(open_url, headers=HEADERS, timeout=15)
        # Look for drive.google.com URL
        m = re.search(r"https://drive\.google\.com/[^\s\"\'<>]+", r.text)
        if m:
            return m.group(0).rstrip(",")
    except Exception:
        pass
    return None

def get_anime_series_episodes(url):
    sf = get_anime_series_file()
    if not sf:
        return None
    try:
        with open(sf, "r", encoding="utf-8") as f:
            data = json.load(f)

        clean_url = url.strip().rstrip("/")
        series_list = data if isinstance(data, list) else data.get("series", [])

        for s in series_list:
            s_url = (s.get("url") or "").strip().rstrip("/")
            if s_url == clean_url or clean_url in s_url or s_url in clean_url:
                title = s.get("title", "Anime Series").replace(" | සිංහල උපසිරැසි සමඟ", "").strip()
                poster = s.get("backdrop") or s.get("poster") or ""

                eps = []
                cards = s.get("download_cards") or []
                if isinstance(cards, dict):
                    cards = [cards]

                ep_idx = 1
                for card in cards:
                    card_title = card.get("card_title") or f"Episode {ep_idx}"
                    links = card.get("links") or []
                    for link in links:
                        link_url = link.get("url") or ""
                        if not link_url or "group" in link_url.lower():
                            continue
                        label = link.get("label") or card_title
                        eps.append({
                            "season": 1,
                            "episode": ep_idx,
                            "title": f"{title} - {label}",
                            "url": link_url,
                        })
                        ep_idx += 1

                # If no cards, check download_links
                if not eps and s.get("download_links"):
                    for i, dl in enumerate(s.get("download_links", [])):
                        dl_url = dl.get("url") or ""
                        if dl_url and "group" not in dl_url.lower():
                            eps.append({
                                "season": 1,
                                "episode": i + 1,
                                "title": f"{title} - {dl.get('label', f'Ep {i+1}')}",
                                "url": dl_url,
                            })

                if eps:
                    return {
                        "success": True,
                        "title": title,
                        "poster": poster,
                        "backdrop": s.get("backdrop") or poster,
                        "episodes": eps,
                    }
    except Exception as e:
        pass
    return None

def load_cartoons_map():
    cf = get_cartoons_file()
    if not cf:
        return {}
    try:
        with open(cf, "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data if isinstance(data, list) else data.get("movies", [])
        out = {}
        for m in items:
            if m.get("url"):
                out[m["url"].strip().rstrip("/")] = m
            if m.get("slug"):
                out[m["slug"]] = m
        return out
    except Exception:
        return {}

def load_anime_movies_map():
    af = get_anime_movies_file()
    if not af:
        return {}
    try:
        with open(af, "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data if isinstance(data, list) else data.get("movies", [])
        out = {}
        for m in items:
            if m.get("url"):
                out[m["url"].strip().rstrip("/")] = m
            # Also map direct open links
            for link in m.get("download_links", []):
                if link.get("url"):
                    out[link["url"].strip().rstrip("/")] = m
            for card in m.get("download_cards", []):
                for link in card.get("links", []):
                    if link.get("url"):
                        out[link["url"].strip().rstrip("/")] = m
        return out
    except Exception:
        return {}

def resolve_gdrive_movie(url, requested_quality=None):
    clean_url = url.strip().rstrip("/")
    anime_map = load_anime_movies_map()
    anime_meta = anime_map.get(clean_url)

    cartoons = load_cartoons_map()
    cartoon_meta = cartoons.get(clean_url)

    file_id = None
    folder_id = None
    chosen_quality = "1080p FHD"
    is_anime = False
    is_cartoon = False
    direct_drive_url = None

    # A. If Anime Movie found in AnimeKaizen JSON
    if anime_meta:
        is_anime = True
        links = anime_meta.get("download_links") or []
        if not links and anime_meta.get("download_cards"):
            for c in anime_meta["download_cards"]:
                links.extend(c.get("links", []))

        # Filter out Google Groups
        valid_links = [l for l in links if "group" not in (l.get("url") or "").lower()]
        chosen = valid_links[0] if valid_links else (links[0] if links else None)

        if chosen and chosen.get("url"):
            open_url = chosen["url"]
            if "animekaizen.org/open" in open_url:
                direct_drive_url = resolve_animekaizen_open_url(open_url)
            else:
                direct_drive_url = open_url
            chosen_quality = chosen.get("label") or "1080p"

    # B. If direct AnimeKaizen open link was sent
    elif "animekaizen.org/open" in clean_url:
        is_anime = True
        direct_drive_url = resolve_animekaizen_open_url(clean_url)

    # C. Check if Cartoon
    elif cartoon_meta:
        is_cartoon = True
        title = cartoon_meta.get("title", "Sinhala Dubbed Cartoon")
        poster = cartoon_meta.get("poster") or ""
        desc = cartoon_meta.get("description") or "Sinhala Dubbed Cartoon / Movie from cartoons.lk."
        post_url = cartoon_meta.get("url") or clean_url

        return {
            "success": True,
            "title": title,
            "poster": poster,
            "backdrop": poster,
            "description": desc,
            "quality": "HD Dubbed",
            "size_text": "Web",
            "direct_url": post_url,
            "is_cartoon": True,
            "is_anime": False,
        }

    # D. Direct Drive URL passed
    elif "drive.google.com" in clean_url:
        direct_drive_url = clean_url

    if not direct_drive_url and not file_id:
        return {"success": False, "error": "Could not identify Google Drive or Anime file link from URL"}

    # Extract Drive ID or Folder ID
    if direct_drive_url:
        m_file = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", direct_drive_url)
        if m_file:
            file_id = m_file.group(1)
        else:
            m_folder = re.search(r"/folders/([a-zA-Z0-9_-]+)", direct_drive_url)
            if m_folder:
                folder_id = m_folder.group(1)

    # If it's a Drive file
    if file_id:
        session = requests.Session()
        uc_url = f"https://drive.google.com/uc?id={file_id}&export=download"
        try:
            resp = session.get(uc_url, timeout=25, headers=HEADERS)
            soup = BeautifulSoup(resp.text, "html.parser")
            form = soup.find("form")
            if form:
                dl_action = form.get("action")
                inputs = {inp.get("name"): inp.get("value") for inp in form.find_all("input") if inp.get("name")}
                params = "&".join([f"{k}={v}" for k, v in inputs.items()])
                final_dl_url = f"{dl_action}?{params}"
            else:
                final_dl_url = uc_url
        except Exception:
            final_dl_url = uc_url

        title = (anime_meta.get("title") if anime_meta else "Anime Movie").replace(" | සිංහල උපසිරැසි සමඟ", "").strip()
        poster = (anime_meta.get("poster") or anime_meta.get("backdrop") or "") if anime_meta else ""

        return {
            "success": True,
            "title": title,
            "poster": poster,
            "backdrop": poster,
            "description": (anime_meta.get("description") if anime_meta else "High-speed Anime Download."),
            "quality": chosen_quality,
            "size_text": "1.2 GB",
            "direct_url": final_dl_url,
            "is_anime": True,
            "is_gdrive": True,
            "file_id": file_id,
        }

    # If it's a Drive folder (e.g. Anime Kaizen series folder)
    if folder_id:
        title = (anime_meta.get("title") if anime_meta else "Anime Release").replace(" | සිංහල උපසිරැසි සමඟ", "").strip()
        poster = (anime_meta.get("poster") or anime_meta.get("backdrop") or "") if anime_meta else ""
        return {
            "success": True,
            "title": title,
            "poster": poster,
            "backdrop": poster,
            "description": (anime_meta.get("description") if anime_meta else "Google Drive Folder Release."),
            "quality": chosen_quality,
            "size_text": "Folder",
            "direct_url": direct_drive_url,
            "is_anime": True,
            "is_gdrive": True,
            "is_folder": True,
            "folder_id": folder_id,
        }

    return {"success": False, "error": "Unable to extract direct download link from file source."}

if __name__ == "__main__":
    import sys
    test_url = sys.argv[1] if len(sys.argv) > 1 else "https://www.animekaizen.org/im-in-love-with-the-villainess-season-1-2/"
    q = sys.argv[2] if len(sys.argv) > 2 else None
    res = resolve_gdrive_movie(test_url, q)
    print(json.dumps(res, indent=2, ensure_ascii=False))
