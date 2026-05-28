import json
import re
import anthropic
from config import ANTHROPIC_API_KEY
from services.transcriber import segments_to_text

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


# ── 타입 변환 유틸 ─────────────────────────────────────────────────────────────

def _to_float(v) -> float:
    try:
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip().rstrip("s")
        if ":" in s:
            parts = s.split(":")
            if len(parts) == 2:
                return float(parts[0]) * 60 + float(parts[1])
            if len(parts) == 3:
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        return float(s)
    except (ValueError, TypeError):
        return 0.0


def _norm_ranges(ranges: list[dict]) -> list[dict]:
    result = []
    for r in ranges:
        start = _to_float(r.get("start", 0))
        end = _to_float(r.get("end", 0))
        if end > start:
            result.append({"start": start, "end": end})
    return result


# ── 발화 시간 계산 ─────────────────────────────────────────────────────────────

def compute_speech_duration(transcript_segs: list[dict], ranges: list[dict]) -> float:
    ranges = _norm_ranges(ranges)
    total = 0.0
    for r in ranges:
        for seg in transcript_segs:
            if seg["end"] > r["start"] and seg["start"] < r["end"]:
                total += max(0.0, min(seg["end"], r["end"]) - max(seg["start"], r["start"]))
    return total


def _get_speech_segs_in_ranges(transcript_segs: list[dict], ranges: list[dict]) -> list[dict]:
    ranges = _norm_ranges(ranges)
    result = []
    seen = set()
    for r in sorted(ranges, key=lambda x: x["start"]):
        for seg in transcript_segs:
            if seg["end"] > r["start"] and seg["start"] < r["end"]:
                key = (round(seg["start"], 1), round(seg["end"], 1))
                if key not in seen:
                    seen.add(key)
                    result.append({"start": seg["start"], "end": seg["end"]})
    return result


def _trim_to_60s(transcript_segs: list[dict], ranges: list[dict]) -> tuple[list[dict], float]:
    """발화 세그먼트를 60초 이내로 앞에서부터 잘라 반환"""
    segs = _get_speech_segs_in_ranges(transcript_segs, ranges)
    total = 0.0
    trimmed = []
    for seg in segs:
        dur = seg["end"] - seg["start"]
        if total + dur > 60.0:
            remaining = 60.0 - total
            if remaining >= 2.0:
                trimmed.append({"start": seg["start"], "end": round(seg["start"] + remaining, 2)})
                total += remaining
            break
        trimmed.append(seg)
        total += dur
    return trimmed, total


# ── 영상 전체 분석 (요약 + 키워드 + 주제 목록) ────────────────────────────────

async def analyze_video(
    transcript_segs: list[dict],
    video_title: str = "",
) -> dict:
    """
    한 번의 Claude 호출로 요약 + 키워드 + 쇼츠 주제 목록 반환.
    반환: {
        "summary": "...",
        "keywords": ["...", ...],
        "topics": [{"title", "description", "ranges", "duration_sec"}, ...]
    }
    """
    if not transcript_segs:
        return {"summary": "", "keywords": [], "topics": []}

    # 자막이 매우 길면 청크로 나눠서 처리
    total_chars = sum(len(s["text"]) for s in transcript_segs)
    if total_chars > 15000:
        return await _analyze_video_chunked(transcript_segs, video_title)

    transcript_text = segments_to_text(transcript_segs)

    prompt = f"""아래 영상 자막을 처음부터 끝까지 주제별로 빠짐없이 나눠주세요.

영상 제목: {video_title or "알 수 없음"}
자막 형식: [시작초s ~ 끝초s] 내용
자막:
{transcript_text}

---

작업 지시:
- 영상 전체를 처음부터 끝까지 순서대로 훑으며 화제가 바뀌는 지점마다 새 주제로 구분
- **모든 구간이 반드시 어딘가 topics에 포함되어야 함** (빠지는 구간 없을 것)
- 주제의 좋고 나쁨을 판단하지 말 것 — 무조건 전부 나열
- 짧은 잡담, 인사, 마무리도 별도 주제로 포함
- 한 주제 안에서 잠깐 다른 얘기 후 돌아오면 ranges에 두 구간 모두 나열
- recommended: 쇼츠로 만들면 특히 좋겠다 싶은 주제만 true (판단 기준: 독립적으로 이해 가능하고 임팩트 있는 내용)
⚠️ ranges의 start/end는 자막의 숫자(초)를 그대로 사용

JSON 형식:
{{
  "summary": "영상 전체 요약 2~3문장",
  "keywords": ["키워드1", "키워드2"],
  "topics": [
    {{
      "title": "주제 제목 (15자 이내)",
      "description": "한 줄 설명",
      "recommended": true,
      "recommend_reason": "추천 이유 (recommended=true일 때만)",
      "ranges": [{{"start": 0.0, "end": 30.0}}]
    }}
  ]
}}"""

    raw = await _call_claude(prompt, max_tokens=6000)
    data = _parse_json(raw)

    summary = data.get("summary", "")
    keywords = data.get("keywords", [])
    if isinstance(keywords, str):
        keywords = [k.strip() for k in keywords.split(",")]

    raw_topics = data.get("topics", [])
    topics = []
    for t in raw_topics:
        if not t.get("title") or not t.get("ranges"):
            continue
        duration = compute_speech_duration(transcript_segs, t["ranges"])
        if duration < 3:
            continue
        is_rec = bool(t.get("recommended", False))
        topics.append({
            "title": t["title"],
            "description": t.get("description", ""),
            "recommended": is_rec,
            "recommend_reason": t.get("recommend_reason", "") if is_rec else "",
            "ranges": _norm_ranges(t["ranges"]),
            "duration_sec": round(duration),
        })

    return {"summary": summary, "keywords": keywords, "topics": topics}


# ── 특정 주제 구간 추출 ────────────────────────────────────────────────────────

async def extract_segments_for_topic(
    transcript_segs: list[dict],
    topic: str,
    ranges: list[dict],
    video_title: str = "",
) -> tuple[list[dict], str]:
    if ranges:
        speech_segs = _get_speech_segs_in_ranges(transcript_segs, ranges)
        if speech_segs:
            return speech_segs, f"{topic} 구간 추출 완료"

    # ranges 없거나 매핑 실패 → Claude에게 직접 찾아달라고 요청
    transcript_text = segments_to_text(transcript_segs)
    prompt = f"""영상 자막에서 "{topic}"과 관련된 구간의 타임스탬프를 찾아주세요.

영상 제목: {video_title or "알 수 없음"}
자막 형식: [시작초s ~ 끝초s] 내용
자막:
{transcript_text}

⚠️ start/end는 자막에 표시된 숫자(초)를 그대로 사용하세요.

JSON만 응답:
{{
  "ranges": [{{"start": 0.0, "end": 30.0}}],
  "summary": "내용 요약"
}}"""

    raw = await _call_claude(prompt, max_tokens=1024)
    data = _parse_json(raw)
    ranges = _norm_ranges(data.get("ranges", []))
    summary = data.get("summary", "")

    speech_segs = _get_speech_segs_in_ranges(transcript_segs, ranges)
    if speech_segs:
        total = sum(s["end"] - s["start"] for s in speech_segs)
        if total > 60:
            speech_segs, _ = _trim_to_60s(transcript_segs, ranges)
    return speech_segs, summary


# ── 긴 주제 세분화 ────────────────────────────────────────────────────────────

async def subdivide_topic(
    transcript_segs: list[dict],
    topic_title: str,
    ranges: list[dict],
    video_title: str = "",
) -> list[dict]:
    """
    1분 초과 주제를 15~30초 단위 소주제로 촘촘하게 분할.
    반환: [{"title", "description", "ranges", "duration_sec"}, ...]
    """
    nranges = _norm_ranges(ranges)
    topic_segs = [
        s for s in transcript_segs
        if any(s["end"] > r["start"] and s["start"] < r["end"] for r in nranges)
    ]
    if not topic_segs:
        return []

    topic_text = segments_to_text(topic_segs)

    prompt = f"""아래는 "{topic_title}" 구간의 자막입니다. 이 구간을 15~30초 단위 소주제로 촘촘하게 나눠주세요.

영상 제목: {video_title or "알 수 없음"}
자막 형식: [시작초s ~ 끝초s] 내용
자막:
{topic_text}

지시:
- 빠지는 구간 없이 전부 소주제로 나눌 것
- 각 소주제는 15~30초 분량이 적당 (내용에 따라 유연하게 조정)
- 소주제 제목은 10자 이내로 간결하게
⚠️ ranges의 start/end는 자막의 숫자(초)를 그대로 사용

JSON만 응답:
{{
  "sub_topics": [
    {{
      "title": "소주제 제목",
      "description": "한 줄 설명",
      "ranges": [{{"start": 0.0, "end": 20.0}}]
    }}
  ]
}}"""

    raw = await _call_claude(prompt, max_tokens=2000)
    data = _parse_json(raw)

    result = []
    for t in data.get("sub_topics", []):
        if not t.get("title") or not t.get("ranges"):
            continue
        duration = compute_speech_duration(transcript_segs, t["ranges"])
        if duration < 2:
            continue
        result.append({
            "title": t["title"],
            "description": t.get("description", ""),
            "ranges": _norm_ranges(t["ranges"]),
            "duration_sec": round(duration),
        })
    return result


# ── Claude 호출 / JSON 파싱 ────────────────────────────────────────────────────

async def _call_claude(prompt: str, max_tokens: int = 1024, retries: int = 2) -> str:
    last_err = None
    for attempt in range(retries + 1):
        try:
            message = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            return message.content[0].text.strip()
        except Exception as e:
            last_err = e
            if attempt < retries:
                import asyncio
                await asyncio.sleep(2 ** attempt)
    raise RuntimeError(f"Claude API 오류: {last_err}")


def _parse_json(raw: str) -> dict:
    raw = re.sub(r"```(?:json)?", "", raw).strip().strip("`").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {}


# ── 긴 영상용 청크 처리 ────────────────────────────────────────────────────────

async def _analyze_video_chunked(
    transcript_segs: list[dict],
    video_title: str,
) -> dict:
    """
    자막이 너무 길 때: 10분 단위 청크로 나눠서 주제 추출 후 합산.
    요약과 키워드는 마지막 패스에서 전체를 보고 생성.
    """
    CHUNK_SECONDS = 600  # 10분씩

    video_end = transcript_segs[-1]["end"] if transcript_segs else 0
    chunks: list[list[dict]] = []
    t = 0.0
    while t < video_end:
        chunk = [s for s in transcript_segs if s["start"] >= t and s["start"] < t + CHUNK_SECONDS]
        if chunk:
            chunks.append(chunk)
        t += CHUNK_SECONDS

    all_topics: list[dict] = []

    for chunk in chunks:
        chunk_text = segments_to_text(chunk)
        prompt = f"""아래 영상 자막 구간을 처음부터 끝까지 주제별로 빠짐없이 나눠주세요.

영상 제목: {video_title or "알 수 없음"}
자막 형식: [시작초s ~ 끝초s] 내용
자막:
{chunk_text}

작업 지시:
- 이 구간 전체를 순서대로 훑으며 화제가 바뀌는 지점마다 새 주제로 구분
- **모든 구간이 반드시 어딘가 topics에 포함되어야 함** (빠지는 구간 없을 것)
- 주제의 좋고 나쁨을 판단하지 말 것 — 무조건 전부 나열
- 짧은 잡담, 인사, 마무리도 별도 주제로 포함
- recommended: 쇼츠로 만들면 특히 좋겠다 싶은 주제만 true
⚠️ ranges의 start/end는 자막의 숫자(초)를 그대로 사용

JSON 형식:
{{
  "topics": [
    {{
      "title": "주제 제목 (15자 이내)",
      "description": "한 줄 설명",
      "recommended": true,
      "recommend_reason": "추천 이유 (recommended=true일 때만)",
      "ranges": [{{"start": 0.0, "end": 30.0}}]
    }}
  ]
}}"""
        try:
            raw = await _call_claude(prompt, max_tokens=3000)
            data = _parse_json(raw)
            all_topics.extend(data.get("topics", []))
        except Exception:
            pass

    # 요약 + 키워드는 전체 자막 앞부분 요약본으로 한 번만
    first_segs = transcript_segs[:min(80, len(transcript_segs))]
    summary_text = segments_to_text(first_segs)
    summary_prompt = f"""아래는 긴 영상의 자막 앞부분입니다.
영상 제목: {video_title or "알 수 없음"}
자막: {summary_text}

영상 전체 요약(2~3문장)과 핵심 키워드(5~10개)를 JSON으로:
{{"summary": "요약", "keywords": ["키워드1", "키워드2"]}}"""

    try:
        raw = await _call_claude(summary_prompt, max_tokens=500)
        meta = _parse_json(raw)
        summary = meta.get("summary", "")
        keywords = meta.get("keywords", [])
    except Exception:
        summary = ""
        keywords = []

    # 주제 후처리
    topics = []
    for t in all_topics:
        if not t.get("title") or not t.get("ranges"):
            continue
        duration = compute_speech_duration(transcript_segs, t["ranges"])
        if duration < 3:
            continue
        is_rec = bool(t.get("recommended", False))
        topics.append({
            "title": t["title"],
            "description": t.get("description", ""),
            "recommended": is_rec,
            "recommend_reason": t.get("recommend_reason", "") if is_rec else "",
            "ranges": _norm_ranges(t["ranges"]),
            "duration_sec": round(duration),
        })

    return {"summary": summary, "keywords": keywords, "topics": topics}
