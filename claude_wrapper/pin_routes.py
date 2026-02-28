"""FastAPI routes for moodboard pins.

Mounted by server.py as /api/pins/*.
"""

from __future__ import annotations

import base64
from typing import Optional

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from claude_wrapper.pin_db import PinDatabase

router = APIRouter(prefix="/api/pins", tags=["pins"])

_pin_db: PinDatabase | None = None


def init(pin_db: PinDatabase) -> None:
    global _pin_db
    _pin_db = pin_db


class CreatePinRequest(BaseModel):
    type: str  # 'image', 'text', 'link', 'message'
    content: str
    note: str | None = None
    source: str = "sylvia"
    conversation_id: str | None = None
    message_id: str | None = None
    tags: list[str] = []


class UpdatePinTagsRequest(BaseModel):
    tags: list[str]


@router.get("/tags")
async def list_pin_tags():
    """All unique tags across all pins."""
    return _pin_db.list_all_tags()


@router.get("")
async def list_pins(limit: int = 200):
    return _pin_db.list_pins(limit=limit)


@router.post("")
async def create_pin(req: CreatePinRequest):
    if req.type not in ("image", "text", "link", "message"):
        return JSONResponse(status_code=400, content={"error": "Invalid pin type"})
    pin = _pin_db.create(
        type=req.type,
        content=req.content,
        note=req.note,
        source=req.source,
        conversation_id=req.conversation_id,
        message_id=req.message_id,
        tags=req.tags,
    )
    return pin


@router.post("/upload")
async def upload_image_pin(
    file: UploadFile = File(...),
    note: Optional[str] = Form(None),
    source: str = Form("sylvia"),
):
    """Upload an image file as a pin. Stores as a data URI."""
    data = await file.read()
    media_type = file.content_type or "image/png"
    b64 = base64.b64encode(data).decode("ascii")
    content = f"data:{media_type};base64,{b64}"
    pin = _pin_db.create(
        type="image",
        content=content,
        note=note,
        source=source,
    )
    return pin


@router.patch("/{pin_id}")
async def update_pin_tags(pin_id: str, req: UpdatePinTagsRequest):
    """Update a pin's tags."""
    pin = _pin_db.update_tags(pin_id, req.tags)
    if pin is None:
        return JSONResponse(status_code=404, content={"error": "Pin not found"})
    return pin


@router.delete("/{pin_id}")
async def delete_pin(pin_id: str):
    _pin_db.delete(pin_id)
    return {"ok": True}
