"""Data models for the Claude API wrapper.

Defines Pydantic models, the multi-provider model catalog, and streaming
event types. The PROVIDERS dict maps provider names to their SDK config;
AVAILABLE_MODELS contains all models with pricing, provider, and the API
model ID (which may differ from the internal model_id).

Used by: every module in the package.
"""

from __future__ import annotations

import os
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
# Provider definitions
# ---------------------------------------------------------------------------
# Each provider maps to: sdk type ("anthropic" or "openai"), env var for
# the API key, and optional base_url override.

PROVIDERS: dict[str, dict[str, str | None]] = {
    "anthropic": {
        "sdk": "anthropic",
        "env_key": "ANTHROPIC_API_KEY",
        "base_url": None,
    },
    "openai": {
        "sdk": "openai",
        "env_key": "OPENAI_API_KEY",
        "base_url": None,  # uses OpenAI default
    },
    "deepseek": {
        "sdk": "openai",
        "env_key": "DEEPSEEK_API_KEY",
        "base_url": "https://api.deepseek.com",
    },
    "qwen": {
        "sdk": "openai",
        "env_key": "QWEN_API_KEY",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    "kimi": {
        "sdk": "openai",
        "env_key": "KIMI_API_KEY",
        "base_url": "https://api.moonshot.cn/v1",
    },
    "gemini": {
        "sdk": "openai",
        "env_key": "GEMINI_API_KEY",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    },
    "openrouter": {
        "sdk": "openai",
        "env_key": "OPENROUTER_API_KEY",
        "base_url": "https://openrouter.ai/api/v1",
    },
}


# ---------------------------------------------------------------------------
# Model catalog — unified list with provider info
# ---------------------------------------------------------------------------
# Each entry: id (internal), name (display), provider, api_model_id (what the
# API actually accepts), input/output cost per million tokens.

AVAILABLE_MODELS = [
    # -- Anthropic --
    {"id": "claude-opus-4-6", "name": "Claude 4.6 Opus", "provider": "anthropic", "api_model_id": "claude-opus-4-6", "input_cost": 5.0, "output_cost": 25.0},
    {"id": "claude-sonnet-4-6", "name": "Claude 4.6 Sonnet", "provider": "anthropic", "api_model_id": "claude-sonnet-4-6", "input_cost": 3.0, "output_cost": 15.0},
    {"id": "claude-opus-4-5-20251101", "name": "Claude 4.5 Opus", "provider": "anthropic", "api_model_id": "claude-opus-4-5-20251101", "input_cost": 15.0, "output_cost": 75.0},
    {"id": "claude-haiku-4-5-20251001", "name": "Claude 4.5 Haiku", "provider": "anthropic", "api_model_id": "claude-haiku-4-5-20251001", "input_cost": 1.0, "output_cost": 5.0},
    {"id": "claude-sonnet-4-20250514", "name": "Claude 4 Sonnet", "provider": "anthropic", "api_model_id": "claude-sonnet-4-20250514", "input_cost": 3.0, "output_cost": 15.0},
    {"id": "claude-opus-4-20250514", "name": "Claude 4 Opus", "provider": "anthropic", "api_model_id": "claude-opus-4-20250514", "input_cost": 15.0, "output_cost": 75.0},
    {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "provider": "anthropic", "api_model_id": "claude-3-opus-20240229", "input_cost": 15.0, "output_cost": 75.0},
    # -- Direct providers (no middleman, needs per-provider API key) --
    # OpenAI direct
    {"id": "openai/gpt-4o", "name": "GPT-4o", "provider": "openai", "api_model_id": "gpt-4o", "input_cost": 2.5, "output_cost": 10.0},
    {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini", "provider": "openai", "api_model_id": "gpt-4o-mini", "input_cost": 0.15, "output_cost": 0.6},
    # DeepSeek direct
    {"id": "deepseek/deepseek-chat", "name": "DeepSeek V3", "provider": "deepseek", "api_model_id": "deepseek-chat", "input_cost": 0.27, "output_cost": 1.1},
    {"id": "deepseek/deepseek-reasoner", "name": "DeepSeek R1", "provider": "deepseek", "api_model_id": "deepseek-reasoner", "input_cost": 0.55, "output_cost": 2.19},
    # Qwen direct
    {"id": "qwen/qwen-max", "name": "Qwen Max", "provider": "qwen", "api_model_id": "qwen-max", "input_cost": 1.6, "output_cost": 6.4},
    {"id": "qwen/qwen-plus", "name": "Qwen Plus", "provider": "qwen", "api_model_id": "qwen-plus", "input_cost": 0.4, "output_cost": 1.2},
    # Kimi direct
    {"id": "kimi/moonshot-v1-auto", "name": "Kimi (auto)", "provider": "kimi", "api_model_id": "moonshot-v1-auto", "input_cost": 1.0, "output_cost": 3.0},
    # Gemini direct
    {"id": "gemini/gemini-2.0-flash", "name": "Gemini 2.0 Flash", "provider": "gemini", "api_model_id": "gemini-2.0-flash", "input_cost": 0.1, "output_cost": 0.4},
    # -- OpenRouter — closed-source models via single API key --
    # OpenAI
    {"id": "openrouter/openai/gpt-5.2", "name": "GPT-5.2", "provider": "openrouter", "api_model_id": "openai/gpt-5.2", "input_cost": 1.75, "output_cost": 14.0},
    {"id": "openrouter/openai/gpt-5.2-pro", "name": "GPT-5.2 Pro", "provider": "openrouter", "api_model_id": "openai/gpt-5.2-pro", "input_cost": 21.0, "output_cost": 168.0},
    {"id": "openrouter/openai/gpt-5-mini", "name": "GPT-5 Mini", "provider": "openrouter", "api_model_id": "openai/gpt-5-mini", "input_cost": 0.25, "output_cost": 2.0},
    # Google Gemini
    {"id": "openrouter/google/gemini-3-pro", "name": "Gemini 3 Pro", "provider": "openrouter", "api_model_id": "google/gemini-3-pro-preview", "input_cost": 2.0, "output_cost": 12.0},
    {"id": "openrouter/google/gemini-3-flash", "name": "Gemini 3 Flash", "provider": "openrouter", "api_model_id": "google/gemini-3-flash-preview", "input_cost": 0.5, "output_cost": 3.0},
    # DeepSeek
    {"id": "openrouter/deepseek/v3.2", "name": "DeepSeek V3.2", "provider": "openrouter", "api_model_id": "deepseek/deepseek-v3.2", "input_cost": 0.25, "output_cost": 0.4},
    {"id": "openrouter/deepseek/v3.2-speciale", "name": "DeepSeek V3.2 Speciale", "provider": "openrouter", "api_model_id": "deepseek/deepseek-v3.2-speciale", "input_cost": 0.4, "output_cost": 1.2},
    # Qwen
    {"id": "openrouter/qwen/qwen3.5-plus", "name": "Qwen 3.5 Plus", "provider": "openrouter", "api_model_id": "qwen/qwen3.5-plus-02-15", "input_cost": 0.4, "output_cost": 2.4},
    # GLM (Zhipu)
    {"id": "openrouter/z-ai/glm-5", "name": "GLM-5", "provider": "openrouter", "api_model_id": "z-ai/glm-5", "input_cost": 0.95, "output_cost": 2.55},
    # MiniMax
    {"id": "openrouter/minimax/m2.5", "name": "MiniMax M2.5", "provider": "openrouter", "api_model_id": "minimax/minimax-m2.5", "input_cost": 0.29, "output_cost": 1.2},
    # Kimi (Moonshot)
    {"id": "openrouter/moonshotai/kimi-k2-thinking", "name": "Kimi K2 (thinking)", "provider": "openrouter", "api_model_id": "moonshotai/kimi-k2-thinking", "input_cost": 0.47, "output_cost": 2.0},
    {"id": "openrouter/moonshotai/kimi-k2-0905", "name": "Kimi K2 0905", "provider": "openrouter", "api_model_id": "moonshotai/kimi-k2-0905", "input_cost": 0.4, "output_cost": 2.0},
    {"id": "openrouter/moonshotai/kimi-k2.5", "name": "Kimi K2.5", "provider": "openrouter", "api_model_id": "moonshotai/kimi-k2.5", "input_cost": 0.45, "output_cost": 2.2},
]

# Auto-generate pricing dict from the catalog
MODEL_PRICING: dict[str, tuple[float, float]] = {
    m["id"]: (m["input_cost"], m["output_cost"]) for m in AVAILABLE_MODELS
}


# ---------------------------------------------------------------------------
# Provider/model helpers
# ---------------------------------------------------------------------------

def get_provider_for_model(model_id: str) -> str:
    """Return the provider name for a model ID. Defaults to 'anthropic'."""
    for m in AVAILABLE_MODELS:
        if m["id"] == model_id:
            return m["provider"]
    return "anthropic"


def get_api_model_id(model_id: str) -> str:
    """Return the API-facing model ID (strips provider prefix if needed)."""
    for m in AVAILABLE_MODELS:
        if m["id"] == model_id:
            return m["api_model_id"]
    # Unknown model — pass through as-is (might be a raw API ID)
    return model_id


def get_available_providers() -> dict[str, bool]:
    """Return which providers have API keys configured."""
    result = {}
    for name, config in PROVIDERS.items():
        env_key = config["env_key"]
        result[name] = bool(os.environ.get(env_key, ""))
    return result


def get_available_models() -> list[dict]:
    """Return only models whose provider has an API key configured."""
    available = get_available_providers()
    return [m for m in AVAILABLE_MODELS if available.get(m["provider"], False)]


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
