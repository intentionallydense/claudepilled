"""Conversation manager — orchestrates chat turns, tool execution, and persistence.

Routes between Anthropic and OpenAI-compatible providers based on the
conversation's model. Tool use is only supported for Anthropic models;
non-Anthropic models get tools=None. Title and summary generation use
GLM5 via OpenRouter (cheap, fast).

Used by: server.py (creates the singleton ConversationManager at startup)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from dataclasses import dataclass, field

from llm_interface.client import ClaudeClient, get_client_for_model
from llm_interface.db import Database
from llm_interface.models import (
    AVAILABLE_MODELS,
    MODEL_PRICING,
    PROVIDERS,
    ContentBlock,
    Conversation,
    Message,
    StreamEvent,
    StreamEventType,
    get_provider_for_model,
    get_api_model_id,
    get_model_name,
)
from llm_interface.tools import ToolRegistry

log = logging.getLogger(__name__)


@dataclass
class _TurnState:
    """Mutable accumulator filled during streaming. Passed to _finalize_turn.

    Collects text, thinking, tool use, and token counts from a single
    streaming API call. The caller reads these after iteration completes.
    """
    text_parts: list[str] = field(default_factory=list)
    thinking_parts: list[str] = field(default_factory=list)
    thinking_signature: str | None = None
    pending_tools: dict[str, dict[str, Any]] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0

# Model used for cheap system tasks (title generation, compaction summaries).
# GLM5 via OpenRouter — fast and cheap. Falls back to Anthropic Haiku if
# no OpenRouter API key is configured.
_SYSTEM_MODEL = "z-ai/glm-5"


class ConversationManager:
    """High-level manager that ties together client, tools, and persistence."""

    def __init__(
        self,
        client: ClaudeClient,
        tool_registry: ToolRegistry | None = None,
        db: Database | None = None,
        context_sources: list | None = None,
        # Deprecated — use context_sources instead
        file_db=None,
        pin_db=None,
    ):
        self.client = client
        self.tools = tool_registry or ToolRegistry()
        self.db = db or Database()
        self.context_sources = context_sources or []
        self._openrouter_client = None  # lazy-init AsyncOpenAI for system tasks

    def _get_client_and_tools(self, model: str):
        """Return (client, tool_defs, is_anthropic) for the given model.

        Anthropic providers get Anthropic-format tool definitions. OpenAI-
        compatible providers get OpenAI function-calling format. Web search
        is Anthropic-only (tool-based, model decides when to search).
        OpenRouter :online was disabled — it forces a search on every request.
        Prompt caching is Anthropic-only.
        """
        provider = get_provider_for_model(model)
        is_anthropic = provider == "anthropic"
        has_web_search = is_anthropic
        client = get_client_for_model(model, self.client)
        raw_tools = self.tools.get_definitions() or None
        if raw_tools and not is_anthropic:
            tool_defs = [t.to_openai_format() for t in raw_tools]
        else:
            tool_defs = raw_tools
        return client, tool_defs, is_anthropic, has_web_search

    async def _get_openrouter_client(self):
        """Lazily create an AsyncOpenAI client for OpenRouter system tasks.

        Used for title generation and compaction summaries — cheap calls
        that don't need the full provider routing. Falls back to None if
        no OpenRouter API key is set.
        """
        if self._openrouter_client is not None:
            return self._openrouter_client
        api_key = os.environ.get(PROVIDERS["openrouter"]["env_key"], "")
        if not api_key:
            return None
        from openai import AsyncOpenAI
        self._openrouter_client = AsyncOpenAI(
            api_key=api_key,
            base_url=PROVIDERS["openrouter"]["base_url"],
        )
        return self._openrouter_client

    # ------------------------------------------------------------------
    # Conversation CRUD
    # ------------------------------------------------------------------

    def create_conversation(
        self,
        system_prompt: str = "",
        model: str | None = None,
        title: str = "New conversation",
        prompt_id: str | None = None,
    ) -> Conversation:
        conv = Conversation(
            title=title,
            system_prompt=system_prompt or self.client.system_prompt,
            model=model or self.client.model,
            prompt_id=prompt_id,
        )
        self.db.save_conversation(conv)
        return conv

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        return self.db.load_conversation(conversation_id)

    def list_conversations(self) -> list[dict]:
        return self.db.list_conversations()

    def delete_conversation(self, conversation_id: str) -> None:
        self.db.delete_conversation(conversation_id)

    def update_model(self, conversation_id: str, model: str) -> None:
        self.db.update_conversation_model(conversation_id, model)

    # ------------------------------------------------------------------
    # Synchronous chat
    # ------------------------------------------------------------------

    def chat(
        self,
        conversation_id: str,
        user_text: str,
        thinking_budget: int | None = None,
    ) -> str:
        """Send a user message and return the final assistant text."""
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            raise ValueError(f"Conversation {conversation_id} not found")

        # Append user message with parent = current leaf
        user_msg = Message(role="user", content=user_text, parent_id=conv.current_leaf_id)
        conv.messages.append(user_msg)
        self.db.save_message(conversation_id, user_msg)

        client, tool_defs, is_anthropic, has_web_search = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        api_messages = self._to_api_messages(conv.messages, compactions)
        if is_anthropic:
            effective_system = self._build_cached_system_blocks(conv)
            api_messages = self._add_message_cache_breakpoints(api_messages)
        else:
            effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            assistant_msg = client.send(
                messages=api_messages,
                tools=tool_defs,
                model=get_api_model_id(conv.model),
                system=effective_system,
                thinking_budget=thinking_budget,
                web_search=has_web_search,
            )
            assistant_msg.parent_id = conv.messages[-1].id
            conv.messages.append(assistant_msg)
            self.db.save_message(conversation_id, assistant_msg)
            api_messages = self._to_api_messages(conv.messages, compactions)
            if is_anthropic:
                api_messages = self._add_message_cache_breakpoints(api_messages)

            tool_blocks = assistant_msg.tool_use_blocks()
            if not tool_blocks:
                break

            tool_results = asyncio.get_event_loop().run_until_complete(
                self._execute_tool_blocks(tool_blocks)
            )
            tool_msg = Message(role="user", content=tool_results, parent_id=assistant_msg.id)
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)
            api_messages = self._to_api_messages(conv.messages, compactions)
            if is_anthropic:
                api_messages = self._add_message_cache_breakpoints(api_messages)

        return conv.messages[-1].text()

    # ------------------------------------------------------------------
    # Streaming helpers — shared by stream_chat, edit_message, stream_init
    # ------------------------------------------------------------------

    async def _collect_stream_events(
        self,
        *,
        client,
        api_messages: list[dict],
        tool_defs,
        model_api_id: str,
        system: str | list[dict],
        thinking_budget: int | None = None,
        web_search: bool = False,
        state: _TurnState,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream from the API, yield events, and accumulate state.

        Caller iterates with `async for event in ...` inside their own
        generator so events propagate naturally. The _TurnState is mutated
        in-place — caller reads it after iteration completes.
        """
        async for event in client.stream(
            messages=api_messages,
            tools=tool_defs,
            model=model_api_id,
            system=system,
            thinking_budget=thinking_budget,
            web_search=web_search,
        ):
            if event.type == StreamEventType.MESSAGE_DONE:
                continue
            yield event

            if event.type == StreamEventType.TEXT_DELTA and event.text:
                state.text_parts.append(event.text)
            elif event.type == StreamEventType.THINKING_DELTA and event.thinking:
                state.thinking_parts.append(event.thinking)
            elif event.type == StreamEventType.THINKING_DONE:
                state.thinking_signature = event.signature
            elif event.type == StreamEventType.TOOL_USE_START:
                state.pending_tools[event.tool_use_id] = {
                    "name": event.tool_name, "input": {},
                }
            elif event.type == StreamEventType.TOOL_USE_DELTA:
                if event.tool_use_id and isinstance(event.tool_input, dict):
                    state.pending_tools[event.tool_use_id]["input"] = event.tool_input
            elif event.type == StreamEventType.USAGE:
                if event.input_tokens:
                    state.input_tokens = event.input_tokens
                if event.output_tokens:
                    state.output_tokens = event.output_tokens
                if event.cache_creation_input_tokens:
                    state.cache_creation_tokens = event.cache_creation_input_tokens
                if event.cache_read_input_tokens:
                    state.cache_read_tokens = event.cache_read_input_tokens

    def _finalize_turn(
        self,
        state: _TurnState,
        *,
        conversation_id: str,
        parent_id: str | None,
        pricing_model: str,
        conv_messages: list[Message],
    ) -> Message | None:
        """Assemble blocks from _TurnState, compute cost, save message.

        Returns the saved Message, or None if no content was collected.
        """
        collected_blocks: list[ContentBlock] = []
        if state.thinking_parts:
            collected_blocks.append(ContentBlock(
                type="thinking",
                thinking="".join(state.thinking_parts),
                signature=state.thinking_signature,
            ))
        if state.text_parts:
            collected_blocks.append(ContentBlock(type="text", text="".join(state.text_parts)))
        for tool_id, tool_info in state.pending_tools.items():
            collected_blocks.append(ContentBlock(
                type="tool_use", id=tool_id,
                name=tool_info["name"], input=tool_info["input"],
            ))

        if not collected_blocks:
            return None

        pricing = MODEL_PRICING.get(pricing_model, (3.0, 15.0))
        input_price, output_price = pricing
        cost = (
            state.input_tokens * input_price
            + state.output_tokens * output_price
            + state.cache_creation_tokens * (input_price * 1.25)
            + state.cache_read_tokens * (input_price * 0.1)
        ) / 1_000_000

        assistant_msg = Message(
            role="assistant",
            content=collected_blocks,
            parent_id=parent_id,
        )
        conv_messages.append(assistant_msg)
        self.db.save_message(
            conversation_id, assistant_msg,
            input_tokens=state.input_tokens,
            output_tokens=state.output_tokens,
            cost=cost,
            cache_creation_input_tokens=state.cache_creation_tokens,
            cache_read_input_tokens=state.cache_read_tokens,
        )
        return assistant_msg

    def _make_usage_event(self, conversation_id: str) -> StreamEvent:
        """Build a USAGE event with conversation totals."""
        conv_cost = self.db.get_conversation_cost(conversation_id)
        return StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=conv_cost["input_tokens"],
            output_tokens=conv_cost["output_tokens"],
            cache_creation_input_tokens=conv_cost["cache_creation_tokens"],
            cache_read_input_tokens=conv_cost["cache_read_tokens"],
        )

    # ------------------------------------------------------------------
    # Streaming chat
    # ------------------------------------------------------------------

    async def stream_chat(
        self,
        conversation_id: str,
        user_content: str | list[dict],
        thinking_budget: int | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a chat response, handling tool use loops."""
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation not found")
            return

        is_first_message = len(conv.messages) == 0
        msg_content = self._normalize_user_content(user_content)

        user_msg = Message(role="user", content=msg_content, parent_id=conv.current_leaf_id)
        conv.messages.append(user_msg)
        self.db.save_message(conversation_id, user_msg)

        client, tool_defs, is_anthropic, has_web_search = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        if is_anthropic:
            effective_system = self._build_cached_system_blocks(conv)
        else:
            effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages, compactions)
            if is_anthropic:
                api_messages = self._add_message_cache_breakpoints(api_messages)
            state = _TurnState()
            async for event in self._collect_stream_events(
                client=client, api_messages=api_messages, tool_defs=tool_defs,
                model_api_id=get_api_model_id(conv.model), system=effective_system,
                thinking_budget=thinking_budget, web_search=has_web_search, state=state,
            ):
                yield event

            self._finalize_turn(
                state, conversation_id=conversation_id,
                parent_id=conv.messages[-1].id, pricing_model=conv.model,
                conv_messages=conv.messages,
            )

            if not state.pending_tools:
                break

            # Execute tools and stream results
            tool_blocks = [
                b for b in conv.messages[-1].content
                if isinstance(b, ContentBlock) and b.type == "tool_use"
            ]
            tool_results = await self._execute_tool_blocks(tool_blocks)
            for result_block in tool_results:
                yield StreamEvent(
                    type=StreamEventType.TOOL_RESULT,
                    tool_use_id=result_block.tool_use_id,
                    tool_result=result_block.content,
                )
            tool_msg = Message(
                role="user", content=tool_results,
                parent_id=conv.messages[-1].id,
            )
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)

        if is_first_message:
            title_text = user_msg.text() if isinstance(msg_content, list) else str(user_content)
            title = await self._generate_title(title_text)
            self.db.update_conversation_title(conversation_id, title)
            yield StreamEvent(type=StreamEventType.TITLE_UPDATE, text=title)

        yield self._make_usage_event(conversation_id)
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Model speaks first (no user message)
    # ------------------------------------------------------------------

    async def stream_init(
        self,
        conversation_id: str,
        model: str = "claude-haiku-4-5-20251001",
    ) -> AsyncGenerator[StreamEvent, None]:
        """Generate an initial assistant message with no prior user input.

        Used for "model speaks first" flows like brain dump — sends the
        conversation's prompt as the API user message (not saved to history)
        so the model gets clear instructions instead of "Go ahead." Also
        updates the conversation model to match what's actually being called.
        """
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation not found")
            return
        if conv.messages:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation already has messages")
            return

        prompt_text = ""
        if conv.prompt_id:
            prompt = self.db.get_prompt(conv.prompt_id)
            if prompt:
                prompt_text = prompt["content"]
        if not prompt_text:
            prompt_text = conv.system_prompt or "Start the conversation."

        self.db.update_conversation_model(conversation_id, model)
        conv.model = model

        client, tool_defs, is_anthropic, has_web_search = self._get_client_and_tools(model)
        if is_anthropic:
            effective_system = self._build_cached_system_blocks(conv)
        else:
            effective_system = self._get_effective_system_prompt(conv)
        api_messages = [{"role": "user", "content": prompt_text}]

        state = _TurnState()
        async for event in self._collect_stream_events(
            client=client, api_messages=api_messages, tool_defs=tool_defs,
            model_api_id=get_api_model_id(model), system=effective_system,
            web_search=has_web_search, state=state,
        ):
            yield event

        self._finalize_turn(
            state, conversation_id=conversation_id,
            parent_id=None, pricing_model=model,
            conv_messages=conv.messages,
        )

        yield self._make_usage_event(conversation_id)
        model_name = next((m["name"] for m in AVAILABLE_MODELS if m["id"] == model), model)
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE, model_id=model, model_label=model_name)

    # ------------------------------------------------------------------
    # Edit message (create a branch)
    # ------------------------------------------------------------------

    async def edit_message(
        self,
        conversation_id: str,
        parent_id: str | None,
        new_content: str | list[dict],
        thinking_budget: int | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Create a new branch by editing a user message.

        parent_id is the message BEFORE the one being edited (the parent of
        the original message).  A new user message is created with that parent,
        and Claude's response is streamed back.
        """
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation not found")
            return

        msg_content = self._normalize_user_content(new_content)
        user_msg = Message(role="user", content=msg_content, parent_id=parent_id)
        self.db.save_message(conversation_id, user_msg)

        # Reload conversation from the new leaf
        conv = self.db.load_conversation(conversation_id)

        client, tool_defs, is_anthropic, has_web_search = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        if is_anthropic:
            effective_system = self._build_cached_system_blocks(conv)
        else:
            effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages, compactions)
            if is_anthropic:
                api_messages = self._add_message_cache_breakpoints(api_messages)
            state = _TurnState()
            async for event in self._collect_stream_events(
                client=client, api_messages=api_messages, tool_defs=tool_defs,
                model_api_id=get_api_model_id(conv.model), system=effective_system,
                thinking_budget=thinking_budget, web_search=has_web_search, state=state,
            ):
                yield event

            self._finalize_turn(
                state, conversation_id=conversation_id,
                parent_id=conv.messages[-1].id, pricing_model=conv.model,
                conv_messages=conv.messages,
            )

            if not state.pending_tools:
                break

            tool_blocks = [
                b for b in conv.messages[-1].content
                if isinstance(b, ContentBlock) and b.type == "tool_use"
            ]
            tool_results = await self._execute_tool_blocks(tool_blocks)
            for result_block in tool_results:
                yield StreamEvent(
                    type=StreamEventType.TOOL_RESULT,
                    tool_use_id=result_block.tool_use_id,
                    tool_result=result_block.content,
                )
            tool_msg = Message(
                role="user", content=tool_results,
                parent_id=conv.messages[-1].id,
            )
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)

        yield self._make_usage_event(conversation_id)
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Branch switching
    # ------------------------------------------------------------------

    def switch_branch(self, conversation_id: str, node_id: str) -> Conversation | None:
        """Switch the conversation to the branch containing node_id."""
        leaf_id = self.db.find_leaf(conversation_id, node_id)
        self.db.set_current_leaf(conversation_id, leaf_id)
        return self.db.load_conversation(conversation_id)

    # ------------------------------------------------------------------
    # Auto-title generation
    # ------------------------------------------------------------------

    async def _generate_title(self, user_text: str) -> str:
        """Generate a short title from the first user message.

        Uses GLM5 via OpenRouter (cheap/fast). Falls back to Anthropic Haiku
        if OpenRouter isn't configured.
        """
        prompt = (
            "Generate a brief title (max 6 words) for a conversation that starts with "
            "this message. Return only the title, no quotes or punctuation.\n\n"
            + user_text[:500]
        )
        try:
            or_client = await self._get_openrouter_client()
            if or_client:
                # Disable reasoning — GLM5 has it on by default, which wastes
                # tokens and can leave content=None for short system tasks.
                response = await or_client.chat.completions.create(
                    model=_SYSTEM_MODEL,
                    max_tokens=30,
                    messages=[{"role": "user", "content": prompt}],
                    extra_body={"reasoning": {"effort": "none"}},
                )
                content = response.choices[0].message.content
                if not content:
                    log.warning("GLM5 returned empty content for title")
                    raise ValueError("empty content")
                return content.strip().strip('"').strip("'")
            raise ValueError("No OpenRouter client — is OPENROUTER_API_KEY set?")
        except Exception as exc:
            log.warning("Title generation failed: %s", exc)
            return user_text[:40] + ("..." if len(user_text) > 40 else "")

    # ------------------------------------------------------------------
    # Compaction — summarize older messages to save tokens
    # ------------------------------------------------------------------

    def _get_compactions(self, conversation_id: str) -> list[dict]:
        """Load compaction records from conversation metadata."""
        meta = self.db.get_conversation_metadata(conversation_id) or {}
        return meta.get("compactions", [])

    async def _generate_summary(self, messages_text: str, prev_summary: str | None = None) -> str:
        """Generate a conversation summary using GLM5 via OpenRouter.

        Falls back to Anthropic Haiku if OpenRouter isn't configured.
        """
        prompt_parts = []
        if prev_summary:
            prompt_parts.append(
                "Previous conversation summary:\n" + prev_summary + "\n\n"
                "New messages since that summary:\n"
            )
        prompt_parts.append(messages_text)
        prompt_parts.append(
            "\n\nSummarize this conversation concisely. Capture key topics, decisions, "
            "code discussed, and context needed to continue the conversation. "
            "Be specific about names, values, and conclusions — not vague."
        )
        content = "".join(prompt_parts)

        try:
            or_client = await self._get_openrouter_client()
            if or_client:
                response = await or_client.chat.completions.create(
                    model=_SYSTEM_MODEL,
                    max_tokens=1024,
                    messages=[{"role": "user", "content": content}],
                )
                result = response.choices[0].message.content
                if not result:
                    raise ValueError("GLM5 returned empty content for summary")
                return result.strip()
            raise ValueError("No OpenRouter client — is OPENROUTER_API_KEY set?")
        except Exception as e:
            raise RuntimeError(f"Summary generation failed: {e}") from e

    async def compact_conversation(self, conversation_id: str) -> dict:
        """Compact older messages into a summary, keeping recent ones live.

        Returns the new compaction record. Raises ValueError if there aren't
        enough messages to compact.
        """
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            raise ValueError(f"Conversation {conversation_id} not found")

        messages = conv.messages
        if len(messages) < 10:
            raise ValueError("Need at least 10 messages to compact")

        # Keep the last 6 messages un-compacted (roughly 3 exchanges)
        cutoff_index = len(messages) - 6
        messages_to_compact = messages[:cutoff_index]

        # Find previous compaction to use as context
        compactions = self._get_compactions(conversation_id)
        prev_summary = compactions[-1]["summary"] if compactions else None

        # If there's a previous compaction, only summarize messages after it
        if compactions:
            prev_cutoff_id = compactions[-1]["compacted_up_to_msg_id"]
            # Find the index of the previous cutoff message
            start_index = 0
            for i, m in enumerate(messages_to_compact):
                if m.id == prev_cutoff_id:
                    start_index = i + 1
                    break
            new_messages = messages_to_compact[start_index:]
        else:
            new_messages = messages_to_compact

        if not new_messages:
            raise ValueError("No new messages to compact")

        # Build text representation of messages to summarize
        text_parts = []
        for m in new_messages:
            role = "User" if m.role == "user" else "Assistant"
            text_parts.append(f"{role}: {m.text()}")
        messages_text = "\n\n".join(text_parts)

        summary = await self._generate_summary(messages_text, prev_summary)

        # Record which model actually did the summary
        or_client = await self._get_openrouter_client()
        model_used = f"openrouter/{_SYSTEM_MODEL}" if or_client else "claude-haiku-4-5-20251001"

        # Build compaction record
        compaction = {
            "id": f"compact_{uuid.uuid4().hex[:10]}",
            "compacted_up_to_msg_id": messages_to_compact[-1].id,
            "summary": summary,
            "message_count": len(messages_to_compact),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "model_used": model_used,
        }

        # Persist to metadata
        meta = self.db.get_conversation_metadata(conversation_id) or {}
        meta.setdefault("compactions", []).append(compaction)
        self.db.update_conversation_metadata(conversation_id, meta)

        return compaction

    # ------------------------------------------------------------------
    # Prompt composition
    # ------------------------------------------------------------------

    def _get_system_prompt_parts(self, conv: Conversation) -> list[str]:
        """Return system prompt as separate layers for cache-aware callers.

        Returns up to 2 strings:
        [0] Stable layer: universal prompt + conversation prompt + legacy system_prompt
        [1] Dynamic layer: injected files/pins (changes when user adds/removes #tags)

        Callers that support multi-block system prompts (Anthropic) can cache
        each layer independently so that changing #tags doesn't invalidate
        the stable prefix cache. Others join with "\\n\\n".
        """
        # Stable layer — rarely changes within a conversation
        stable_parts: list[str] = []
        universal = ""
        universal_id = self.db.get_setting("universal_prompt_id")
        if universal_id:
            prompt = self.db.get_prompt(universal_id)
            if prompt:
                universal = prompt["content"]
        if not universal:
            universal = self.db.get_setting("universal_prompt") or ""
        if universal:
            stable_parts.append(universal)
        if conv.prompt_id:
            prompt = self.db.get_prompt(conv.prompt_id)
            if prompt:
                stable_parts.append(prompt["content"])
        if conv.system_prompt:
            stable_parts.append(conv.system_prompt)

        layers: list[str] = []
        if stable_parts:
            layers.append("\n\n".join(stable_parts))

        # Dynamic layer — injected files/pins
        files_block = self._build_injected_files_block(conv.id)
        if files_block:
            layers.append(files_block)

        # Substitute {self_label} with the model's display name so chat
        # prompts can reference the model naturally (backrooms does this
        # separately via _substitute_variables).
        model_label = get_model_name(conv.model)
        layers = [l.replace("{self_label}", model_label) for l in layers]

        return layers

    def _get_effective_system_prompt(self, conv: Conversation) -> str:
        """Build the full system prompt as a single string (for non-Anthropic providers)."""
        return "\n\n".join(self._get_system_prompt_parts(conv))

    def _build_cached_system_blocks(self, conv: Conversation) -> list[dict]:
        """Build structured system prompt blocks with cache_control for Anthropic.

        Each layer gets its own cache breakpoint so that changing injected
        files/pins doesn't invalidate the stable prompt prefix cache.
        """
        parts = self._get_system_prompt_parts(conv)
        if not parts:
            return []
        return [
            {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}
            for text in parts
        ]

    def _build_injected_files_block(self, conversation_id: str) -> str:
        """Build XML block of injected context from all registered ContextSources."""
        parts = []
        for source in self.context_sources:
            items = source.get_active(conversation_id)
            if items:
                block = source.format_block(items)
                if block:
                    parts.append(block)
        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_user_content(content: str | list[dict]) -> str | list[ContentBlock]:
        """Convert user input to the appropriate content format.

        Strings pass through as-is. Lists of dicts become ContentBlock lists,
        which is how the API expects multi-block messages (text + images).
        """
        if isinstance(content, str):
            return content
        return [ContentBlock(**block) for block in content]

    async def _execute_tool_blocks(self, tool_blocks: list[ContentBlock]) -> list[ContentBlock]:
        results: list[ContentBlock] = []
        for block in tool_blocks:
            result_text = await self.tools.execute(block.name, block.input or {})
            results.append(ContentBlock(
                type="tool_result",
                tool_use_id=block.id,
                content=result_text,
            ))
        return results

    @staticmethod
    def _to_api_messages(
        messages: list[Message],
        compactions: list[dict] | None = None,
    ) -> list[dict[str, Any]]:
        """Convert messages to API format, optionally replacing compacted messages with a summary.

        If compactions exist, finds the latest one whose cutoff message is in the
        current path. All messages up to and including that cutoff are replaced with
        a user/assistant summary pair to maintain role alternation.
        """
        if not compactions:
            return [m.to_api_format() for m in messages]

        # Build set of message IDs on the current path for lookup
        msg_ids = {m.id for m in messages}

        # Find the latest applicable compaction (cutoff msg must be on current path)
        active_compaction = None
        for c in reversed(compactions):
            if c["compacted_up_to_msg_id"] in msg_ids:
                active_compaction = c
                break

        if not active_compaction:
            return [m.to_api_format() for m in messages]

        # Find the cutoff index
        cutoff_id = active_compaction["compacted_up_to_msg_id"]
        cutoff_index = None
        for i, m in enumerate(messages):
            if m.id == cutoff_id:
                cutoff_index = i
                break

        if cutoff_index is None:
            return [m.to_api_format() for m in messages]

        # Replace compacted messages with a summary pair
        summary_text = active_compaction["summary"]
        api_messages = [
            {"role": "user", "content": f"[Conversation summary]\n\n{summary_text}"},
            {"role": "assistant", "content": "Understood, I have the context from our earlier conversation. Let's continue."},
        ]

        # Append remaining messages after the cutoff
        remaining = messages[cutoff_index + 1:]
        api_messages.extend(m.to_api_format() for m in remaining)

        return api_messages

    @staticmethod
    def _add_message_cache_breakpoints(
        api_messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Add a cache_control breakpoint to the second-to-last user turn.

        This caches the conversation prefix so that only the most recent
        exchange is sent uncached on each new turn. The Anthropic API caches
        everything from the start of the request up to the breakpoint.

        Only useful for Anthropic — callers should skip for other providers.
        """
        if len(api_messages) < 4:
            return api_messages

        # Find the second-to-last user message
        user_indices = [i for i, m in enumerate(api_messages) if m["role"] == "user"]
        if len(user_indices) < 2:
            return api_messages

        target_idx = user_indices[-2]
        msg = api_messages[target_idx]
        content = msg["content"]

        if isinstance(content, str):
            api_messages[target_idx] = {
                "role": msg["role"],
                "content": [
                    {"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}
                ],
            }
        elif isinstance(content, list) and content:
            # Add cache_control to the last content block
            last_block = dict(content[-1])
            last_block["cache_control"] = {"type": "ephemeral"}
            content[-1] = last_block

        return api_messages
