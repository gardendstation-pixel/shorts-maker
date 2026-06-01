import os
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/api/youtube", tags=["youtube"])


def _callback_url(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/youtube/callback"


@router.get("/status")
async def status():
    from services.youtube_uploader import is_configured, is_authorized
    return {"configured": is_configured(), "authorized": is_authorized()}


@router.get("/auth-url")
async def auth_url(request: Request):
    from services.youtube_uploader import is_configured, get_oauth_url
    if not is_configured():
        raise HTTPException(
            status_code=503,
            detail="YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 환경변수가 없습니다.",
        )
    url = get_oauth_url(_callback_url(request))
    return {"url": url}


@router.get("/callback")
async def callback(request: Request, code: str = "", error: str = ""):
    if error:
        return HTMLResponse(
            f"<html><body><p style='color:red'>오류: {error}</p>"
            "<p>창을 닫고 다시 시도해주세요.</p></body></html>"
        )
    if not code:
        return HTMLResponse("<html><body><p>인증 코드가 없습니다.</p></body></html>")
    try:
        from services.youtube_uploader import exchange_code
        await exchange_code(code, _callback_url(request))
        return HTMLResponse(
            "<html><body style='font-family:sans-serif;text-align:center;padding-top:60px'>"
            "<h2>✅ YouTube 연결 완료!</h2>"
            "<p>이 창을 닫고 앱으로 돌아가세요.</p>"
            "<script>setTimeout(()=>window.close(),2000)</script>"
            "</body></html>"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:300])
