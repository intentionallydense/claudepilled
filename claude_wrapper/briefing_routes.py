"""FastAPI routers for the daily briefing system.

Three routers: briefing (assembly + retrieval), reading progress
(series management), and anki (stats proxy).
Included by server.py via app.include_router().

Follows task_routes.py pattern: module-level state + init function.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from claude_wrapper.briefing_anki import get_anki_stats
from claude_wrapper.briefing_assembly import assemble_briefing
from claude_wrapper.briefing_db import BriefingDatabase
from claude_wrapper.client import ClaudeClient
from claude_wrapper.task_db import TaskDatabase

# ------------------------------------------------------------------
# Module-level state — set during server startup via init()
# ------------------------------------------------------------------
briefing_db: BriefingDatabase | None = None
task_db: TaskDatabase | None = None
client: ClaudeClient | None = None


def init(bdb: BriefingDatabase, tdb: TaskDatabase, c: ClaudeClient) -> None:
    """Called by server.py on startup to inject dependencies."""
    global briefing_db, task_db, client
    briefing_db = bdb
    task_db = tdb
    client = c


# ------------------------------------------------------------------
# Briefing router — /api/briefing
# ------------------------------------------------------------------
router = APIRouter(prefix="/api/briefing", tags=["briefing"])


@router.get("/today")
async def get_today_briefing():
    """Get today's briefing, or 404 if not yet assembled."""
    today = date.today().isoformat()
    briefing = briefing_db.get_briefing_by_date(today)
    if briefing is None:
        return JSONResponse(status_code=404, content={"error": "No briefing for today"})
    return briefing


@router.get("/{date_str}")
async def get_briefing_by_date(date_str: str):
    """Get a briefing for a specific date (YYYY-MM-DD)."""
    briefing = briefing_db.get_briefing_by_date(date_str)
    if briefing is None:
        return JSONResponse(status_code=404, content={"error": "No briefing for this date"})
    return briefing


@router.post("/assemble")
async def assemble():
    """Assemble today's briefing. Idempotent unless force=true query param."""
    result = assemble_briefing(briefing_db, task_db, client, force=True)
    return result


# ------------------------------------------------------------------
# Reading progress router — /api/reading-progress
# ------------------------------------------------------------------
progress_router = APIRouter(prefix="/api/reading-progress", tags=["reading-progress"])


@progress_router.get("")
async def get_all_progress():
    """Get reading progress for all series."""
    return briefing_db.get_all_progress()


@progress_router.post("/{series}/pause")
async def pause_series(series: str):
    result = briefing_db.set_paused(series, True)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "Unknown series"})
    return result


@progress_router.post("/{series}/resume")
async def resume_series(series: str):
    result = briefing_db.set_paused(series, False)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "Unknown series"})
    return result


@progress_router.post("/{series}/skip")
async def skip_series_item(series: str):
    result = briefing_db.skip_item(series)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "Unknown series"})
    return result


# ------------------------------------------------------------------
# Anki router — /api/anki
# ------------------------------------------------------------------
anki_router = APIRouter(prefix="/api/anki", tags=["anki"])


@anki_router.get("/stats")
async def anki_stats():
    return get_anki_stats()
