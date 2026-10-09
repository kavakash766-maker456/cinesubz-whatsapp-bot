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

def resolve_gdrive_movie(url):
    cartoons = load_cartoons_map()
    meta = cartoons.get(url)

    # Check if url has a drive file ID
    file_id = None
    m_id = re.search(r"/(?:file/d/|uc\?id=)([a-zA-Z0-9_-]+)", url)
    if m_id:
        file_id = m_id.group(1)
    elif meta and meta.get("embed_url"):
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
        # Check if direct download already provided
        direct_url = uc_url

    # Check headers with a fast HEAD / ranged stream request
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
        "gdrive_id": file_id,
    }

if __name__ == "__main__":
    import sys
    test_url = sys.argv[1] if len(sys.argv) > 1 else "https://drive.google.com/file/d/1M9x6vMiFI-Ikb-O8LH0jJQ9YSub9ap4G/preview"
    res = resolve_gdrive_movie(test_url)
    print(json.dumps(res, indent=2, ensure_ascii=False))
