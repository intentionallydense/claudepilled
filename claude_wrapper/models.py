"""Data models for the Claude API wrapper."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------------------------------------------------------------------------
# Model pricing & catalog
# ---------------------------------------------------------------------------

MODEL_PRICING: dict[str, tuple[float, float]] = {
    # model_id: (input_cost_per_MTok, output_cost_per_MTok)
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    "claude-sonnet-4-20250514": (3.0, 15.0),
    "claude-opus-4-20250514": (15.0, 75.0),
    "claude-opus-4-5-20251101": (15.0, 75.0),
    "claude-3-opus-20240229": (15.0, 75.0),
}

AVAILABLE_MODELS = [
    {"id": "claude-opus-4-6", "name": "Claude 4.6 Opus", "input_cost": 5.0, "output_cost": 25.0},
    {"id": "claude-sonnet-4-6", "name": "Claude 4.6 Sonnet", "input_cost": 3.0, "output_cost": 15.0},
    {"id": "claude-opus-4-5-20251101", "name": "Claude 4.5 Opus", "input_cost": 15.0, "output_cost": 75.0},
    {"id": "claude-haiku-4-5-20251001", "name": "Claude 4.5 Haiku", "input_cost": 1.0, "output_cost": 5.0},
    {"id": "claude-sonnet-4-20250514", "name": "Claude 4 Sonnet", "input_cost": 3.0, "output_cost": 15.0},
    {"id": "claude-opus-4-20250514", "name": "Claude 4 Opus", "input_cost": 15.0, "output_cost": 75.0},
    {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "input_cost": 15.0, "output_cost": 75.0},
]


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

class ToolDefinition(BaseModel):
    """A tool that Claude can call."""

    name: str
    description: str
    input_schema: dict[str, Any]
    callable: Callable[..., Any] | None = Field(default=None, exclude=True)

    def to_api_format(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

class ContentBlock(BaseModel):
    """A single block within a message (text, tool_use, tool_result, thinking, or image)."""

    type: str  # "text", "tool_use", "tool_result", "thinking", "image"
    text: str | None = None
    # tool_use fields
    id: str | None = None
    name: str | None = None
    input: dict[str, Any] | None = None
    # tool_result fields
    tool_use_id: str | None = None
    content: str | None = None
    # thinking fields
    thinking: str | None = None
    signature: str | None = None
    # image fields — {"type": "base64", "media_type": "image/png", "data": "..."}
    source: dict[str, Any] | None = None


class Message(BaseModel):
    """A single message in a conversation."""

    id: str = Field(default_factory=_new_id)
    role: str  # "user", "assistant"
    content: str | list[ContentBlock]
    parent_id: str | None = None
    speaker: str | None = None  # "model_a", "model_b", "curator", or None
    created_at: datetime = Field(default_factory=_utcnow)

    def text(self) -> str:
        """Extract plain text from the message content."""
        if isinstance(self.content, str):
            return self.content
        return "".join(
            block.text for block in self.content
            if block.type == "text" and block.text
        )

    def tool_use_blocks(self) -> list[ContentBlock]:
        if isinstance(self.content, str):
            return []
        return [b for b in self.content if b.type == "tool_use"]

    def to_api_format(self) -> dict[str, Any]:
        if isinstance(self.content, str):
            return {"role": self.role, "content": self.content}
        return {
            "role": self.role,
            "content": [block.model_dump(exclude_none=True) for block in self.content],
        }


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

class Conversation(BaseModel):
    """A multi-turn conversation with Claude."""

    id: str = Field(default_factory=_new_id)
    title: str = "New conversation"
    system_prompt: str = ""
    model: str = "claude-sonnet-4-6"
    messages: list[Message] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    prompt_id: str | None = None  # references a saved prompt from the prompts library
    current_leaf_id: str | None = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost: float = 0.0
    total_cache_creation_tokens: int = 0
    total_cache_read_tokens: int = 0


# ---------------------------------------------------------------------------
# Streaming events
# ---------------------------------------------------------------------------

class StreamEventType(str, Enum):
    TEXT_DELTA = "text_delta"
    THINKING_DELTA = "thinking_delta"
    THINKING_DONE = "thinking_done"
    TOOL_USE_START = "tool_use_start"
    TOOL_USE_DELTA = "tool_use_delta"
    TOOL_RESULT = "tool_result"
    WEB_SEARCH_START = "web_search_start"
    WEB_SEARCH_RESULT = "web_search_result"
    USAGE = "usage"
    TITLE_UPDATE = "title_update"
    MESSAGE_DONE = "message_done"
    ERROR = "error"
    COUCH_TURN_START = "couch_turn_start"
    COUCH_TURN_END = "couch_turn_end"
    COUCH_PAUSED = "couch_paused"
    COUCH_STATUS = "couch_status"
    CONTEXT_UPDATE = "context_update"


class StreamEvent(BaseModel):
    """An event emitted during a streaming response."""

    type: StreamEventType
    # For text_delta
    text: str | None = None
    # For thinking_delta / thinking_done
    thinking: str | None = None
    signature: str | None = None
    # For tool_use_start / tool_use_delta
    tool_use_id: str | None = None
    tool_name: str | None = None
    tool_input: dict[str, Any] | str | None = None
    # For tool_result
    tool_result: str | None = None
    # For usage
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    # For error
    error: str | None = None
    # For couch events
    model_label: str | None = None  # "Opus 4.6" or "3 Opus"
    model_id: str | None = None

    def to_ws_json(self) -> dict[str, Any]:
        """Serialize for WebSocket transmission."""
        return self.model_dump(exclude_none=True)
