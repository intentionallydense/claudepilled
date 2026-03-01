"""OpenAI-compatible API client — handles GPT, Gemini, DeepSeek, Qwen, and Kimi.

All five providers expose OpenAI-compatible APIs, so one `openai` SDK client
handles them all by varying base_url and api_key. This module translates
OpenAI streaming events into the same StreamEvent types that ClaudeClient emits,
so conversation.py and couch.py can route between providers transparently.

Used by: client.py (get_client_for_model factory), conversation.py, couch.py
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncGenerator
from typing import Any

from openai import AsyncOpenAI, RateLimitError, APIStatusError, InternalServerError

from claude_wrapper.models import (
    ContentBlock,
    Message,
    StreamEvent,
    StreamEventType,
)


class OpenAICompatibleClient:
    """Client for any OpenAI-compatible API (OpenAI, Gemini, DeepSeek, Qwen, Kimi).

    Mirrors ClaudeClient's stream()/send() interface so callers don't need to
    know which provider they're talking to. Translates OpenAI ChatCompletionChunk
    events into StreamEvent types.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        default_model: str = "gpt-4o",
        max_tokens: int = 8192,
    ):
        self.default_model = default_model
        self.max_tokens = max_tokens
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    # ------------------------------------------------------------------
    # Async streaming — same signature as ClaudeClient.stream()
    # ------------------------------------------------------------------

    async def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[Any] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        system: str | None = None,
        thinking_budget: int | None = None,
        web_search: bool = False,
        max_retries: int = 3,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a response, yielding StreamEvents. Retries on overloaded/5xx."""
        api_messages = self._build_messages(messages, system)
        kwargs = self._build_kwargs(api_messages, model, max_tokens)

        last_exc = None
        for attempt in range(max_retries):
            try:
                async for event in self._stream_once(kwargs):
                    yield event
                return
            except (RateLimitError, InternalServerError, APIStatusError) as exc:
                is_retriable = (
                    isinstance(exc, (RateLimitError, InternalServerError))
                    or getattr(exc, "status_code", 0) >= 500
                )
                if not is_retriable or attempt == max_retries - 1:
                    raise
                last_exc = exc
                wait = 2 ** attempt
                yield StreamEvent(
                    type=StreamEventType.ERROR,
                    error=f"API overloaded, retrying in {wait}s... (attempt {attempt + 1}/{max_retries})",
                )
                await asyncio.sleep(wait)

    async def _stream_once(
        self, kwargs: dict[str, Any]
    ) -> AsyncGenerator[StreamEvent, None]:
        """Single streaming attempt — translates OpenAI chunks to StreamEvents."""
        stream = await self._client.chat.completions.create(**kwargs, stream=True)

        # Track state across chunks
        has_emitted_input_usage = False
        reasoning_parts: list[str] = []
        in_reasoning = False

        async for chunk in stream:
            # Some providers send usage in the final chunk
            if chunk.usage:
                yield StreamEvent(
                    type=StreamEventType.USAGE,
                    input_tokens=chunk.usage.prompt_tokens or 0,
                    output_tokens=chunk.usage.completion_tokens or 0,
                )
                has_emitted_input_usage = True

            if not chunk.choices:
                continue

            choice = chunk.choices[0]
            delta = choice.delta

            if delta is None:
                continue

            # DeepSeek R1 reasoning_content → THINKING_DELTA
            reasoning = getattr(delta, "reasoning_content", None)
            if reasoning:
                if not in_reasoning:
                    in_reasoning = True
                reasoning_parts.append(reasoning)
                yield StreamEvent(
                    type=StreamEventType.THINKING_DELTA,
                    thinking=reasoning,
                )

            # Regular content → TEXT_DELTA
            if delta.content:
                # If we were in reasoning mode, emit THINKING_DONE first
                if in_reasoning:
                    in_reasoning = False
                    yield StreamEvent(
                        type=StreamEventType.THINKING_DONE,
                        thinking="".join(reasoning_parts),
                    )
                    reasoning_parts = []

                yield StreamEvent(
                    type=StreamEventType.TEXT_DELTA,
                    text=delta.content,
                )

            # Check for finish
            if choice.finish_reason is not None:
                # If we ended while still in reasoning, close it
                if in_reasoning:
                    yield StreamEvent(
                        type=StreamEventType.THINKING_DONE,
                        thinking="".join(reasoning_parts),
                    )
                    reasoning_parts = []
                    in_reasoning = False

        # If no usage was emitted (some providers don't include it in stream),
        # emit a zero-usage event so the caller has something to work with
        if not has_emitted_input_usage:
            yield StreamEvent(
                type=StreamEventType.USAGE,
                input_tokens=0,
                output_tokens=0,
            )

        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Synchronous-style send (uses async under the hood)
    # ------------------------------------------------------------------

    async def send(
        self,
        messages: list[dict[str, Any]],
        tools: list[Any] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        system: str | None = None,
        thinking_budget: int | None = None,
        web_search: bool = False,
    ) -> Message:
        """Non-streaming send — returns a complete Message."""
        api_messages = self._build_messages(messages, system)
        kwargs = self._build_kwargs(api_messages, model, max_tokens)

        response = await self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]

        blocks: list[ContentBlock] = []

        # Check for reasoning content (DeepSeek R1)
        reasoning = getattr(choice.message, "reasoning_content", None)
        if reasoning:
            blocks.append(ContentBlock(type="thinking", thinking=reasoning))

        if choice.message.content:
            blocks.append(ContentBlock(type="text", text=choice.message.content))

        return Message(role="assistant", content=blocks if blocks else "")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_messages(
        self,
        messages: list[dict[str, Any]],
        system: str | None,
    ) -> list[dict[str, Any]]:
        """Prepend system message and normalize message format.

        OpenAI-compatible APIs use {"role": "system"} messages instead of
        Anthropic's separate system parameter. No cache_control needed.
        """
        api_messages = []
        if system:
            api_messages.append({"role": "system", "content": system})

        for msg in messages:
            role = msg["role"]
            content = msg["content"]

            # Convert Anthropic-style content blocks to OpenAI format
            if isinstance(content, list):
                converted = self._convert_content_blocks(content)
                api_messages.append({"role": role, "content": converted})
            else:
                api_messages.append({"role": role, "content": content})

        return api_messages

    @staticmethod
    def _convert_content_blocks(blocks: list[dict]) -> str | list[dict]:
        """Convert Anthropic-style content blocks to OpenAI-compatible format.

        Text-only messages become plain strings. Messages with images become
        OpenAI-style content arrays with text and image_url parts.

        Handles mid-conversation model switches gracefully: thinking blocks are
        dropped, tool_use becomes a note, tool_result content is preserved as text.
        """
        has_images = any(b.get("type") == "image" for b in blocks)
        if not has_images:
            # Text-only — concatenate text + tool_result content
            parts = []
            for b in blocks:
                if b.get("type") == "text" and b.get("text"):
                    parts.append(b["text"])
                elif b.get("type") == "tool_use":
                    # Preserve tool call info as text so context isn't lost
                    parts.append(f"[Used tool: {b.get('name', 'unknown')}]")
                elif b.get("type") == "tool_result" and b.get("content"):
                    parts.append(b["content"])
                # Skip thinking blocks — not meaningful to other providers
            return "\n".join(parts) if parts else " "

        # Has images — build OpenAI-style content array
        parts = []
        for block in blocks:
            if block.get("type") == "text" and block.get("text"):
                parts.append({"type": "text", "text": block["text"]})
            elif block.get("type") == "image" and block.get("source"):
                source = block["source"]
                # Anthropic format: {"type": "base64", "media_type": "image/png", "data": "..."}
                # OpenAI format: {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
                data_uri = f"data:{source['media_type']};base64,{source['data']}"
                parts.append({
                    "type": "image_url",
                    "image_url": {"url": data_uri},
                })
            elif block.get("type") == "tool_result" and block.get("content"):
                parts.append({"type": "text", "text": block["content"]})
        return parts if parts else " "

    def _build_kwargs(
        self,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        """Build kwargs for the OpenAI API call."""
        kwargs: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": messages,
            "max_tokens": max_tokens or self.max_tokens,
            # Request usage in streaming responses (supported by most providers)
            "stream_options": {"include_usage": True},
        }
        return kwargs
