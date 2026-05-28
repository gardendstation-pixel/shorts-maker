import asyncio
from pathlib import Path


async def transcribe(video_path: Path) -> list[dict]:
    loop = asyncio.get_event_loop()
    try:
        segments = await loop.run_in_executor(None, _run_whisper, video_path)
        return segments
    except Exception as e:
        raise RuntimeError(f"음성 전사 실패: {e}") from e


def _run_whisper(video_path: Path) -> list[dict]:
    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        str(video_path),
        beam_size=5,
        vad_filter=True,          # 무음 구간 자동 제거
        vad_parameters={"min_silence_duration_ms": 300},
    )

    results = []
    for seg in segments_iter:
        text = seg.text.strip()
        if text:  # 빈 세그먼트 제외
            results.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})

    return results


def segments_to_text(segments: list[dict]) -> str:
    """Claude 프롬프트용 — start/end를 초(float)로 표기해 혼동 방지"""
    if not segments:
        return "(자막 없음)"
    lines = []
    for seg in segments:
        lines.append(f"[{seg['start']}s ~ {seg['end']}s] {seg['text']}")
    return "\n".join(lines)
