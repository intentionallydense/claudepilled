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
    """Pin creation request.

    Accepts both `content` and `text` for the pin body, and defaults `type`
    to "text" — Apple Shortcuts may send field names that differ from our
    canonical schema.
    """
    type: str = "text"  # 'image', 'text', 'link', 'message'
    content: str | None = None
    text: str | None = None  # alias for content (Shortcuts sends this)
    note: str | None = None
    source: str = "sylvia"
    conversation_id: str | None = None
    message_id: str | None = None
    tags: list[str] | str = []

    def get_content(self) -> str:
        return self.content or self.text or ""

    def get_tags(self) -> list[str]:
        """Normalize tags — accepts a list or comma-separated string.

        Apple Shortcuts sends tags as a plain string instead of a JSON array,
        so we handle both formats.
        """
        if isinstance(self.tags, str):
            return [t.strip() for t in self.tags.split(",") if t.strip()]
        return self.tags


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

    pin_content = req.get_content()
    if not pin_content:
        return JSONResponse(status_code=400, content={"error": "content is required"})
    if req.type not in ("image", "text", "link", "message"):
        return JSONResponse(status_code=400, content={"error": "Invalid pin type"})
    pin = _pin_db.create(
        type=req.type,
        content=pin_content,
        note=req.note,
        source=req.source,
        conversation_id=req.conversation_id,
        message_id=req.message_id,
        tags=req.get_tags(),
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


@router.post("/{pin_id}/archive")
async def archive_pin(pin_id: str):
    """Archive a pin — hides from board but preserves data."""
    _pin_db.archive(pin_id)
    return {"ok": True}


@router.delete("/{pin_id}")
async def delete_pin(pin_id: str):
    _pin_db.delete(pin_id)
    return {"ok": True}
