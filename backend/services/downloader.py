import asyncio
import json
from pathlib import Path
from config import UPLOADS_DIR

# 포맷 시도 순서 — 앞에서 실패하면 다음으로 fallback
_FORMAT_FALLBACKS = [
    "bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best",
    "best[height<=1080]/best",
    "best",
    "bestaudio/best",  # 영상 없이 오디오만이라도
]

_BASE_FLAGS = [
    "--no-playlist",
    "--no-check-certificates",
    "--extractor-retries", "3",
    "--fragment-retries", "3",
    "--retry-sleep", "3",
]


async def download_video(job_id: str, url: str) -> Path:
    out_dir = UPLOADS_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    last_error = ""
    for fmt in _FORMAT_FALLBACKS:
        cmd = [
            "yt-dlp",
            *_BASE_FLAGS,
            "-f", fmt,
            "--merge-output-format", "mp4",
            "-o", str(out_dir / "video.%(ext)s"),
            url,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()

        if proc.returncode == 0:
            files = list(out_dir.glob("video.*"))
            if files:
                return files[0]

        last_error = stderr.decode()[-800:]

    raise RuntimeError(f"영상 다운로드 실패 (모든 포맷 시도 후): {last_error}")


async def get_video_info(url: str) -> dict:
    cmd = [
        "yt-dlp", "--dump-json",
        "--no-playlist", "--no-check-certificates",
        url,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0 or not stdout:
        # 정보 조회 실패는 치명적이지 않음 — 빈 정보 반환
        return {"title": "", "duration": 0, "uploader": "", "thumbnail": "", "platform": _detect_platform(url)}

    try:
        info = json.loads(stdout.decode())
    except json.JSONDecodeError:
        return {"title": "", "duration": 0, "uploader": "", "thumbnail": "", "platform": _detect_platform(url)}

    return {
        "title": info.get("title", ""),
        "duration": info.get("duration", 0),
        "uploader": info.get("uploader", ""),
        "thumbnail": info.get("thumbnail", ""),
        "platform": _detect_platform(url),
    }


def _detect_platform(url: str) -> str:
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    if "instagram.com" in url:
        return "instagram"
    if "tiktok.com" in url:
        return "tiktok"
    return "unknown"
