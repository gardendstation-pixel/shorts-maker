import asyncio
import subprocess
from pathlib import Path
from groq import Groq
from config import GROQ_API_KEY

_client = Groq(api_key=GROQ_API_KEY)
_MAX_BYTES = 24 * 1024 * 1024  # Groq 25MB 제한 (여유분 확보)


async def transcribe(video_path: Path) -> list[dict]:
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _run, video_path)
    except Exception as e:
        raise RuntimeError(f"음성 전사 실패: {e}") from e


def _run(video_path: Path) -> list[dict]:
    audio_path = video_path.with_suffix("._audio.mp3")
    try:
        _extract_audio(video_path, audio_path)
        if audio_path.stat().st_size <= _MAX_BYTES:
            return _transcribe_file(audio_path, offset=0.0)
        return _transcribe_chunked(video_path, audio_path)
    finally:
        if audio_path.exists():
            audio_path.unlink(missing_ok=True)


def _extract_audio(video_path: Path, out: Path) -> None:
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path),
         "-vn", "-ar", "16000", "-ac", "1",
         "-c:a", "libmp3lame", "-q:a", "9", str(out)],
        capture_output=True, timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode()[-300:])


def _get(seg, key):
    return seg[key] if isinstance(seg, dict) else getattr(seg, key)


def _transcribe_file(audio_path: Path, offset: float = 0.0) -> list[dict]:
    with open(audio_path, "rb") as f:
        resp = _client.audio.transcriptions.create(
            file=(audio_path.name, f),
            model="whisper-large-v3-turbo",
            response_format="verbose_json",
            timestamp_granularities=["segment"],
        )
    results = []
    for seg in resp.segments or []:
        text = (_get(seg, "text") or "").strip()
        if text:
            results.append({
                "start": round(_get(seg, "start") + offset, 2),
                "end": round(_get(seg, "end") + offset, 2),
                "text": text,
            })
    return results


def _transcribe_chunked(video_path: Path, _audio: Path) -> list[dict]:
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True,
    )
    total = float(probe.stdout.strip() or "0")

    results, offset, i = [], 0.0, 0
    while offset < total:
        chunk = _audio.parent / f"{_audio.stem}_c{i}.mp3"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(video_path),
                 "-ss", str(offset), "-t", "600",
                 "-vn", "-ar", "16000", "-ac", "1",
                 "-c:a", "libmp3lame", "-q:a", "9", str(chunk)],
                capture_output=True, timeout=300, check=True,
            )
            results.extend(_transcribe_file(chunk, offset=offset))
        except Exception:
            pass
        finally:
            chunk.unlink(missing_ok=True)
        offset += 600
        i += 1
    return results


def segments_to_text(segments: list[dict]) -> str:
    if not segments:
        return "(자막 없음)"
    return "\n".join(f"[{s['start']}s ~ {s['end']}s] {s['text']}" for s in segments)
