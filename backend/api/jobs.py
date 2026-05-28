import json
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from models.database import create_job, get_job, update_job
from services.downloader import download_video, get_video_info
from services.transcriber import transcribe
from services.analyzer import analyze_video, extract_segments_for_topic, subdivide_topic
from services.editor import cut_and_merge

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


class AnalyzeRequest(BaseModel):
    url: str


class GenerateRequest(BaseModel):
    topic_index: int


class GenerateCustomRequest(BaseModel):
    topic: str


class SubdivideRequest(BaseModel):
    title: str
    ranges: list[dict]


class GenerateSegmentsRequest(BaseModel):
    title: str
    ranges: list[dict]


@router.post("")
async def create(req: AnalyzeRequest, background_tasks: BackgroundTasks):
    if not req.url.strip():
        raise HTTPException(status_code=400, detail="URL을 입력해주세요.")
    job_id = str(uuid.uuid4())
    await create_job(job_id, req.url.strip())
    background_tasks.add_task(analyze_job, job_id, req.url.strip())
    return {"job_id": job_id}


@router.post("/{job_id}/generate")
async def generate(job_id: str, req: GenerateRequest, background_tasks: BackgroundTasks):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if job["status"] != "suggested":
        raise HTTPException(status_code=400, detail="주제 추천이 완료된 작업만 생성 가능합니다.")

    suggestions = json.loads(job["suggestions"] or "[]")
    idx = max(0, min(req.topic_index, len(suggestions) - 1))
    chosen = suggestions[idx]

    await update_job(job_id, topic=chosen["title"], status="generating", progress=0, message="영상 편집 준비 중...")
    background_tasks.add_task(generate_job, job_id, chosen)
    return {"job_id": job_id}


@router.post("/{job_id}/generate-custom")
async def generate_custom(job_id: str, req: GenerateCustomRequest, background_tasks: BackgroundTasks):
    if not req.topic.strip():
        raise HTTPException(status_code=400, detail="주제를 입력해주세요.")
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if job["status"] not in ("suggested",):
        raise HTTPException(status_code=400, detail="분석이 완료된 작업에만 사용할 수 있습니다.")

    topic = req.topic.strip()
    await update_job(job_id, topic=topic, status="generating", progress=0, message="주제 구간 검색 중...")
    background_tasks.add_task(generate_job, job_id, {"title": topic, "ranges": []})
    return {"job_id": job_id}


@router.post("/{job_id}/subdivide")
async def subdivide(job_id: str, req: SubdivideRequest):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    transcript_segs = json.loads(job["transcript"] or "[]")
    video_title = job.get("video_title") or ""
    sub_topics = await subdivide_topic(transcript_segs, req.title, req.ranges, video_title)
    return {"sub_topics": sub_topics}


@router.post("/{job_id}/generate-segments")
async def generate_from_segments(job_id: str, req: GenerateSegmentsRequest, background_tasks: BackgroundTasks):
    if not req.title.strip() or not req.ranges:
        raise HTTPException(status_code=400, detail="제목과 구간 정보가 필요합니다.")
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if job["status"] != "suggested":
        raise HTTPException(status_code=400, detail="분석이 완료된 작업에만 사용할 수 있습니다.")

    title = req.title.strip()
    await update_job(job_id, topic=title, status="generating", progress=0, message="선택 구간 편집 준비 중...")
    background_tasks.add_task(generate_job, job_id, {"title": title, "ranges": req.ranges})
    return {"job_id": job_id}


@router.get("/{job_id}")
async def get_status(job_id: str):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")

    result = {
        "job_id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
        "title": job.get("video_title") or "",
        "duration": job.get("video_duration") or 0,
        "summary": job.get("video_summary") or "",
        "keywords": json.loads(job.get("video_keywords") or "[]"),
        "suggestions": json.loads(job["suggestions"] or "[]"),
        "segments": json.loads(job["segments"] or "[]"),
        "error": job.get("error") or "",
    }

    if job["status"] == "done":
        result["download_url"] = f"/api/jobs/{job_id}/download"

    return result


@router.get("/{job_id}/video")
async def stream_video(job_id: str):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    video_path = Path(job.get("video_path") or "")
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="영상 파일이 없습니다.")
    import mimetypes
    media_type = mimetypes.guess_type(str(video_path))[0] or "video/mp4"
    return FileResponse(str(video_path), media_type=media_type)


@router.get("/{job_id}/download")
async def download(job_id: str):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="아직 완료되지 않은 작업입니다.")

    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="결과 파일을 찾을 수 없습니다.")

    topic = (job.get("topic") or "shorts").replace(" ", "_")
    return FileResponse(path=str(output_path), media_type="video/mp4", filename=f"{topic}.mp4")


# ── 1단계 ─────────────────────────────────────────────────────────────────────
async def analyze_job(job_id: str, url: str):
    try:
        await _safe_update(job_id, status="processing", progress=5, message="영상 정보 조회 중...")

        info = await get_video_info(url)
        video_title = info.get("title", "")
        video_duration = info.get("duration", 0)

        await _safe_update(job_id, progress=15, message="영상 다운로드 중...",
                           video_title=video_title, video_duration=video_duration)
        video_path = await download_video(job_id, url)

        await _safe_update(job_id, progress=35, message="음성 전사 중...", video_path=str(video_path))
        transcript_segs = await transcribe(video_path)

        if not transcript_segs:
            await _safe_update(job_id, status="error", progress=100,
                               message="오류", error="영상에서 음성을 인식할 수 없습니다.")
            return

        await _safe_update(job_id, progress=75, message="영상 분석 중... (요약 + 주제 추출)")
        result = await analyze_video(transcript_segs, video_title)

        summary = result.get("summary", "")
        keywords = result.get("keywords", [])
        topics = result.get("topics", [])

        await _safe_update(
            job_id,
            status="suggested",
            progress=100,
            message=f"분석 완료! 주제 {len(topics)}개 발견",
            transcript=json.dumps(transcript_segs, ensure_ascii=False),
            video_summary=summary,
            video_keywords=json.dumps(keywords, ensure_ascii=False),
            suggestions=json.dumps(topics, ensure_ascii=False),
        )

    except Exception as e:
        await _safe_update(job_id, status="error", progress=100,
                           message="오류 발생", error=_friendly(e))


# ── 2단계 ─────────────────────────────────────────────────────────────────────
async def generate_job(job_id: str, chosen_topic: dict):
    try:
        job = await get_job(job_id)
        transcript_segs = json.loads(job["transcript"] or "[]")
        raw_path = job.get("video_path") or ""
        if not raw_path:
            raise FileNotFoundError("원본 영상 파일이 없습니다. 처음부터 다시 시도해주세요.")
        video_path = Path(raw_path)
        video_title = job.get("video_title") or ""

        if not video_path.exists():
            raise FileNotFoundError("원본 영상 파일이 없습니다. 처음부터 다시 시도해주세요.")

        await _safe_update(job_id, progress=20, message="발화 구간 추출 중...")
        speech_segs, _ = await extract_segments_for_topic(
            transcript_segs,
            chosen_topic["title"],
            chosen_topic.get("ranges", []),
            video_title,
        )

        if not speech_segs:
            raise ValueError("해당 주제의 발화 구간을 찾을 수 없습니다.")

        await _safe_update(job_id, progress=50,
                           message=f"영상 편집 중... ({len(speech_segs)}개 클립)",
                           segments=json.dumps(speech_segs, ensure_ascii=False))

        output_path = await cut_and_merge(video_path, speech_segs, job_id)

        await _safe_update(job_id, status="done", progress=100,
                           message="완료!", output_path=str(output_path))

    except Exception as e:
        await _safe_update(job_id, status="error", progress=100,
                           message="오류 발생", error=_friendly(e))


async def _safe_update(job_id: str, **kwargs):
    try:
        await update_job(job_id, **kwargs)
    except Exception:
        pass


def _friendly(e: Exception) -> str:
    msg = str(e)
    if "yt-dlp" in msg or "다운로드" in msg:
        return f"영상 다운로드 실패: {msg[:300]}"
    if "whisper" in msg.lower() or "전사" in msg:
        return f"음성 인식 실패: {msg[:200]}"
    if "ffmpeg" in msg.lower():
        return f"영상 편집 실패: {msg[:200]}"
    if "Claude" in msg or "API" in msg:
        return f"AI 분석 실패: {msg[:200]}"
    return msg[:400]
