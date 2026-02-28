"""Core Claude API client wrapper."""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import AsyncGenerator
from typing import Any

import anthropic

from claude_wrapper.models import (
    ContentBlock,
    Message,
    StreamEvent,
    StreamEventType,
    ToolDefinition,
)

DEFAULT_MODEL = "claude-opus-4-6"
DEFAULT_MAX_TOKENS = 8192


class ClaudeClient:
    """Wrapper around the Anthropic Python SDK."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        system_prompt: str = "",
    ):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        self._client = anthropic.Anthropic(api_key=self.api_key)
        self._async_client = anthropic.AsyncAnthropic(api_key=self.api_key)

    # ------------------------------------------------------------------
    # Synchronous send
    # ------------------------------------------------------------------

    def send(
        self,
        messages: list[dict[str, Any]],
        tools: list[ToolDefinition] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        system: str | None = None,
        thinking_budget: int | None = None,
        web_search: bool = True,
    ) -> Message:
        """Send messages and return the assistant response as a Message."""
        kwargs = self._build_kwargs(messages, tools, model, max_tokens, system, thinking_budget, web_search=web_search)
        response = self._call_with_retry(lambda: self._client.messages.create(**kwargs))
        return self._response_to_message(response)

    # ------------------------------------------------------------------
    # Async streaming
    # ------------------------------------------------------------------

    async def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[ToolDefinition] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        system: str | None = None,
        thinking_budget: int | None = None,
        web_search: bool = True,
        max_retries: int = 3,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a response, yielding StreamEvents. Retries on overloaded/5xx."""
        kwargs = self._build_kwargs(messages, tools, model, max_tokens, system, thinking_budget, web_search=web_search)

        last_exc = None
        for attempt in range(max_retries):
            try:
                async for event in self._stream_once(kwargs):
                    yield event
                return  # success
            except (
                anthropic.RateLimitError,
                anthropic.InternalServerError,
                anthropic.APIStatusError,
            ) as exc:
                is_retriable = (
                    isinstance(exc, (anthropic.RateLimitError, anthropic.InternalServerError))
                    or getattr(exc, "status_code", 0) == 529
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
        """Single streaming attempt — separated so the retry loop can restart it."""
        async with self._async_client.messages.stream(**kwargs) as stream:
            current_tool_id: str | None = None
            current_tool_name: str | None = None
            input_json_parts: list[str] = []
            current_block_type: str | None = None
            thinking_parts: list[str] = []
            signature_parts: list[str] = []

            async for event in stream:
                if event.type == "message_start":
                    # Emit usage with input token count + cache breakdown
                    if hasattr(event, "message") and hasattr(event.message, "usage"):
                        usage = event.message.usage
                        yield StreamEvent(
                            type=StreamEventType.USAGE,
                            input_tokens=usage.input_tokens,
                            output_tokens=0,
                            cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
                            cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                        )

                elif event.type == "content_block_start":
                    block = event.content_block
                    if block.type == "text":
                        current_block_type = "text"
                    elif block.type == "thinking":
                        current_block_type = "thinking"
                        thinking_parts = []
                        signature_parts = []
                    elif block.type == "tool_use":
                        current_block_type = "tool_use"
                        current_tool_id = block.id
                        current_tool_name = block.name
                        input_json_parts = []
                        yield StreamEvent(
                            type=StreamEventType.TOOL_USE_START,
                            tool_use_id=block.id,
                            tool_name=block.name,
                        )
                    elif block.type == "server_tool_use":
                        current_block_type = "server_tool_use"
                        yield StreamEvent(
                            type=StreamEventType.WEB_SEARCH_START,
                            tool_name=getattr(block, "name", "web_search"),
                        )
                    elif block.type == "web_search_tool_result":
                        current_block_type = "web_search_tool_result"

                elif event.type == "content_block_delta":
                    delta = event.delta
                    if current_block_type in ("server_tool_use", "web_search_tool_result"):
                        pass  # Server-side tool — handled by the API
                    elif delta.type == "text_delta":
                        yield StreamEvent(
                            type=StreamEventType.TEXT_DELTA,
                            text=delta.text,
                        )
                    elif delta.type == "thinking_delta":
                        thinking_parts.append(delta.thinking)
                        yield StreamEvent(
                            type=StreamEventType.THINKING_DELTA,
                            thinking=delta.thinking,
                        )
                    elif delta.type == "signature_delta":
                        signature_parts.append(delta.signature)
                    elif delta.type == "input_json_delta":
                        input_json_parts.append(delta.partial_json)
                        yield StreamEvent(
                            type=StreamEventType.TOOL_USE_DELTA,
                            tool_use_id=current_tool_id,
                            tool_name=current_tool_name,
                            tool_input=delta.partial_json,
                        )

                elif event.type == "content_block_stop":
                    if current_block_type == "server_tool_use":
                        pass  # Server-side tool handled by API
                    elif current_block_type == "web_search_tool_result":
                        yield StreamEvent(type=StreamEventType.WEB_SEARCH_RESULT)
                    elif current_block_type == "thinking":
                        yield StreamEvent(
                            type=StreamEventType.THINKING_DONE,
                            thinking="".join(thinking_parts),
                            signature="".join(signature_parts) if signature_parts else None,
                        )
                        thinking_parts = []
                        signature_parts = []
                    elif current_block_type == "tool_use" and current_tool_id and input_json_parts:
                        try:
                            full_input = json.loads("".join(input_json_parts))
                        except json.JSONDecodeError:
                            full_input = {}
                        yield StreamEvent(
                            type=StreamEventType.TOOL_USE_DELTA,
                            tool_use_id=current_tool_id,
                            tool_name=current_tool_name,
                            tool_input=full_input,
                        )
                    current_block_type = None
                    current_tool_id = None
                    current_tool_name = None
                    input_json_parts = []

                elif event.type == "message_delta":
                    # Emit usage with output token count
                    if hasattr(event, "usage") and event.usage:
                        yield StreamEvent(
                            type=StreamEventType.USAGE,
                            input_tokens=0,
                            output_tokens=event.usage.output_tokens,
                        )

                elif event.type == "message_stop":
                    yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_kwargs(
        self,
        messages: list[dict[str, Any]],
        tools: list[ToolDefinition] | None,
        model: str | None,
        max_tokens: int | None,
        system: str | None,
        thinking_budget: int | None = None,
        web_search: bool = True,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model or self.model,
            "max_tokens": max_tokens or self.max_tokens,
            "messages": messages,
        }
        sys = system if system is not None else self.system_prompt
        if sys:
            # Use structured block with cache_control so the system prompt
            # gets cached across turns (90% discount on subsequent reads).
            kwargs["system"] = [
                {"type": "text", "text": sys, "cache_control": {"type": "ephemeral"}}
            ]
        tool_list = [t.to_api_format() for t in tools] if tools else []
        if web_search:
            tool_list.append({"type": "web_search_20250305", "name": "web_search"})
        if tool_list:
            kwargs["tools"] = tool_list
        if thinking_budget and thinking_budget >= 1024:
            # Ensure max_tokens is larger than the thinking budget
            if kwargs["max_tokens"] <= thinking_budget:
                kwargs["max_tokens"] = thinking_budget + 4096
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }
        return kwargs

    def _call_with_retry(self, fn, max_retries: int = 3):
        """Retry on transient errors (rate limits, overloaded, 500s)."""
        for attempt in range(max_retries):
            try:
                return fn()
            except (
                anthropic.RateLimitError,
                anthropic.InternalServerError,
                anthropic.APIStatusError,
            ) as exc:
                # Retry overloaded (529) and 5xx errors
                is_overloaded = getattr(exc, "status_code", 0) == 529
                is_server_err = isinstance(exc, anthropic.InternalServerError)
                is_rate_limit = isinstance(exc, anthropic.RateLimitError)
                if not (is_overloaded or is_server_err or is_rate_limit):
                    raise
                if attempt == max_retries - 1:
                    raise
                wait = 2 ** attempt
                time.sleep(wait)
            except anthropic.APIError:
                raise

    @staticmethod
    def _response_to_message(response) -> Message:
        """Convert an Anthropic API response to our Message model."""
        blocks: list[ContentBlock] = []
        for block in response.content:
            if block.type == "text":
                blocks.append(ContentBlock(type="text", text=block.text))
            elif block.type == "thinking":
                blocks.append(ContentBlock(
                    type="thinking",
                    thinking=block.thinking,
                    signature=block.signature,
                ))
            elif block.type == "tool_use":
                blocks.append(ContentBlock(
                    type="tool_use",
                    id=block.id,
                    name=block.name,
                    input=block.input,
                ))
            # Skip server_tool_use / web_search_tool_result (handled by API)
        return Message(role="assistant", content=blocks)
