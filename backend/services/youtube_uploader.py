import json
import os
from pathlib import Path
from urllib.parse import urlencode

import httpx

from config import BASE_DIR

CREDS_FILE = BASE_DIR / "youtube_credentials.json"
_SCOPES = "https://www.googleapis.com/auth/youtube.upload"
_TOKEN_URL = "https://oauth2.googleapis.com/token"


def _client_config() -> tuple[str, str]:
    return os.getenv("YOUTUBE_CLIENT_ID", ""), os.getenv("YOUTUBE_CLIENT_SECRET", "")


def is_configured() -> bool:
    cid, cs = _client_config()
    return bool(cid and cs)


def is_authorized() -> bool:
    if not CREDS_FILE.exists():
        return False
    try:
        d = json.loads(CREDS_FILE.read_text())
        return bool(d.get("refresh_token"))
    except Exception:
        return False


def get_oauth_url(callback_url: str) -> str:
    cid, _ = _client_config()
    params = {
        "client_id": cid,
        "redirect_uri": callback_url,
        "response_type": "code",
        "scope": _SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    return "https://accounts.google.com/o/oauth2/auth?" + urlencode(params)


async def exchange_code(code: str, callback_url: str):
    cid, cs = _client_config()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(_TOKEN_URL, data={
            "code": code,
            "client_id": cid,
            "client_secret": cs,
            "redirect_uri": callback_url,
            "grant_type": "authorization_code",
        })
        r.raise_for_status()
        data = r.json()
    CREDS_FILE.write_text(json.dumps({
        "refresh_token": data.get("refresh_token"),
        "client_id": cid,
        "client_secret": cs,
    }))


async def _get_access_token() -> str:
    creds = json.loads(CREDS_FILE.read_text())
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(_TOKEN_URL, data={
            "refresh_token": creds["refresh_token"],
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "grant_type": "refresh_token",
        })
        r.raise_for_status()
        return r.json()["access_token"]


async def upload_video(
    file_path: Path,
    title: str,
    description: str = "",
    privacy: str = "private",
) -> str:
    access_token = await _get_access_token()
    file_size = file_path.stat().st_size

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            "https://www.googleapis.com/upload/youtube/v3/videos"
            "?uploadType=resumable&part=snippet,status",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "X-Upload-Content-Type": "video/mp4",
                "X-Upload-Content-Length": str(file_size),
            },
            json={
                "snippet": {"title": title, "description": description, "categoryId": "22"},
                "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
            },
        )
        r.raise_for_status()
        upload_url = r.headers["Location"]

    async with httpx.AsyncClient(timeout=600) as client:
        with open(file_path, "rb") as f:
            r = await client.put(
                upload_url,
                content=f.read(),
                headers={"Content-Type": "video/mp4", "Content-Length": str(file_size)},
            )
        r.raise_for_status()
        video_id = r.json().get("id", "")

    return f"https://www.youtube.com/shorts/{video_id}"
