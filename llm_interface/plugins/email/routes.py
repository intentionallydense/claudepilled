"""FastAPI router for email ingestion endpoints.

Mounted by the email plugin at /api/emails. Routes have no prefix here —
the plugin loader applies the prefix via route_prefix.

Used by: tasks page (ingestion feed sidebar), CLI manual trigger.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .db import EmailDatabase

router = APIRouter(tags=["emails"])

# Set during plugin init — see __init__.py
_email_db: EmailDatabase | None = None
_task_db = None
_db = None


def init(email_db: EmailDatabase, task_db=None, db=None) -> None:
    """Called by the email plugin on_load to inject database instances."""
    global _email_db, _task_db, _db
    _email_db = email_db
    _task_db = task_db
    _db = db


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("")
async def list_emails(limit: int = 20, include_archived: bool = False):
    """List recent ingested emails, newest first."""
    return _email_db.list_recent(limit=limit, include_archived=include_archived)


@router.get("/{entry_id}")
async def get_email(entry_id: str):
    entry = _email_db.get(entry_id)
    if entry is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return entry


@router.patch("/{entry_id}")
async def archive_email(entry_id: str):
    """Toggle archive status on an email log entry."""
    entry = _email_db.archive(entry_id)
    if entry is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return entry


@router.get("/status")
async def ingestion_status():
    """Return current model health status for the tasks page banner."""
    from .ingestion import ingestion_status
    return ingestion_status


@router.post("/ingest")
async def trigger_ingest():
    """Manual trigger: fetch and process inbox emails. Returns results."""
    if not _task_db:
        return JSONResponse(status_code=500, content={"error": "Task DB not initialized"})

    from .ingestion import process_inbox, _resolve_parse_prompt

    parse_prompt = _resolve_parse_prompt(_db) if _db else None

    # Run the synchronous IMAP + LLM pipeline in a thread
    results = await asyncio.to_thread(
        process_inbox, _email_db, _task_db, parse_prompt=parse_prompt,
    )
    return {"processed": len(results), "entries": results}
