"""FastAPI server with REST endpoints and WebSocket streaming."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from claude_wrapper.client import ClaudeClient
from claude_wrapper.conversation import ConversationManager
from claude_wrapper.backrooms import BackroomsOrchestrator
from claude_wrapper.db import Database
from claude_wrapper.models import AVAILABLE_MODELS, StreamEventType, get_available_models, get_available_providers
from claude_wrapper.briefing_db import BriefingDatabase
from claude_wrapper.briefing_routes import (
    anki_router as briefing_anki_router,
    init as init_briefing_routes,
    progress_router as briefing_progress_router,
    router as briefing_router,
)
from claude_wrapper.briefing_sequential import init_all_series
from claude_wrapper.file_db import FileDatabase
from claude_wrapper.file_routes import router as file_router
from claude_wrapper.file_routes import init as init_file_routes
from claude_wrapper.task_db import TaskDatabase
from claude_wrapper.task_routes import router as task_router
from claude_wrapper.task_routes import init as init_task_routes
from claude_wrapper.pin_db import PinDatabase
from claude_wrapper.pin_routes import router as pin_router
from claude_wrapper.pin_routes import init as init_pin_routes
from claude_wrapper.email_db import EmailDatabase
from claude_wrapper.email_routes import router as email_router
from claude_wrapper.email_routes import init as init_email_routes
from claude_wrapper.pin_tools import register_pin_tools
from claude_wrapper.task_tools import BRAIN_DUMP_PROMPT, register_task_tools
from claude_wrapper.tools import ToolRegistry

load_dotenv()

app = FastAPI(title="Claude Wrapper")
app.include_router(file_router)
app.include_router(task_router)
app.include_router(briefing_router)
app.include_router(briefing_progress_router)
app.include_router(briefing_anki_router)
app.include_router(pin_router)
app.include_router(email_router)

# ---------------------------------------------------------------------------
# Globals — initialized in lifespan
# ---------------------------------------------------------------------------
manager: ConversationManager | None = None
backrooms: BackroomsOrchestrator | None = None
file_db_instance: FileDatabase | None = None
pin_db_instance: PinDatabase | None = None
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
    global manager, backrooms, file_db_instance, pin_db_instance
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("WARNING: ANTHROPIC_API_KEY not set. Set it in .env or environment.")
    client = ClaudeClient(api_key=api_key)
    registry = _load_example_tools()
    db = Database()
    task_db = TaskDatabase(db)
    register_task_tools(registry, task_db)
    init_task_routes(task_db)
    file_db_instance = FileDatabase(db)
    init_file_routes(file_db_instance)
    pin_db_instance = PinDatabase(db)
    register_pin_tools(registry, pin_db_instance)
    init_pin_routes(pin_db_instance)
    email_db = EmailDatabase(db)
    init_email_routes(email_db, task_db, db=db)
    briefing_db = BriefingDatabase(db)
    init_all_series(briefing_db)
    manager = ConversationManager(client=client, tool_registry=registry, db=db, file_db=file_db_instance, pin_db=pin_db_instance)
    init_briefing_routes(briefing_db, task_db, client, manager)
    backrooms = BackroomsOrchestrator(client=client, db=db, file_db=file_db_instance, pin_db=pin_db_instance)

    # Seed built-in "Brain dump" prompt if it doesn't exist yet
    if db.get_prompt("brain_dump") is None:
        db.save_prompt("brain_dump", "Brain dump", BRAIN_DUMP_PROMPT)

    # Seed built-in "Email ingestion" prompt if it doesn't exist yet
    from claude_wrapper.email_ingestion import _DEFAULT_PARSE_PROMPT
    if db.get_prompt("email_ingestion") is None:
        db.save_prompt("email_ingestion", "Email ingestion", _DEFAULT_PARSE_PROMPT)
        db.set_setting("email_ingestion_prompt_id", "email_ingestion")


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


class SyncChatRequest(BaseModel):
    """Request body for the synchronous chat endpoint (used by Apple Watch shortcut)."""
    message: str
    thinking_budget: int | None = None


class EditMessageRequest(BaseModel):
    parent_id: str
    message: str
    thinking_budget: int | None = None


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/api/models")
async def list_models():
    """Return models filtered to only providers with configured API keys."""
    return get_available_models()


@app.get("/api/providers/status")
async def provider_status():
    """Return which providers have API keys configured."""
    return get_available_providers()


@app.get("/api/conversations")
async def list_conversations(limit: int | None = None):
    convos = manager.list_conversations()
    if limit is not None:
        convos = convos[:limit]
    return convos


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


@app.get("/api/conversations/search")
async def search_conversations(q: str = "", limit: int = 20):
    """Search message content across all conversations."""
    return manager.db.search_messages(q, limit=limit)


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    conv = manager.get_conversation(conversation_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    data = conv.model_dump(mode="json")
    meta = manager.db.get_conversation_metadata(conversation_id)
    data["_compactions"] = (meta or {}).get("compactions", [])
    # Include type and metadata for backrooms sessions
    conn = manager.db._connect()
    type_row = conn.execute("SELECT type, metadata FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    conn.close()
    if type_row:
        data["type"] = type_row["type"] or "chat"
        if type_row["metadata"]:
            from claude_wrapper.backrooms import _normalize_metadata
            data["_metadata"] = _normalize_metadata(json.loads(type_row["metadata"]))
    return data


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


@app.post("/api/chat/{conversation_id}/message")
async def chat_sync(conversation_id: str, req: SyncChatRequest):
    """Synchronous chat endpoint — sends a message and returns the full response.

    Consumes stream_chat() internally, collecting all text deltas into a single
    response. Used by Apple Watch Shortcuts and other HTTP-only clients that
    can't do WebSocket.
    """
    conv = manager.get_conversation(conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Brain dump conversations use GLM5 (cheap, has tool use)
    if conv.prompt_id == "brain_dump" and conv.model != "openrouter/z-ai/glm-5":
        manager.db.update_conversation_model(conversation_id, "openrouter/z-ai/glm-5")

    text_parts = []
    title = None
    async for event in manager.stream_chat(conversation_id, req.message, req.thinking_budget):
        if event.type == StreamEventType.TEXT_DELTA:
            text_parts.append(event.text)
        elif event.type == StreamEventType.TITLE_UPDATE:
            title = event.text
        elif event.type == StreamEventType.ERROR:
            raise HTTPException(status_code=400, detail=event.error)

    # Reload conversation to get current_leaf_id (the assistant message just created)
    conv = manager.db.load_conversation(conversation_id)
    return {
        "text": "".join(text_parts),
        "message_id": conv.current_leaf_id if conv else None,
        "title": title or (conv.title if conv else None),
    }


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
# WebSocket streaming — background task pattern
# ---------------------------------------------------------------------------
# Streams run in asyncio.Tasks so they complete (and save to DB) even if
# the WebSocket disconnects mid-stream.  The WS handler reads from a Queue.

_active_chat_tasks: dict[str, asyncio.Task] = {}
_active_backrooms_tasks: dict[str, asyncio.Task] = {}


async def _handle_tag_injection(ws: WebSocket, conversation_id: str, inject_tags: list[str]) -> None:
    """Resolve tags to files/pins and emit context_update. Shared by chat and backrooms WS handlers."""
    if not inject_tags:
        return
    if file_db_instance:
        matched_files = file_db_instance.get_files_by_tags(inject_tags)
        if matched_files:
            new_ids = [f["id"] for f in matched_files]
            file_db_instance.add_active_file_ids(conversation_id, new_ids)
    if pin_db_instance:
        matched_pins = pin_db_instance.get_pins_by_tags(inject_tags)
        if matched_pins:
            new_pin_ids = [p["id"] for p in matched_pins]
            pin_db_instance.add_active_pin_ids(conversation_id, new_pin_ids)
    context_data = _build_context_response(conversation_id)
    await ws.send_text(json.dumps({
        "type": StreamEventType.CONTEXT_UPDATE.value,
        **context_data,
    }))


async def _run_stream_to_completion(
    generator: AsyncGenerator,
    queue: asyncio.Queue,
    task_dict: dict[str, asyncio.Task],
    key: str,
) -> None:
    """Consume a streaming generator to completion, pushing events to queue."""
    try:
        async for event in generator:
            await queue.put(event.to_ws_json())
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        await queue.put({
            "type": StreamEventType.ERROR.value,
            "error": str(exc),
        })
    finally:
        await queue.put(None)  # sentinel: stream is done
        task_dict.pop(key, None)


@app.websocket("/api/chat/{conversation_id}")
async def websocket_chat(ws: WebSocket, conversation_id: str):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            payload = json.loads(data)
            # message can be a string or a list of content blocks (for images)
            user_message = payload.get("message", "")
            # For display/tag extraction, get just the text portion
            if isinstance(user_message, list):
                user_text = "".join(
                    b.get("text", "") for b in user_message if b.get("type") == "text"
                )
            else:
                user_text = user_message
            thinking_budget = payload.get("thinking_budget", None)
            action = payload.get("action", "chat")
            inject_tags = payload.get("inject_tags", [])

            # Handle tag injection before processing the message
            await _handle_tag_injection(ws, conversation_id, inject_tags)

            # Tag-only messages (no text content, just tags): activate context and skip chat
            if not user_text and inject_tags:
                await ws.send_text(json.dumps({
                    "type": StreamEventType.MESSAGE_DONE.value,
                }))
                continue

            if action == "compact":
                try:
                    result = await manager.compact_conversation(conversation_id)
                    await ws.send_text(json.dumps({"type": "compaction_done", **result}))
                except ValueError as e:
                    await ws.send_text(json.dumps({"type": "error", "error": str(e)}))
                continue

            if action == "init":
                # Model speaks first — GLM5 via OpenRouter (cheap, has tool use)
                gen = manager.stream_init(conversation_id, model="openrouter/z-ai/glm-5")
            elif action == "edit":
                parent_id = payload.get("parent_id") or None
                if not user_text and not isinstance(user_message, list):
                    continue
                gen = manager.edit_message(
                    conversation_id,
                    parent_id=parent_id,
                    new_content=user_message,
                    thinking_budget=thinking_budget,
                )
            else:
                if not user_text and not isinstance(user_message, list):
                    continue
                gen = manager.stream_chat(
                    conversation_id,
                    user_message,
                    thinking_budget=thinking_budget,
                )

            # Run stream in background task so it completes even if WS drops
            queue: asyncio.Queue = asyncio.Queue()
            task = asyncio.create_task(
                _run_stream_to_completion(
                    gen, queue, _active_chat_tasks, conversation_id,
                )
            )
            _active_chat_tasks[conversation_id] = task

            while True:
                event_data = await queue.get()
                if event_data is None:
                    break
                await ws.send_text(json.dumps(event_data))

    except WebSocketDisconnect:
        pass  # background task keeps running, message will be saved
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
    allowed = {"universal_prompt", "universal_prompt_id", "default_model", "backrooms_seat_1_suffix", "backrooms_seat_2_suffix", "backrooms_seat_3_suffix", "backrooms_seat_4_suffix", "backrooms_seat_5_suffix", "email_ingestion_prompt_id"}
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
    category: str = "chat"


class UpdatePromptRequest(BaseModel):
    name: str | None = None
    content: str | None = None


@app.get("/api/prompts")
async def list_prompts(category: str | None = None):
    return manager.db.list_prompts(category=category)


@app.post("/api/prompts")
async def create_prompt(req: CreatePromptRequest):
    prompt_id = uuid.uuid4().hex[:12]
    return manager.db.save_prompt(prompt_id, req.name, req.content, category=req.category)


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, req: UpdatePromptRequest):
    existing = manager.db.get_prompt(prompt_id)
    if existing is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    name = req.name if req.name is not None else existing["name"]
    content = req.content if req.content is not None else existing["content"]
    category = existing.get("category", "chat")
    return manager.db.save_prompt(prompt_id, name, content, category=category)


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
# Backrooms page redirect (legacy /couch URL)
# ---------------------------------------------------------------------------

from fastapi.responses import RedirectResponse

@app.get("/couch")
async def couch_redirect():
    return RedirectResponse(url="/")


# ---------------------------------------------------------------------------
# Backrooms REST endpoints
# ---------------------------------------------------------------------------

class CreateBackroomsSessionRequest(BaseModel):
    participants: list[str]  # list of model IDs (2-5 participants)


@app.get("/api/backrooms/sessions")
async def list_backrooms_sessions():
    return backrooms.list_sessions()


@app.post("/api/backrooms/sessions")
async def create_backrooms_session(req: CreateBackroomsSessionRequest):
    parts = [{"id": mid} for mid in req.participants]
    return backrooms.create_session(participants=parts)


@app.get("/api/backrooms/sessions/{session_id}")
async def get_backrooms_session(session_id: str):
    conv = backrooms.get_session(session_id)
    if conv is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return conv.model_dump(mode="json")


@app.delete("/api/backrooms/sessions/{session_id}")
async def delete_backrooms_session(session_id: str):
    backrooms.delete_session(session_id)
    return {"ok": True}


@app.post("/api/backrooms/sessions/{session_id}/duplicate")
async def duplicate_backrooms_session(session_id: str):
    """Create a new empty session with the same participants and settings."""
    return backrooms.duplicate_session(session_id)


@app.get("/api/backrooms/sessions/{session_id}/cost")
async def get_backrooms_session_cost(session_id: str):
    return backrooms.get_cost(session_id)


@app.get("/api/backrooms/sessions/{session_id}/prompts")
async def get_backrooms_prompts(session_id: str):
    """Get prompt IDs for a backrooms session (v2 seat-indexed format)."""
    meta = backrooms.db.get_conversation_metadata(session_id)
    if meta is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    from claude_wrapper.backrooms import _normalize_metadata
    normalized = _normalize_metadata(meta)
    return {"prompt_ids": normalized.get("prompt_ids", {})}


class UpdateBackroomsPromptsRequest(BaseModel):
    prompt_ids: dict[str, str]  # seat_index → prompt_id (empty string to reset)


@app.patch("/api/backrooms/sessions/{session_id}/prompts")
async def update_backrooms_prompts(session_id: str, req: UpdateBackroomsPromptsRequest):
    """Update prompt selection for a backrooms session. Empty string resets to default."""
    meta = backrooms.db.get_conversation_metadata(session_id)
    if meta is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    if "prompt_ids" not in meta:
        meta["prompt_ids"] = {}
    for seat_idx, pid in req.prompt_ids.items():
        meta["prompt_ids"][seat_idx] = pid if pid else None

    backrooms.db.update_conversation_metadata(session_id, meta)
    return {"ok": True}


@app.get("/api/backrooms/sessions/{session_id}/stats")
async def get_backrooms_stats(session_id: str):
    """Get stats for a backrooms session from metadata."""
    meta = backrooms.db.get_conversation_metadata(session_id)
    if meta is None:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return meta.get("last_stats", {})


# ---------------------------------------------------------------------------
# Backrooms WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/api/backrooms/{session_id}")
async def websocket_backrooms(ws: WebSocket, session_id: str):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_text()
            payload = json.loads(data)
            action = payload.get("action")
            pre_formatted = False

            # Handle speed control action
            if action == "set_speed":
                speed = payload.get("speed", 1.0)
                try:
                    speed = float(speed)
                    if speed not in (0.5, 1.0, 2.0, 5.0):
                        speed = 1.0
                except (ValueError, TypeError):
                    speed = 1.0
                meta = backrooms.db.get_conversation_metadata(session_id) or {}
                meta["speed"] = speed
                backrooms.db.update_conversation_metadata(session_id, meta)
                await ws.send_text(json.dumps({"type": "speed_updated", "speed": speed}))
                continue

            # Handle iteration count control
            if action == "set_iterations":
                iterations = payload.get("iterations", 1)
                try:
                    iterations = max(1, min(10, int(iterations)))
                except (ValueError, TypeError):
                    iterations = 1
                meta = backrooms.db.get_conversation_metadata(session_id) or {}
                meta["iterations"] = iterations
                backrooms.db.update_conversation_metadata(session_id, meta)
                await ws.send_text(json.dumps({"type": "iterations_updated", "iterations": iterations}))
                continue

            # Handle step mode toggle
            if action == "set_step_mode":
                step_mode = bool(payload.get("step_mode", False))
                meta = backrooms.db.get_conversation_metadata(session_id) or {}
                meta["step_mode"] = step_mode
                backrooms.db.update_conversation_metadata(session_id, meta)
                await ws.send_text(json.dumps({"type": "step_mode_updated", "step_mode": step_mode}))
                continue

            # Handle thinking toggle
            if action == "set_thinking":
                enabled = bool(payload.get("enabled", False))
                budget = int(payload.get("budget", 10000)) if enabled else None
                meta = backrooms.db.get_conversation_metadata(session_id) or {}
                meta["thinking_budget"] = budget
                backrooms.db.update_conversation_metadata(session_id, meta)
                await ws.send_text(json.dumps({
                    "type": "thinking_updated",
                    "enabled": enabled,
                    "budget": budget,
                }))
                continue

            # Handle next-speaker override (one-shot, stored in memory not DB)
            if action == "set_next_speaker":
                next_speaker = payload.get("speaker", None)
                meta = backrooms.db.get_conversation_metadata(session_id) or {}
                meta["next_speaker"] = next_speaker
                backrooms.db.update_conversation_metadata(session_id, meta)
                await ws.send_text(json.dumps({"type": "next_speaker_updated", "speaker": next_speaker}))
                continue

            # Handle tag injection (shared helper)
            inject_tags = payload.get("inject_tags", [])
            await _handle_tag_injection(ws, session_id, inject_tags)

            # Tag-only message: activate context and skip chat
            content_for_check = payload.get("content", "")
            if isinstance(content_for_check, str):
                has_text = bool(content_for_check.strip())
            else:
                has_text = any(
                    b.get("text") or b.get("type") == "image" for b in content_for_check
                )
            if not has_text and inject_tags:
                await ws.send_text(json.dumps({
                    "type": StreamEventType.MESSAGE_DONE.value,
                }))
                continue

            # Edit: branch from a parent, re-send edited curator input
            if action == "edit":
                parent_id = payload.get("parent_id")
                # Always reset leaf — even when parent_id is None (first message edit)
                backrooms.db.set_current_leaf(session_id, parent_id)
                content = payload.get("content", "")
                input_type = payload.get("type", "share")
            # Regenerate: re-run from a curator message's starting point
            elif action == "regenerate":
                curator_msg_id = payload.get("curator_msg_id")
                if not curator_msg_id:
                    continue
                regen_msg = backrooms.db.get_message(curator_msg_id)
                if not regen_msg:
                    continue
                # Reset leaf to the curator message's parent (before it was sent)
                if regen_msg.parent_id:
                    backrooms.db.set_current_leaf(session_id, regen_msg.parent_id)
                # Re-send with the original stored content (already formatted)
                # Convert ContentBlock list to dicts for stream_turns
                if isinstance(regen_msg.content, list):
                    content = [b.model_dump(exclude_none=True) for b in regen_msg.content]
                else:
                    content = regen_msg.content
                input_type = "share"
                pre_formatted = True
            else:
                # Normal message
                content = payload.get("content", "")
                input_type = payload.get("type", "share")

            # For emptiness check, look at text portion
            if isinstance(content, list):
                has_content = any(
                    b.get("text") or b.get("type") == "image" for b in content
                )
            else:
                has_content = bool(content)

            if not has_content:
                continue

            # Read pacing params from session metadata
            pacing_meta = backrooms.db.get_conversation_metadata(session_id) or {}
            br_iterations = pacing_meta.get("iterations", 1)
            br_step_mode = pacing_meta.get("step_mode", False)
            br_thinking_budget = pacing_meta.get("thinking_budget", None)
            br_next_speaker = pacing_meta.pop("next_speaker", None)
            # Clear next_speaker after reading (one-shot)
            if br_next_speaker:
                backrooms.db.update_conversation_metadata(session_id, pacing_meta)

            # Run stream in background task so it completes even if WS drops
            queue: asyncio.Queue = asyncio.Queue()
            gen = backrooms.stream_turns(
                session_id, content, input_type,
                pre_formatted=pre_formatted,
                iterations=br_iterations,
                step_mode=br_step_mode,
                next_speaker=br_next_speaker,
                thinking_budget=br_thinking_budget,
            )
            task = asyncio.create_task(
                _run_stream_to_completion(
                    gen, queue, _active_backrooms_tasks, session_id,
                )
            )
            _active_backrooms_tasks[session_id] = task

            while True:
                event_data = await queue.get()
                if event_data is None:
                    break
                await ws.send_text(json.dumps(event_data))

    except WebSocketDisconnect:
        pass  # background task keeps running, messages will be saved
    except Exception as exc:
        try:
            await ws.send_text(json.dumps({
                "type": StreamEventType.ERROR.value,
                "error": str(exc),
            }))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Context endpoints (injected files per conversation)
# ---------------------------------------------------------------------------

def _build_context_response(conversation_id: str) -> dict:
    """Build unified context response with both files and pins."""
    files = []
    total_tokens = 0
    if file_db_instance:
        active_file_ids = file_db_instance.get_active_file_ids(conversation_id)
        for fid in active_file_ids:
            f = file_db_instance.get_file(fid)
            if f:
                files.append({
                    "id": f["id"],
                    "filename": f["filename"],
                    "tags": f["tags"],
                    "token_count": f["token_count"],
                })
                total_tokens += f["token_count"]
    pins = []
    if pin_db_instance:
        active_pin_ids = pin_db_instance.get_active_pin_ids(conversation_id)
        for pid in active_pin_ids:
            p = pin_db_instance.get(pid)
            if p:
                # Estimate token count for pins (~4 chars per token)
                pin_tokens = len(p["content"]) // 4
                pins.append({
                    "id": p["id"],
                    "type": p["type"],
                    "content": p["content"][:100],  # truncated preview for context bar
                    "tags": p["tags"],
                    "token_count": pin_tokens,
                })
                total_tokens += pin_tokens
    return {"files": files, "pins": pins, "total_tokens": total_tokens}


@app.get("/api/conversations/{conversation_id}/context")
async def get_conversation_context(conversation_id: str):
    return _build_context_response(conversation_id)


@app.delete("/api/conversations/{conversation_id}/context/{file_id}")
async def remove_context_file(conversation_id: str, file_id: str):
    updated = file_db_instance.remove_active_file_ids(conversation_id, [file_id])
    return {"active_file_ids": updated}


@app.delete("/api/conversations/{conversation_id}/context/pin/{pin_id}")
async def remove_context_pin(conversation_id: str, pin_id: str):
    updated = pin_db_instance.remove_active_pin_ids(conversation_id, [pin_id])
    return {"active_pin_ids": updated}


@app.delete("/api/conversations/{conversation_id}/context/tag/{tag}")
async def remove_context_tag(conversation_id: str, tag: str):
    # Remove matching files
    if file_db_instance:
        matching_files = file_db_instance.get_files_by_tags([tag])
        file_ids_to_remove = [f["id"] for f in matching_files]
        file_db_instance.remove_active_file_ids(conversation_id, file_ids_to_remove)
    # Remove matching pins
    if pin_db_instance:
        matching_pins = pin_db_instance.get_pins_by_tags([tag])
        pin_ids_to_remove = [p["id"] for p in matching_pins]
        pin_db_instance.remove_active_pin_ids(conversation_id, pin_ids_to_remove)
    return {"ok": True}


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
