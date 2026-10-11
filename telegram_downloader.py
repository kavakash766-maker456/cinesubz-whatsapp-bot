#!/usr/bin/env python3
"""
telegram_downloader.py
Automated high-speed Telegram media downloader for AnimeClub001_bot.
Uses MTProto Client (Telethon) to send /start <token> and download video documents.
"""

import sys
import os
import re
import asyncio
import json
import time
from pathlib import Path
from telethon import TelegramClient, events
from telethon.sessions import StringSession

API_ID = int(os.environ.get("TG_API_ID", 7012205))
API_HASH = os.environ.get("TG_API_HASH", "840af80809b74458f7feaa110e5a6cc6")

def get_session_string():
    session_str = os.environ.get("TG_SESSION_STRING", "").strip()
    if session_str:
        return session_str
    
    # Check tg_session.txt in bot dir or root dir
    bot_dir = Path(__file__).resolve().parent
    for check_path in [bot_dir / "tg_session.txt", bot_dir.parent / "tg_session.txt", bot_dir / ".env"]:
        if check_path.exists():
            if check_path.name == ".env":
                for line in check_path.read_text(encoding="utf-8").splitlines():
                    if line.startswith("TG_SESSION_STRING="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
            else:
                val = check_path.read_text(encoding="utf-8").strip()
                if val:
                    return val
    return None

def extract_bot_and_token(url_or_token: str):
    """
    Extracts target bot username and start token from link or token string.
    e.g. https://t.me/AnimeClub001_bot?start=BQADAQADFQ0AAmvQAAFHeImtMStjBncWBA
    """
    bot_username = "AnimeClub001_bot"
    start_token = url_or_token.strip()

    m = re.search(r"t\.me/([^/?]+)\?start=([a-zA-Z0-9_-]+)", url_or_token)
    if m:
        bot_username = m.group(1)
        start_token = m.group(2)
    elif "start=" in url_or_token:
        start_token = url_or_token.split("start=")[1].split("&")[0].strip()
    
    return bot_username, start_token

async def download_from_telegram(target_url_or_token: str, output_path: str):
    session_str = get_session_string()
    if not session_str:
        return {
            "success": False,
            "error": "TG_SESSION_STRING not configured. Please run generate_tg_session.py first."
        }

    bot_username, start_token = extract_bot_and_token(target_url_or_token)
    output_file = Path(output_path).resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)

    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.connect()

    if not await client.is_user_authorized():
        await client.disconnect()
        return {
            "success": False,
            "error": "Telegram session is unauthorized or expired. Please re-run generate_tg_session.py"
        }

    try:
        # Resolve target bot entity
        bot_entity = await client.get_entity(bot_username)
        
        # Setup response listener before sending command
        future = asyncio.get_event_loop().create_future()

        @client.on(events.NewMessage(chats=bot_entity))
        async def handler(event):
            if event.message and event.message.media:
                if not future.done():
                    future.set_result(event.message)

        # Send /start <token> command to the bot
        cmd = f"/start {start_token}" if start_token else "/start"
        await client.send_message(bot_entity, cmd)

        # Wait for reply message with media (timeout 45s)
        try:
            msg = await asyncio.wait_for(future, timeout=45.0)
        except asyncio.TimeoutError:
            # Fallback: check recent message history
            recent = await client.get_messages(bot_entity, limit=3)
            media_msg = next((m for m in recent if m.media), None)
            if media_msg:
                msg = media_msg
            else:
                await client.disconnect()
                return {
                    "success": False,
                    "error": f"Timeout waiting for media response from @{bot_username}"
                }

        # Progress tracking
        start_time = time.time()
        last_print = 0

        def progress_callback(current, total):
            nonlocal last_print
            now = time.time()
            if now - last_print >= 2.0 or current >= total:
                last_print = now
                elapsed = max(now - start_time, 0.1)
                speed_mb = (current / (1024 * 1024)) / elapsed
                percent = round((current / total) * 100, 1) if total > 0 else 0
                print(f"[PROGRESS] {percent}% ({current}/{total}) {speed_mb:.2f} MB/s", flush=True)

        # Download media
        downloaded_file = await client.download_media(
            msg.media,
            file=str(output_file),
            progress_callback=progress_callback
        )

        await client.disconnect()

        if output_file.exists() and output_file.stat().st_size > 100000:
            return {
                "success": True,
                "file_path": str(output_file),
                "file_size": output_file.stat().st_size,
                "file_name": output_file.name
            }
        else:
            return {
                "success": False,
                "error": f"Downloaded file is too small or missing ({output_file.stat().st_size if output_file.exists() else 0} bytes)"
            }

    except Exception as e:
        await client.disconnect()
        return {
            "success": False,
            "error": f"Telegram download error: {str(e)}"
        }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: python telegram_downloader.py <token_or_url> <output_path>"}))
        sys.exit(1)

    url_or_token = sys.argv[1]
    out_path = sys.argv[2]

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    res = loop.run_until_complete(download_from_telegram(url_or_token, out_path))
    print(json.dumps(res))
