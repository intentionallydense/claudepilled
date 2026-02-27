"""FastAPI router for file management endpoints.

Included by server.py via app.include_router(). All routes are
prefixed with /api/files by the router.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse

from claude_wrapper.file_db import FileDatabase

router = APIRouter(prefix="/api/files", tags=["files"])

# Set during server startup — see server.py
file_db: FileDatabase | None = None

MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5MB
MAX_EXTRACTED_CHARS = 1_000_000
ALLOWED_EXTENSIONS = {".pdf", ".md"}


def init(fdb: FileDatabase) -> None:
    """Called by server.py on startup to inject the file database."""
    global file_db
    file_db = fdb


# ------------------------------------------------------------------
# Routes — /tags BEFORE /{file_id} to avoid path capture
# ------------------------------------------------------------------

@router.get("/tags")
async def list_tags():
    return file_db.list_all_tags()


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    tags: str = Form(""),
):
    """Upload a .pdf or .md file with optional comma-separated tags."""
    filename = file.filename or "unknown"
    ext = ""
    if "." in filename:
        ext = "." + filename.rsplit(".", 1)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return JSONResponse(status_code=400, content={"error": f"Only .pdf and .md files are allowed, got {ext!r}"})

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return JSONResponse(status_code=400, content={"error": f"File too large (max {MAX_UPLOAD_BYTES // 1024 // 1024}MB)"})

    # Extract text content
    if ext == ".pdf":
        try:
            import pymupdf
            doc = pymupdf.open(stream=data, filetype="pdf")
            pages = []
            for page in doc:
                pages.append(page.get_text())
            doc.close()
            content = "\n\n".join(pages)
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": f"Failed to extract PDF text: {e}"})
    else:
        # .md — decode as text
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            content = data.decode("utf-8", errors="replace")

    # Limit extracted text
    if len(content) > MAX_EXTRACTED_CHARS:
        content = content[:MAX_EXTRACTED_CHARS]

    # Parse tags
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    result = file_db.save_file(filename, tag_list, content)
    # Don't return the full content in the upload response
    result.pop("content", None)
    return result


@router.get("")
async def list_files():
    return file_db.list_files()


@router.get("/{file_id}")
async def get_file(file_id: str):
    f = file_db.get_file(file_id)
    if f is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    # Don't return content in metadata endpoint
    f.pop("content", None)
    return f


@router.get("/{file_id}/content")
async def get_file_content(file_id: str):
    f = file_db.get_file(file_id)
    if f is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {"content": f["content"]}


@router.patch("/{file_id}")
async def update_file_tags(file_id: str, body: dict):
    tags = body.get("tags")
    if tags is None:
        return JSONResponse(status_code=400, content={"error": "Missing 'tags' field"})
    if not isinstance(tags, list):
        return JSONResponse(status_code=400, content={"error": "'tags' must be a list"})
    f = file_db.update_tags(file_id, tags)
    if f is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    f.pop("content", None)
    return f


@router.delete("/{file_id}")
async def delete_file(file_id: str):
    file_db.delete_file(file_id)
    return {"ok": True}
