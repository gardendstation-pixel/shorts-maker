import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from models.database import init_db
from api.jobs import router as jobs_router


def _init_youtube_cookies():
    import base64
    cookies_b64 = os.getenv("YOUTUBE_COOKIES", "")
    if cookies_b64:
        try:
            with open("/tmp/youtube_cookies.txt", "wb") as f:
                f.write(base64.b64decode(cookies_b64))
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_youtube_cookies()
    await init_db()
    yield


app = FastAPI(title="Shorts Maker API", lifespan=lifespan)

_origins_env = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
_origins = [o.strip() for o in _origins_env.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
