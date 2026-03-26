"""FastAPI routers for the daily briefing system.

Three sub-routers: briefing (assembly + retrieval), reading progress
(series management), and anki (stats proxy). The plugin __init__.py
combines them into a single router mounted at /api.

The briefing content itself comes from the standalone briefing project
(~/.briefing/briefings/*.md). This module just reads/serves it and
manages the chat-to-briefing link. Reading progress queries proxy
to the standalone project's DB at ~/.briefing/state.db.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .anki import get_anki_stats
from .assembly import assemble_briefing
from .db import BriefingDatabase

# Standalone briefing project's DB — reading progress lives here
_STANDALONE_DB = Path.home() / ".briefing" / "state.db"

# ------------------------------------------------------------------
# Module-level state — set during server startup via init()
# ------------------------------------------------------------------
briefing_db: BriefingDatabase | None = None
_svc = None  # ServiceRegistry — lazy fallback for conversation_manager
_get_setting = None  # Settings accessor from PluginContext

# Default briefing chat model — overridden by briefing_chat_model setting
_DEFAULT_BRIEFING_MODEL = "claude-sonnet-4-6"


def init(bdb: BriefingDatabase, svc=None, get_setting=None) -> None:
    """Called by plugin on_load to inject dependencies."""
    global briefing_db, _svc, _get_setting
    briefing_db = bdb
    _svc = svc
    _get_setting = get_setting


# ------------------------------------------------------------------
# Briefing router (no prefix — plugin adds /briefing)
# ------------------------------------------------------------------
router = APIRouter(tags=["briefing"])


@router.get("/list")
async def list_briefings():
    """Return all briefing dates, sorted newest-first."""
    return briefing_db.list_briefings()


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
    """Import today's briefing from the standalone project. Triggers assembly if needed."""
    result = assemble_briefing(briefing_db, force=True)
    return result


@router.post("/{date_str}/chat")
async def get_or_create_chat(date_str: str):
    """Return (or create) a chat conversation linked to this briefing."""
    briefing = briefing_db.get_briefing_by_date(date_str)
    if briefing is None:
        return JSONResponse(status_code=404, content={"error": "No briefing for this date"})

    # Return existing conversation if already linked
    existing_id = briefing.get("chat_conversation_id")
    if existing_id:
        return {"conversation_id": existing_id}

    # Resolve ConversationManager from service registry
    mgr = _svc.get("conversation_manager") if _svc else None
    if mgr is None:
        return JSONResponse(status_code=503, content={"error": "ConversationManager not available"})

    # Resolve briefing chat model: setting > default (Sonnet 4.6)
    model = _DEFAULT_BRIEFING_MODEL
    if _get_setting:
        custom = _get_setting("briefing_chat_model")
        if custom:
            model = custom

    # Create new conversation with briefing text as system prompt
    conv = mgr.create_conversation(
        title=f"Briefing chat — {date_str}",
        system_prompt=briefing["assembled_text"],
        model=model,
    )
    briefing_db.set_chat_conversation_id(date_str, conv.id)
    return {"conversation_id": conv.id}


# ------------------------------------------------------------------
# Reading progress router (no prefix — plugin adds /reading-progress)
# Proxies to the standalone briefing project's DB so the UI shows
# the same state as `briefing progress` on the command line.
# ------------------------------------------------------------------
progress_router = APIRouter(tags=["reading-progress"])


def _standalone_conn() -> sqlite3.Connection | None:
    """Open a connection to the standalone briefing DB, or None if it doesn't exist."""
    if not _STANDALONE_DB.exists():
        return None
    conn = sqlite3.connect(str(_STANDALONE_DB))
    conn.row_factory = sqlite3.Row
    return conn


@progress_router.get("")
async def get_all_progress():
    """Get reading progress for all series from the standalone briefing DB."""
    conn = _standalone_conn()
    if conn is None:
        return []
    try:
        rows = conn.execute(
            "SELECT series, current_index, list_path, last_advanced, paused "
            "FROM reading_progress ORDER BY series"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@progress_router.post("/{series}/pause")
async def pause_series(series: str):
    return _update_standalone_progress(series, "UPDATE reading_progress SET paused = 1 WHERE series = ?")


@progress_router.post("/{series}/resume")
async def resume_series(series: str):
    return _update_standalone_progress(series, "UPDATE reading_progress SET paused = 0 WHERE series = ?")


@progress_router.post("/{series}/skip")
async def skip_series_item(series: str):
    return _update_standalone_progress(
        series, "UPDATE reading_progress SET current_index = current_index + 1 WHERE series = ?"
    )


@progress_router.post("/{series}/unread")
async def mark_series_unread(series: str):
    """Mark current item as not read — rewind pointer by 1."""
    return _update_standalone_progress(
        series,
        "UPDATE reading_progress SET current_index = MAX(0, current_index - 1) WHERE series = ?",
    )


def _update_standalone_progress(series: str, sql: str) -> dict | JSONResponse:
    """Run an update on the standalone DB and return the updated row."""
    conn = _standalone_conn()
    if conn is None:
        return JSONResponse(status_code=404, content={"error": "Standalone briefing DB not found"})
    try:
        cursor = conn.execute(sql, (series,))
        conn.commit()
        if cursor.rowcount == 0:
            return JSONResponse(status_code=404, content={"error": "Unknown series"})
        row = conn.execute(
            "SELECT series, current_index, list_path, last_advanced, paused "
            "FROM reading_progress WHERE series = ?",
            (series,),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()


# ------------------------------------------------------------------
# Anki router (no prefix — plugin adds /anki)
# ------------------------------------------------------------------
anki_router = APIRouter(tags=["anki"])


@anki_router.get("/stats")
async def anki_stats():
    return get_anki_stats()
