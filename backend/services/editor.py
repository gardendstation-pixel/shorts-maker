import asyncio
import shutil
from pathlib import Path
from config import OUTPUTS_DIR


async def cut_and_merge(video_path: Path, speech_segments: list[dict], job_id: str) -> Path:
    if not speech_segments:
        raise ValueError("추출할 구간이 없습니다.")

    if not video_path.exists():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {video_path}")

    out_dir = OUTPUTS_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # 너무 짧은 세그먼트 필터링 (0.5초 미만)
    valid_segs = [s for s in speech_segments if s["end"] - s["start"] >= 0.5]
    if not valid_segs:
        raise ValueError("유효한 구간이 없습니다 (각 구간이 0.5초 이상이어야 합니다).")

    clip_paths = []
    for i, seg in enumerate(valid_segs):
        clip_path = out_dir / f"clip_{i:04d}.mp4"
        try:
            await _cut_clip(video_path, seg["start"], seg["end"], clip_path)
            if clip_path.exists() and clip_path.stat().st_size > 0:
                clip_paths.append(clip_path)
        except Exception:
            # 개별 클립 실패는 건너뜀
            if clip_path.exists():
                clip_path.unlink(missing_ok=True)

    if not clip_paths:
        raise RuntimeError("클립 생성에 모두 실패했습니다.")

    if len(clip_paths) == 1:
        final_path = out_dir / "shorts.mp4"
        await _to_shorts_format(clip_paths[0], final_path)
        clip_paths[0].unlink(missing_ok=True)
        return final_path

    merged = out_dir / "merged_raw.mp4"
    await _concat_clips(clip_paths, merged)
    for p in clip_paths:
        p.unlink(missing_ok=True)

    final_path = out_dir / "shorts.mp4"
    await _to_shorts_format(merged, final_path)
    merged.unlink(missing_ok=True)

    return final_path


async def _cut_clip(video_path: Path, start: float, end: float, out: Path):
    duration = max(0.5, end - start)
    await _run([
        "ffmpeg", "-y",
        "-ss", str(max(0, start)),
        "-i", str(video_path),
        "-t", str(duration),
        "-c:v", "libx264", "-c:a", "aac",
        "-avoid_negative_ts", "make_zero",
        str(out),
    ])


async def _concat_clips(clip_paths: list[Path], out: Path):
    concat_txt = out.parent / "concat.txt"
    concat_txt.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in clip_paths)
    )
    try:
        await _run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_txt),
            "-c", "copy",
            str(out),
        ])
    finally:
        concat_txt.unlink(missing_ok=True)


async def _to_shorts_format(in_path: Path, out: Path):
    """9:16 세로 포맷 (1080×1920) 변환"""
    await _run([
        "ffmpeg", "-y",
        "-i", str(in_path),
        "-vf", (
            "scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"
        ),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(out),
    ])


async def cut_preview_clip(video_path: Path, ranges: list[tuple[float, float]], out_path: Path) -> Path:
    """Preview clip transcoded to H.264+AAC for broad browser compatibility."""
    if not ranges:
        raise ValueError("No ranges specified")

    _ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
               "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]

    if len(ranges) == 1:
        start, end = ranges[0]
        await _run([
            "ffmpeg", "-y",
            "-ss", str(max(0, start - 0.5)),
            "-to", str(end + 0.5),
            "-i", str(video_path),
            *_ENCODE,
            str(out_path),
        ])
        return out_path

    tmp_dir = out_path.parent
    clip_paths = []
    for i, (start, end) in enumerate(ranges):
        clip_path = tmp_dir / f"_prev_{i}_{out_path.name}"
        await _run([
            "ffmpeg", "-y",
            "-ss", str(max(0, start - 0.5)),
            "-to", str(end + 0.5),
            "-i", str(video_path),
            *_ENCODE,
            str(clip_path),
        ])
        if clip_path.exists() and clip_path.stat().st_size > 0:
            clip_paths.append(clip_path)

    if not clip_paths:
        raise RuntimeError("Failed to cut any preview clips")

    if len(clip_paths) == 1:
        clip_paths[0].rename(out_path)
        return out_path

    concat_txt = tmp_dir / f"_prev_concat_{out_path.stem}.txt"
    concat_txt.write_text("\n".join(f"file '{p.resolve()}'" for p in clip_paths))
    try:
        await _run([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_txt),
            "-c", "copy",
            str(out_path),
        ])
    finally:
        concat_txt.unlink(missing_ok=True)
        for p in clip_paths:
            p.unlink(missing_ok=True)

    return out_path


async def _run(cmd: list[str]):
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 오류: {stderr.decode()[-400:]}")
