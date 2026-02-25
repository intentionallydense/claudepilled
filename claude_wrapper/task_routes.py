"""FastAPI router for task management endpoints.

Included by server.py via app.include_router(). All routes are
prefixed with /api/tasks by the router.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from claude_wrapper.task_db import TaskDatabase
from claude_wrapper.task_urgency import sort_by_urgency

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

# Set during server startup — see server.py
task_db: TaskDatabase | None = None


def init(db: TaskDatabase) -> None:
    """Called by server.py on startup to inject the task database."""
    global task_db
    task_db = db


# ------------------------------------------------------------------
# Request models
# ------------------------------------------------------------------

class CreateTaskRequest(BaseModel):
    title: str
    description: str = ""
    priority: str | None = None
    project: str | None = None
    tags: list[str] = []
    due: str | None = None
    depends: list[str] = []
    wait: str | None = None
    recurrence: str | None = None


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    priority: str | None = None
    project: str | None = None
    tags: list[str] | None = None
    due: str | None = None
    depends: list[str] | None = None
    wait: str | None = None
    recurrence: str | None = None
    status: str | None = None


class AnnotateRequest(BaseModel):
    text: str


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("")
async def list_tasks(
    status: str | None = None,
    project: str | None = None,
    tag: str | None = None,
    include_waiting: bool = False,
):
    """List tasks sorted by urgency. Excludes deleted and waiting by default."""
    tasks = task_db.list_tasks(
        status=status, project=project, tag=tag,
        include_waiting=include_waiting,
    )
    # Deserialize JSON fields for response
    for t in tasks:
        _deserialize(t)
    return sort_by_urgency(tasks)


@router.get("/summary")
async def task_summary():
    """Urgency-sorted summary for Claude context injection."""
    tasks = task_db.list_tasks()
    for t in tasks:
        _deserialize(t)
    sorted_tasks = sort_by_urgency(tasks)
    # Return top 20 with minimal fields
    summary = []
    for t in sorted_tasks[:20]:
        item = {
            "id": t["id"],
            "title": t["title"],
            "urgency": t["urgency"],
            "status": t["status"],
            "priority": t["priority"],
            "project": t["project"],
            "due": t["due"],
            "tags": t["tags"],
        }
        if t["description"]:
            item["description"] = t["description"][:200]
        summary.append(item)
    return {"tasks": summary, "total_count": len(sorted_tasks)}


@router.get("/projects")
async def list_projects():
    return task_db.list_projects()


@router.get("/tags")
async def list_tags():
    return task_db.list_tags()


@router.get("/{task_id}")
async def get_task(task_id: str):
    task = task_db.get(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


@router.post("")
async def create_task(req: CreateTaskRequest):
    return task_db.create(**req.model_dump())


@router.patch("/{task_id}")
async def update_task(task_id: str, req: UpdateTaskRequest):
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        return JSONResponse(status_code=400, content={"error": "No fields to update"})
    task = task_db.update(task_id, **updates)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


@router.delete("/{task_id}")
async def delete_task(task_id: str):
    task_db.delete(task_id)
    return {"ok": True}


@router.post("/{task_id}/complete")
async def complete_task(task_id: str):
    task = task_db.complete(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


@router.post("/{task_id}/start")
async def start_task(task_id: str):
    task = task_db.start(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


@router.post("/{task_id}/stop")
async def stop_task(task_id: str):
    task = task_db.stop(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


@router.post("/{task_id}/annotate")
async def annotate_task(task_id: str, req: AnnotateRequest):
    task = task_db.annotate(task_id, req.text)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    _deserialize(task)
    return task


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _deserialize(task: dict) -> None:
    """Ensure JSON fields are parsed for API responses."""
    for field in ("tags", "depends", "annotations"):
        val = task.get(field)
        if isinstance(val, str):
            task[field] = json.loads(val)
