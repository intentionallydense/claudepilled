"""FastAPI routers for the daily briefing system.

Three sub-routers: briefing (assembly + retrieval), reading progress
(series management), and anki (stats proxy). The plugin __init__.py
combines them into a single router mounted at /api.

Follows the module-level state + init() pattern from the tasks plugin.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .anki import get_anki_stats
from .assembly import assemble_briefing
from .db import BriefingDatabase
from llm_interface.client import ClaudeClient
from llm_interface.conversation import ConversationManager
from llm_interface.task_db import TaskDatabase

# ------------------------------------------------------------------
# Module-level state — set during server startup via init()
# ------------------------------------------------------------------
briefing_db: BriefingDatabase | None = None
task_db: TaskDatabase | None = None
client: ClaudeClient | None = None
conversation_manager: ConversationManager | None = None
_svc = None  # ServiceRegistry — lazy fallback for conversation_manager


def init(bdb: BriefingDatabase, tdb: TaskDatabase = None, client_ref: ClaudeClient = None,
         mgr: ConversationManager = None, svc=None) -> None:
    """Called by plugin on_load or server.py to inject dependencies.

    mgr (ConversationManager) may be None at plugin load time — route
    handlers that need it will fall back to the service registry.
    """
    global briefing_db, task_db, client, conversation_manager, _svc
    briefing_db = bdb
    task_db = tdb
    client = client_ref
    conversation_manager = mgr
    _svc = svc


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
    """Assemble today's briefing. Idempotent unless force=true query param."""
    result = assemble_briefing(briefing_db, task_db, client, force=True)
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

    # Resolve ConversationManager: direct ref first, service registry fallback
    mgr = conversation_manager or (_svc.get("conversation_manager") if _svc else None)
    if mgr is None:
        return JSONResponse(status_code=503, content={"error": "ConversationManager not available"})

    # Create new conversation with briefing text as system prompt
    conv = mgr.create_conversation(
        title=f"Briefing chat — {date_str}",
        system_prompt=briefing["assembled_text"],
    )
    briefing_db.set_chat_conversation_id(date_str, conv.id)
    return {"conversation_id": conv.id}


# ------------------------------------------------------------------
# Reading progress router (no prefix — plugin adds /reading-progress)
# ------------------------------------------------------------------
progress_router = APIRouter(tags=["reading-progress"])


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


@progress_router.post("/{series}/unread")
async def mark_series_unread(series: str):
    """Mark current item as not read — it will re-appear tomorrow."""
    result = briefing_db.mark_unread(series)
    if result is None:
        return JSONResponse(status_code=404, content={"error": "Unknown series"})
    return result


# ------------------------------------------------------------------
# Anki router (no prefix — plugin adds /anki)
# ------------------------------------------------------------------
anki_router = APIRouter(tags=["anki"])


@anki_router.get("/stats")
async def anki_stats():
    return get_anki_stats()
