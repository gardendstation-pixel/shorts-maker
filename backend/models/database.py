import aiosqlite
from config import DATA_DIR

DB_PATH = DATA_DIR / "shorts_maker.db"


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'pending',
                video_url TEXT NOT NULL,
                topic TEXT NOT NULL DEFAULT '',
                progress INTEGER DEFAULT 0,
                message TEXT DEFAULT '',
                video_path TEXT DEFAULT '',
                video_title TEXT DEFAULT '',
                video_duration REAL DEFAULT 0,
                transcript TEXT DEFAULT '[]',
                video_summary TEXT DEFAULT '',
                video_keywords TEXT DEFAULT '[]',
                suggestions TEXT DEFAULT '[]',
                segments TEXT DEFAULT '[]',
                output_path TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()


async def get_job(job_id: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def create_job(job_id: str, video_url: str) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO jobs (id, video_url) VALUES (?, ?)",
            (job_id, video_url),
        )
        await db.commit()
    return await get_job(job_id)


async def update_job(job_id: str, **kwargs):
    if not kwargs:
        return
    fields = ", ".join(f"{k} = ?" for k in kwargs)
    values = list(kwargs.values()) + [job_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE jobs SET {fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            values,
        )
        await db.commit()
