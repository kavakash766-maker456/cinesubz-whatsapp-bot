"""
FitGirl One-Click Downloader
Resolves FuckingFast links and downloads files with full progress tracking.

Usage:
    python downloader.py --gameurl "https://fitgirl-repacks.site/game-slug/"
    python downloader.py --url "https://fuckingfast.co/HASH#file.rar"
    python downloader.py --file links.txt
    python downloader.py --gameurl "..." --dest "D:/Games"

Setup (first time):
    pip install playwright playwright-stealth aiohttp aiofiles rich
    playwright install chromium
"""

import asyncio
import sys
import os
import re
import html
import json
import argparse
import time
from pathlib import Path
from typing import Optional

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── dependency check ─────────────────────────────────────────────────────────
_missing = []
HAS_PLAYWRIGHT = False
try:
    from playwright.async_api import async_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    pass

try:
    from playwright_stealth import stealth_async
    async def apply_stealth(page):
        await stealth_async(page)
except ImportError:
    try:
        from playwright_stealth.stealth import Stealth
        _stealth_obj = Stealth()
        async def apply_stealth(page):
            await _stealth_obj.apply_stealth_async(page)
    except Exception:
        pass

try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

if not HAS_CURL_CFFI and not HAS_PLAYWRIGHT:
    _missing.append("curl_cffi")

try:
    import aiohttp
    import aiofiles
except ImportError:
    _missing.append("aiohttp aiofiles")

try:
    from rich.console import Console
    from rich.progress import (Progress, SpinnerColumn, BarColumn,
                                DownloadColumn, TransferSpeedColumn,
                                TimeRemainingColumn, TextColumn, TaskID)
    from rich.panel import Panel
    from rich.table import Table
    from rich import box
    console = Console(highlight=False)
except ImportError:
    class DummyConsole:
        def print(self, *a, **kw):
            print(*a)
    console = DummyConsole()

if _missing:
    print("Missing dependencies. Run:")
    print(f"  pip install {' '.join(_missing)}")
    sys.exit(1)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://fuckingfast.co/",
    "Accept": "*/*",
}
CHUNK = 512 * 1024   # 512 KB read chunks
CONNECTIONS = 4      # parallel downloads


# ─────────────────────────── SCRAPE FITGIRL PAGE ─────────────────────────────

async def get_ff_links_from_page(game_url: str) -> tuple[str, list[str]]:
    """Scrape a FitGirl repack page and return (game_title, [fuckingfast_urls])."""
    async with aiohttp.ClientSession() as session:
        async with session.get(game_url, headers=HEADERS, timeout=aiohttp.ClientTimeout(total=30)) as r:
            if r.status != 200:
                raise RuntimeError(f"HTTP {r.status} fetching {game_url}")
            text = await r.text()

    # Title
    title_m = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
    title = html.unescape(title_m.group(1)).strip() if title_m else "game"
    title = re.sub(r"\s*[-|].*$", "", title).strip()   # strip " - FitGirl Repacks" suffix

    # All fuckingfast links from the rendered HTML
    all_ff = re.findall(r'href="(https://fuckingfast\.co/[^"]+)"', text)

    # Separate core .partN.rar from optional .bin
    core = [l for l in all_ff if ".part" in l.lower() and ".rar" in l.lower()]
    if not core:
        core = [l for l in all_ff if not l.endswith(".bin") and "optional" not in l.lower()]
    if not core:
        core = all_ff

    return title, core


# ─────────────────────────── RESOLVE FF → DIRECT URL ─────────────────────────

def resolve_fuckingfast_direct(ff_url: str) -> Optional[str]:
    """
    Resolve a fuckingfast.co link directly to signed dl.fuckingfast.co URL using curl_cffi.
    Bypasses Cloudflare Turnstile in ~800ms without needing a headless browser.
    """
    if not HAS_CURL_CFFI:
        return None
    clean_url = ff_url.split("#")[0].strip()
    code_match = re.search(r"fuckingfast\.co/([a-zA-Z0-9_-]+)", clean_url)
    if not code_match:
        return None
    code = code_match.group(1)

    headers_get = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
    }

    for attempt in range(1, 5):
        try:
            s = cffi_requests.Session(impersonate="chrome124")
            s.get(f"https://fuckingfast.co/{code}", headers=headers_get, timeout=15)
            # Realistic user interaction delay before click
            time.sleep(1.8 + attempt * 0.5)

            headers_post = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "HX-Request": "true",
                "HX-Current-URL": f"https://fuckingfast.co/{code}",
                "Origin": "https://fuckingfast.co",
                "Referer": f"https://fuckingfast.co/{code}",
                "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"Windows"',
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
            }
            r2 = s.post(f"https://fuckingfast.co/f/{code}/go", headers=headers_post, data="", timeout=15)
            direct_url = r2.headers.get("hx-redirect") or r2.headers.get("location")
            if direct_url and "dl." in direct_url:
                return direct_url
            if r2.text:
                m = re.search(r'(https://dl\.fuckingfast\.co/[^\s"\'<>]+)', r2.text)
                if m:
                    return m.group(1)
        except Exception as e:
            console.print(f"[yellow]  curl_cffi direct resolver notice (attempt {attempt}/4): {e}[/yellow]")
            time.sleep(1)
    return None



def resolve_filekeeper_direct(fk_url: str) -> Optional[str]:
    """
    Resolve a filekeeper.net link directly to signed download URL.
    Bypasses countdown, posts form, and extracts 302 redirect location.
    Uses curl_cffi with chrome124 impersonation and retry logic to avoid TLS timeouts.
    """
    clean_url = fk_url.split("#")[0].strip()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": clean_url,
    }

    for attempt in range(1, 4):
        try:
            from bs4 import BeautifulSoup

            s = None
            if HAS_CURL_CFFI:
                s = cffi_requests.Session(impersonate="chrome124")
            else:
                import requests
                s = requests.Session()

            r1 = s.get(clean_url, headers=headers, timeout=25)
            if r1.status_code != 200:
                time.sleep(1)
                continue

            soup = BeautifulSoup(r1.text, "html.parser")
            el = soup.find(id="download-countdown")
            if not el:
                # Try finding direct rar link in initial page
                for a in soup.find_all("a", href=True):
                    if any(ext in a["href"].lower() for ext in [".rar", "/download/"]):
                        return a["href"]
                time.sleep(1)
                continue

            code = el.get("data-code")
            rand = el.get("data-rand") or ""
            referer = el.get("data-referer") or ""
            method = el.get("data-method") or "Free download"
            countdown = int(el.get("data-countdown") or "5")

            if countdown > 0:
                time.sleep(countdown)

            data = {
                "op": "download2",
                "id": code,
                "rand": rand,
                "referer": referer,
                "method_free": method,
                "down_direct": "1",
            }
            r2 = s.post(clean_url, data=data, headers=headers, allow_redirects=False, timeout=25)
            direct_url = r2.headers.get("Location")
            if direct_url and direct_url.startswith("http"):
                return direct_url

            if r2.status_code == 200:
                soup2 = BeautifulSoup(r2.text, "html.parser")
                for a in soup2.find_all("a", href=True):
                    if any(ext in a["href"].lower() for ext in [".rar", "/download/"]):
                        return a["href"]

        except Exception as e:
            console.print(f"[yellow]  FileKeeper resolver notice (attempt {attempt}/3): {e}[/yellow]")
            time.sleep(1)

    return None


def resolve_direct_url(url: str) -> Optional[str]:
    """Auto-detect host (FuckingFast, FileKeeper, Direct) and resolve to direct signed download URL."""
    if not url:
        return None
    url_lower = url.lower()
    if "fuckingfast" in url_lower:
        direct = resolve_fuckingfast_direct(url)
        if direct:
            return direct
    if "filekeeper" in url_lower:
        direct = resolve_filekeeper_direct(url)
        if direct:
            return direct
    if any(ext in url_lower for ext in [".rar", "/download/", "dl."]) and not any(h in url_lower for h in ["fuckingfast.co/", "filekeeper.net/"]):
        return url
    return None


async def resolve_one(ff_url: str, browser_ctx) -> Optional[str]:
    """
    Open a fuckingfast.co share page, handle Cloudflare + HTMX two-click flow,
    and return the final dl.fuckingfast.co signed download URL.
    """
    page = await browser_ctx.new_page()
    try:
        await apply_stealth(page)
        direct: list[str] = []

        # Intercept network responses for the HX-Redirect header or direct RAR redirect
        async def on_response(resp):
            hx = resp.headers.get("hx-redirect", "")
            loc = resp.headers.get("location", "")
            for val in (hx, loc):
                if val and ("dl." in val or ".rar" in val.lower()):
                    direct.append(val)
            # Also catch 302 → direct URLs
            if resp.status in (301, 302, 303, 307, 308):
                loc2 = resp.headers.get("location", "")
                if loc2 and "dl." in loc2:
                    direct.append(loc2)

        page.on("response", on_response)

        await page.goto(ff_url, timeout=60_000, wait_until="domcontentloaded")

        # Wait for Cloudflare to pass (page has actual content)
        try:
            await page.wait_for_selector(
                'button[hx-post], [hx-post], button:has-text("Download"), a:has-text("Download")',
                timeout=20_000
            )
        except Exception:
            pass  # continue anyway

        # --- Click 1: dismisses ad popup, starts first HTMX request ---
        btn = await page.query_selector('button[hx-post], [hx-post]')
        if btn:
            await btn.click()
            await asyncio.sleep(2)

        # Close any popup/ad that opened
        pages = browser_ctx.pages
        if len(pages) > 1:
            for p in pages[1:]:
                await p.close()

        # Check if we already got it
        if direct:
            return direct[0]

        # --- Click 2: second click triggers actual download stream / HX-Redirect ---
        await asyncio.sleep(1)
        btn = await page.query_selector('button[hx-post], [hx-post]')
        if btn:
            await btn.click()
            await asyncio.sleep(3)

        if direct:
            return direct[0]

        # Fallback: look for dl. link anywhere in the page source
        content = await page.content()
        dl_m = re.search(r'(https://dl\.fuckingfast\.co/[^"\'<>\s]+)', content)
        if dl_m:
            return dl_m.group(1)

        return None

    except Exception as e:
        console.print(f"[red]  resolver error: {e}[/red]")
        return None
    finally:
        await page.close()


async def resolve_batch(ff_urls: list[str]) -> list[Optional[str]]:
    """Resolve all URLs: fast curl_cffi first, Playwright fallback for remainder."""
    results = [None] * len(ff_urls)
    pending_indices = []

    for i, url in enumerate(ff_urls):
        direct = resolve_direct_url(url)
        if direct:
            console.print(f"  [{i+1}/{len(ff_urls)}] Fast Resolved: [green]{direct[:75]}...[/green]")
            results[i] = direct
        else:
            pending_indices.append(i)

    if pending_indices and HAS_PLAYWRIGHT:
        console.print("[bold cyan]  Launching stealth browser for remaining links...[/bold cyan]")
        try:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(
                    headless=True,
                    args=["--disable-blink-features=AutomationControlled",
                          "--no-sandbox", "--disable-dev-shm-usage"]
                )
                ctx = await browser.new_context(
                    viewport={"width": 1920, "height": 1080},
                    user_agent=HEADERS["User-Agent"],
                    extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                )
                for idx in pending_indices:
                    url = ff_urls[idx]
                    console.print(f"  [{idx+1}/{len(ff_urls)}] Browser Resolving: [dim]{url[:70]}[/dim]")
                    results[idx] = await resolve_one(url, ctx)
                await browser.close()
        except Exception as e:
            console.print(f"[red]Browser batch resolver error: {e}[/red]")

    return results


# ─────────────────────────── DOWNLOAD ────────────────────────────────────────

async def download_file(
    url: str,
    dest: Path,
    progress: Progress,
    task_id: TaskID,
    session: aiohttp.ClientSession,
) -> bool:
    """Stream a direct URL to dest with live progress."""
    try:
        async with session.get(url, headers=HEADERS, timeout=aiohttp.ClientTimeout(total=3600)) as resp:
            if resp.status not in (200, 206):
                console.print(f"[red]  HTTP {resp.status} for {dest.name}[/red]")
                return False

            total = int(resp.headers.get("Content-Length", 0))
            progress.update(task_id, total=total)

            async with aiofiles.open(dest, "wb") as f:
                async for chunk in resp.content.iter_chunked(CHUNK):
                    await f.write(chunk)
                    progress.advance(task_id, len(chunk))

        return True

    except Exception as e:
        console.print(f"[red]  Download error for {dest.name}: {e}[/red]")
        return False


async def download_all(direct_urls: list[str], dest_dir: Path, game_name: str):
    """Download all resolved links with a rich progress display."""
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Build filename list from URL fragments
    files = []
    for url in direct_urls:
        frag = re.search(r'#(.+)$', url)
        name = frag.group(1) if frag else Path(url.split("?")[0]).name
        name = re.sub(r'[<>:"/\\|?*]', '_', name)  # sanitize
        files.append(dest_dir / name)

    console.print(f"\n[bold green]Downloading {len(files)} file(s) → [cyan]{dest_dir}[/cyan][/bold green]\n")

    sem = asyncio.Semaphore(CONNECTIONS)
    connector = aiohttp.TCPConnector(limit=CONNECTIONS * 2, ssl=False)
    timeout = aiohttp.ClientTimeout(total=None, connect=30)

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold]{task.fields[name]}", justify="right"),
        BarColumn(bar_width=30),
        DownloadColumn(),
        TransferSpeedColumn(),
        TimeRemainingColumn(),
        console=console,
        expand=True,
    ) as progress:

        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            async def bounded_dl(url, path):
                task = progress.add_task(
                    "dl",
                    total=0,
                    name=path.name[:30],
                )
                async with sem:
                    ok = await download_file(url, path, progress, task, session)
                if not ok:
                    progress.update(task, description=f"[red]FAILED[/red]")
                return ok

            results = await asyncio.gather(*[
                bounded_dl(url, path)
                for url, path in zip(direct_urls, files)
            ])

    ok_count = sum(results)
    console.print(f"\n[bold green]Done: {ok_count}/{len(files)} files downloaded to:[/bold green]")
    console.print(f"  [cyan]{dest_dir}[/cyan]")

    if ok_count == len(files):
        console.print("\n[bold green]All parts complete. You can now run the FitGirl installer.[/bold green]")
    else:
        failed = [files[i].name for i, r in enumerate(results) if not r]
        console.print(f"\n[yellow]Failed: {failed}[/yellow]")


# ─────────────────────────── MAIN ────────────────────────────────────────────

async def run(args):
    dest = Path(args.dest) if args.dest else Path.cwd() / "downloads"

    ff_urls = []
    game_name = "game"

    if args.gameurl:
        console.print(f"\n[bold cyan]Scraping FitGirl page:[/bold cyan] {args.gameurl}")
        game_name, ff_urls = await get_ff_links_from_page(args.gameurl)
        console.print(f"[green]Found {len(ff_urls)} FuckingFast links for:[/green] [bold]{game_name}[/bold]")
        dest = dest / re.sub(r'[<>:"/\\|?*]', '_', game_name)[:60]

    elif args.url:
        ff_urls = [args.url]

    elif args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            ff_urls = [l.strip() for l in f if l.strip().startswith("http")]

    if not ff_urls:
        console.print("[red]No FuckingFast links found.[/red]")
        return

    # Print what we're about to resolve
    table = Table(box=box.SIMPLE, show_header=True, header_style="bold magenta")
    table.add_column("#", width=4, justify="right", style="dim")
    table.add_column("FuckingFast URL", style="cyan")
    for i, u in enumerate(ff_urls, 1):
        table.add_row(str(i), u[:90])
    console.print(table)

    # Resolve FF → direct
    console.print("\n[bold]Step 1/2 — Resolving direct download URLs...[/bold]")
    direct_urls = await resolve_batch(ff_urls)

    resolved = [(ff, d) for ff, d in zip(ff_urls, direct_urls) if d]
    failed   = [ff for ff, d in zip(ff_urls, direct_urls) if not d]

    if failed:
        console.print(f"\n[yellow]Could not resolve {len(failed)} link(s):[/yellow]")
        for f in failed:
            console.print(f"  [dim]{f}[/dim]")

    if not resolved:
        console.print("[red]No links could be resolved. Cloudflare may have blocked the browser.[/red]")
        console.print("[dim]Try running again — Cloudflare challenges are sometimes temporary.[/dim]")
        return

    # Save direct links to txt regardless
    clean_game_name = re.sub(r'[<>:"/\\|?*]', '_', game_name)[:50]
    links_file = dest.parent / f"{clean_game_name}_direct_links.txt"
    links_file.parent.mkdir(parents=True, exist_ok=True)
    with open(links_file, "w", encoding="utf-8") as f:
        f.write("\n".join(d for _, d in resolved))
    console.print(f"\n[dim]Direct links saved to: {links_file}[/dim]")
    console.print("[dim](Use this file with IDM: Tasks → Import → From text file)[/dim]")

    # Download
    console.print(f"\n[bold]Step 2/2 — Downloading {len(resolved)} file(s)...[/bold]")
    await download_all([d for _, d in resolved], dest, game_name)


async def download_single_part(ff_url: str, dest_path: Path):
    """Programmatic mode: resolve link and stream directly to dest_path."""
    try:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        direct_url = resolve_direct_url(ff_url)

        if not direct_url and "fuckingfast" in ff_url and HAS_PLAYWRIGHT:
            try:
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(
                        headless=True,
                        args=["--disable-blink-features=AutomationControlled",
                              "--no-sandbox", "--disable-dev-shm-usage"]
                    )
                    ctx = await browser.new_context(
                        viewport={"width": 1920, "height": 1080},
                        user_agent=HEADERS["User-Agent"],
                        extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                    )
                    direct_url = await resolve_one(ff_url, ctx)
                    await browser.close()
            except Exception as b_err:
                console.print(f"[yellow]Browser fallback resolution failed: {b_err}[/yellow]")

        if not direct_url:
            print(json.dumps({"success": False, "error": f"Failed to resolve direct link for {ff_url}"}))
            return

        download_ok = False

        # Attempt 1: Fast asynchronous streaming via aiohttp
        try:
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector, timeout=aiohttp.ClientTimeout(total=7200)) as session:
                async with session.get(direct_url, headers=HEADERS) as resp:
                    if resp.status in (200, 206):
                        async with aiofiles.open(dest_path, "wb") as f:
                            async for chunk in resp.content.iter_chunked(CHUNK):
                                await f.write(chunk)
                        download_ok = dest_path.exists() and dest_path.stat().st_size > 100000
        except Exception as dl_err:
            console.print(f"[yellow]aiohttp stream failed, trying fallback stream: {dl_err}[/yellow]")

        # Attempt 2: Fallback streaming via requests
        if not download_ok:
            try:
                import requests
                with requests.get(direct_url, headers=HEADERS, stream=True, verify=False, timeout=7200) as r:
                    if r.status_code in (200, 206):
                        with open(dest_path, "wb") as f:
                            for chunk in r.iter_content(chunk_size=CHUNK):
                                if chunk:
                                    f.write(chunk)
                        download_ok = dest_path.exists() and dest_path.stat().st_size > 100000
            except Exception as r_err:
                console.print(f"[yellow]requests stream failed: {r_err}[/yellow]")

        # Attempt 3: Fallback streaming via curl_cffi with Chrome TLS impersonation
        if not download_ok and HAS_CURL_CFFI:
            try:
                s = cffi_requests.Session(impersonate="chrome124", verify=False)
                r = s.get(direct_url, headers=HEADERS, stream=True, timeout=7200)
                if r.status_code in (200, 206):
                    with open(dest_path, "wb") as f:
                        for chunk in r.iter_content(chunk_size=CHUNK):
                            if chunk:
                                f.write(chunk)
                    download_ok = dest_path.exists() and dest_path.stat().st_size > 100000
            except Exception as cffi_err:
                console.print(f"[yellow]curl_cffi stream failed: {cffi_err}[/yellow]")

        if download_ok:
            print(json.dumps({
                "success": True,
                "path": str(dest_path),
                "size": dest_path.stat().st_size,
                "direct_url": direct_url
            }))
        else:
            print(json.dumps({"success": False, "error": "Downloaded file is missing or too small"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


async def resolve_single_link(ff_url: str):
    """Programmatic mode: resolve 1 link and output JSON direct_url."""
    try:
        direct_url = resolve_direct_url(ff_url)
        if not direct_url and "fuckingfast" in ff_url and HAS_PLAYWRIGHT:
            try:
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(
                        headless=True,
                        args=["--disable-blink-features=AutomationControlled",
                              "--no-sandbox", "--disable-dev-shm-usage"]
                    )
                    ctx = await browser.new_context(
                        viewport={"width": 1920, "height": 1080},
                        user_agent=HEADERS["User-Agent"],
                        extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
                    )
                    direct_url = await resolve_one(ff_url, ctx)
                    await browser.close()
            except Exception as b_err:
                console.print(f"[yellow]Browser fallback resolution failed: {b_err}[/yellow]")

        if direct_url:
            print(json.dumps({"success": True, "direct_url": direct_url}))
        else:
            print(json.dumps({"success": False, "error": f"Failed to resolve direct link for {ff_url}"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def main():
    ap = argparse.ArgumentParser(
        prog="downloader.py",
        description="FitGirl one-click downloader — resolves FuckingFast links and downloads",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument("--gameurl", "-g", type=str,
                     help="FitGirl repack page URL (auto-extracts all FF links)")
    grp.add_argument("--url",     "-u", type=str,
                     help="Single fuckingfast.co share URL")
    grp.add_argument("--file",    "-f", type=str,
                     help="Text file of fuckingfast.co URLs, one per line")
    grp.add_argument("--download-part", type=str,
                     help="Single fuckingfast.co URL to resolve and stream directly to --dest")
    grp.add_argument("--resolve-only", type=str,
                     help="Single fuckingfast.co URL to resolve and output JSON direct_url")

    ap.add_argument("--dest",    "-d", type=str, default=None,
                     help="Download destination folder or file path")

    args = ap.parse_args()

    if args.download_part:
        if not args.dest:
            print(json.dumps({"success": False, "error": "--dest <filepath> is required with --download-part"}))
            return
        asyncio.run(download_single_part(args.download_part, Path(args.dest)))
        return

    if args.resolve_only:
        asyncio.run(resolve_single_link(args.resolve_only))
        return

    console.print(Panel(
        "[bold cyan]FitGirl One-Click Downloader[/bold cyan]\n"
        "[dim]Resolves FuckingFast → direct URLs → downloads with progress[/dim]",
        border_style="cyan", expand=False,
    ))

    asyncio.run(run(args))


if __name__ == "__main__":
    main()
