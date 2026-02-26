"""FastAPI server with REST endpoints and WebSocket streaming."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from claude_wrapper.client import ClaudeClient
from claude_wrapper.conversation import ConversationManager
from claude_wrapper.couch import CouchOrchestrator
from claude_wrapper.db import Database
from claude_wrapper.models import AVAILABLE_MODELS, StreamEventType
from claude_wrapper.briefing_db import BriefingDatabase
from claude_wrapper.briefing_routes import (
    anki_router as briefing_anki_router,
    init as init_briefing_routes,
    progress_router as briefing_progress_router,
    router as briefing_router,
)
from claude_wrapper.briefing_sequential import init_all_series
from claude_wrapper.task_db import TaskDatabase
from claude_wrapper.task_routes import router as task_router
from claude_wrapper.task_routes import init as init_task_routes
from claude_wrapper.task_tools import BRAIN_DUMP_PROMPT, register_task_tools
from claude_wrapper.tools import ToolRegistry

load_dotenv()

app = FastAPI(title="Claude Wrapper")
app.include_router(task_router)
app.include_router(briefing_router)
app.include_router(briefing_progress_router)
app.include_router(briefing_anki_router)

# ---------------------------------------------------------------------------
# Globals — initialized in lifespan
# ---------------------------------------------------------------------------
manager: ConversationManager | None = None
couch: CouchOrchestrator | None = None
_static_dir = Path(__file__).resolve().parent.parent / "static"


def _load_example_tools() -> ToolRegistry:
    """Try to import example_tools.py from the project root."""
    candidates = [
        Path.cwd() / "example_tools.py",
        Path(__file__).resolve().parent.parent.parent / "example_tools.py",
    ]
    for path in candidates:
        if path.exists():
            spec = importlib.util.spec_from_file_location("example_tools", str(path))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, "registry"):
                return mod.registry
    return ToolRegistry()


@app.on_event("startup")
async def startup():
    global manager, couch
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("WARNING: ANTHROPIC_API_KEY not set. Set it in .env or environment.")
    client = ClaudeClient(api_key=api_key)
    registry = _load_example_tools()
    db = Database()
    task_db = TaskDatabase(db)
    register_task_tools(registry, task_db)
    init_task_routes(task_db)
    briefing_db = BriefingDatabase(db)
    init_all_series(briefing_db)
    manager = ConversationManager(client=client, tool_registry=registry, db=db)
    init_briefing_routes(briefing_db, task_db, client, manager)
    couch = CouchOrchestrator(client=client, db=db)

    # Migrate old setting key → new name (one-time, idempotent)
    old_val = db.get_setting("default_system_prompt")
    if old_val is not None and db.get_setting("universal_prompt") is None:
        db.set_setting("universal_prompt", old_val)

    # Seed built-in "Brain dump" prompt if it doesn't exist yet
    if db.get_prompt("brain_dump") is None:
        db.save_prompt("brain_dump", "Brain dump", BRAIN_DUMP_PROMPT)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class CreateConversationRequest(BaseModel):
    title: str = "New conversation"
    system_prompt: str = ""
    model: str | None = None
    prompt_id: str | None = None


class UpdateConversationRequest(BaseModel):
    model: str | None = None
    title: str | None = None
    system_prompt: str | None = None
    prompt_id: str | None = None
    clear_prompt: bool = False  # set True to remove the saved prompt


class ChatMessage(BaseModel):
    message: str


class EditMessageRequest(BaseModel):
    parent_id: str
    message: str
    thinking_budget: int | None = None


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/models")
async def list_models():
    return AVAILABLE_MODELS


@app.get("/api/conversations")
async def list_conversations():
    return manager.list_conversations()


@app.post("/api/conversations")
async def create_conversation(req: CreateConversationRequest):
    system_prompt = req.system_prompt
    model = req.model
    # Don't bake universal_prompt into the conversation — it's composed at call time
    if not model:
        model = manager.db.get_setting("default_model") or None
    conv = manager.create_conversation(
        title=req.title,
        system_prompt=system_prompt,
        model=model,
        prompt_id=req.prompt_id,
    )
    return {"id": conv.id, "title": conv.title, "model": conv.model}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    conv = manager.get_conversation(conversation_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return conv.model_dump(mode="json")


@app.patch("/api/conversations/{conversation_id}")
async def update_conversation(conversation_id: str, req: UpdateConversationRequest):
    if req.model:
        manager.update_model(conversation_id, req.model)
    if req.title:
        manager.db.update_conversation_title(conversation_id, req.title)
    if req.system_prompt is not None:
        manager.db.update_conversation_system_prompt(conversation_id, req.system_prompt)
    if req.clear_prompt:
        manager.db.update_conversation_prompt_id(conversation_id, None)
    elif req.prompt_id is not None:
        manager.db.update_conversation_prompt_id(conversation_id, req.prompt_id)
    conv = manager.get_conversation(conversation_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return {
        "id": conv.id, "model": conv.model, "title": conv.title,
        "system_prompt": conv.system_prompt, "prompt_id": conv.prompt_id,
    }


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    manager.delete_conversation(conversation_id)
    return {"ok": True}


@app.get("/api/conversations/{conversation_id}/cost")
async def get_conversation_cost(conversation_id: str):
    return manager.db.get_conversation_cost(conversation_id)


@app.get("/api/conversations/{conversation_id}/tree")
async def get_conversation_tree(conversation_id: str):
    return manager.db.get_tree(conversation_id)


@app.post("/api/conversations/{conversation_id}/switch/{node_id}")
async def switch_branch(conversation_id: str, node_id: str):
    conv = manager.switch_branch(conversation_id, node_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return conv.model_dump(mode="json")


@app.get("/api/tools")
async def list_tools():
    return [t.to_api_format() for t in manager.tools.list_tools()]


# ---------------------------------------------------------------------------
# WebSocket streaming
# ---------------------------------------------------------------------------

@app.websocket("/api/chat/{conversation_id}")
async def websocket_chat(ws: WebSocket, conversation_id: str):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            payload = json.loads(data)
            user_text = payload.get("message", "")
            thinking_budget = payload.get("thinking_budget", None)
            action = payload.get("action", "chat")

            if action == "edit":
                parent_id = payload.get("parent_id", "")
                if not user_text or not parent_id:
                    continue
                async for event in manager.edit_message(
                    conversation_id,
                    parent_id=parent_id,
                    new_text=user_text,
                    thinking_budget=thinking_budget,
                ):
                    await ws.send_text(json.dumps(event.to_ws_json()))
            else:
                if not user_text:
                    continue
                async for event in manager.stream_chat(
                    conversation_id,
                    user_text,
                    thinking_budget=thinking_budget,
                ):
                    await ws.send_text(json.dumps(event.to_ws_json()))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await ws.send_text(json.dumps({
                "type": StreamEventType.ERROR.value,
                "error": str(exc),
            }))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Settings page route + API
# ---------------------------------------------------------------------------

@app.get("/settings")
async def settings_page():
    return FileResponse(str(_static_dir / "settings.html"))


@app.get("/api/settings")
async def get_settings():
    return manager.db.get_all_settings()


@app.put("/api/settings")
async def put_settings(body: dict):
    allowed = {"universal_prompt", "default_model"}
    for key, value in body.items():
        if key in allowed:
            manager.db.set_setting(key, value)
    return manager.db.get_all_settings()


# ---------------------------------------------------------------------------
# Prompts library
# ---------------------------------------------------------------------------

class CreatePromptRequest(BaseModel):
    name: str
    content: str = ""


class UpdatePromptRequest(BaseModel):
    name: str | None = None
    content: str | None = None


@app.get("/api/prompts")
async def list_prompts():
    return manager.db.list_prompts()


@app.post("/api/prompts")
async def create_prompt(req: CreatePromptRequest):
    prompt_id = uuid.uuid4().hex[:12]
    return manager.db.save_prompt(prompt_id, req.name, req.content)


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, req: UpdatePromptRequest):
    existing = manager.db.get_prompt(prompt_id)
    if existing is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    name = req.name if req.name is not None else existing["name"]
    content = req.content if req.content is not None else existing["content"]
    return manager.db.save_prompt(prompt_id, name, content)


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str):
    manager.db.delete_prompt(prompt_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Tasks page route
# ---------------------------------------------------------------------------

@app.get("/tasks")
async def tasks_page():
    return FileResponse(str(_static_dir / "tasks.html"))


# ---------------------------------------------------------------------------
# Briefing page route
# ---------------------------------------------------------------------------

@app.get("/briefing")
async def briefing_page():
    return FileResponse(str(_static_dir / "briefing.html"))


# ---------------------------------------------------------------------------
# Couch page route
# ---------------------------------------------------------------------------

@app.get("/couch")
async def couch_page():
    return FileResponse(str(_static_dir / "couch.html"))


# ---------------------------------------------------------------------------
# Couch REST endpoints
# ---------------------------------------------------------------------------

class CreateCouchSessionRequest(BaseModel):
    model_a: str = "claude-opus-4-6"
    model_b: str = "claude-3-opus-20240229"


@app.get("/api/couch/sessions")
async def list_couch_sessions():
    return couch.list_sessions()


@app.post("/api/couch/sessions")
async def create_couch_session(req: CreateCouchSessionRequest):
    return couch.create_session(model_a_id=req.model_a, model_b_id=req.model_b)


@app.get("/api/couch/sessions/{session_id}")
async def get_couch_session(session_id: str):
    conv = couch.get_session(session_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return conv.model_dump(mode="json")


@app.delete("/api/couch/sessions/{session_id}")
async def delete_couch_session(session_id: str):
    couch.delete_session(session_id)
    return {"ok": True}


@app.get("/api/couch/sessions/{session_id}/cost")
async def get_couch_session_cost(session_id: str):
    return couch.get_cost(session_id)


# ---------------------------------------------------------------------------
# Couch WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/api/couch/{session_id}")
async def websocket_couch(ws: WebSocket, session_id: str):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            payload = json.loads(data)
            content = payload.get("content", "")
            input_type = payload.get("type", "share")

            if not content:
                continue

            async for event in couch.stream_turns(session_id, content, input_type):
                await ws.send_text(json.dumps(event.to_ws_json()))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await ws.send_text(json.dumps({
                "type": StreamEventType.ERROR.value,
                "error": str(exc),
            }))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Static files (must be last so it doesn't shadow API routes)
# ---------------------------------------------------------------------------

if _static_dir.exists():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="static")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    print(f"Starting Claude Wrapper on http://localhost:{port}")
    uvicorn.run(
        "claude_wrapper.server:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )


if __name__ == "__main__":
    main()
