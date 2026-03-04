"""Conversation manager — orchestrates chat turns, tool execution, and persistence.

Routes between Anthropic and OpenAI-compatible providers based on the
conversation's model. Tool use is only supported for Anthropic models;
non-Anthropic models get tools=None. Title and summary generation use
GLM5 via OpenRouter (cheap, fast).

Used by: server.py (creates the singleton ConversationManager at startup)
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from claude_wrapper.client import ClaudeClient, get_client_for_model
from claude_wrapper.db import Database
from claude_wrapper.models import (
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
)
from claude_wrapper.tools import ToolRegistry

log = logging.getLogger(__name__)

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
        file_db: "FileDatabase | None" = None,
        pin_db: "PinDatabase | None" = None,
    ):
        self.client = client
        self.tools = tool_registry or ToolRegistry()
        self.db = db or Database()
        self.file_db = file_db
        self.pin_db = pin_db
        self._openrouter_client = None  # lazy-init AsyncOpenAI for system tasks

    def _get_client_and_tools(self, model: str):
        """Return (client, tool_defs, is_anthropic) for the given model.

        Anthropic providers get Anthropic-format tool definitions. OpenAI-
        compatible providers get OpenAI function-calling format. Web search
        and prompt caching are Anthropic-only features.
        """
        provider = get_provider_for_model(model)
        is_anthropic = provider == "anthropic"
        client = get_client_for_model(model, self.client)
        raw_tools = self.tools.get_definitions() or None
        if raw_tools and not is_anthropic:
            tool_defs = [t.to_openai_format() for t in raw_tools]
        else:
            tool_defs = raw_tools
        return client, tool_defs, is_anthropic

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

        client, tool_defs, is_anthropic = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        api_messages = self._to_api_messages(conv.messages, compactions)
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            assistant_msg = client.send(
                messages=api_messages,
                tools=tool_defs,
                model=get_api_model_id(conv.model),
                system=effective_system,
                thinking_budget=thinking_budget,
                web_search=is_anthropic,
            )
            assistant_msg.parent_id = conv.messages[-1].id
            conv.messages.append(assistant_msg)
            self.db.save_message(conversation_id, assistant_msg)
            api_messages = self._to_api_messages(conv.messages, compactions)

            tool_blocks = assistant_msg.tool_use_blocks()
            if not tool_blocks:
                break

            tool_results = self._execute_tool_blocks(tool_blocks)
            tool_msg = Message(role="user", content=tool_results, parent_id=assistant_msg.id)
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)
            api_messages = self._to_api_messages(conv.messages, compactions)

        return conv.messages[-1].text()

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

        # Track whether this is the first user message (for auto-title)
        is_first_message = len(conv.messages) == 0

        # Build message content — string stays as-is, list becomes ContentBlocks
        msg_content = self._normalize_user_content(user_content)

        # Append user message with parent = current leaf
        user_msg = Message(role="user", content=msg_content, parent_id=conv.current_leaf_id)
        conv.messages.append(user_msg)
        self.db.save_message(conversation_id, user_msg)

        client, tool_defs, is_anthropic = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages, compactions)
            collected_blocks: list[ContentBlock] = []
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            thinking_signature: str | None = None
            pending_tools: dict[str, dict[str, Any]] = {}
            message_input_tokens: int = 0
            message_output_tokens: int = 0
            cache_creation_tokens: int = 0
            cache_read_tokens: int = 0

            async for event in client.stream(
                messages=api_messages,
                tools=tool_defs,
                model=get_api_model_id(conv.model),
                system=effective_system,
                thinking_budget=thinking_budget,
                web_search=is_anthropic,
            ):
                # Don't forward MESSAGE_DONE from inner stream — we emit our own
                if event.type == StreamEventType.MESSAGE_DONE:
                    continue
                yield event

                if event.type == StreamEventType.TEXT_DELTA and event.text:
                    text_parts.append(event.text)

                elif event.type == StreamEventType.THINKING_DELTA and event.thinking:
                    thinking_parts.append(event.thinking)

                elif event.type == StreamEventType.THINKING_DONE:
                    thinking_signature = event.signature

                elif event.type == StreamEventType.TOOL_USE_START:
                    pending_tools[event.tool_use_id] = {
                        "name": event.tool_name,
                        "input": {},
                    }

                elif event.type == StreamEventType.TOOL_USE_DELTA:
                    if event.tool_use_id and isinstance(event.tool_input, dict):
                        pending_tools[event.tool_use_id]["input"] = event.tool_input

                elif event.type == StreamEventType.USAGE:
                    if event.input_tokens:
                        message_input_tokens = event.input_tokens
                    if event.output_tokens:
                        message_output_tokens = event.output_tokens
                    if event.cache_creation_input_tokens:
                        cache_creation_tokens = event.cache_creation_input_tokens
                    if event.cache_read_input_tokens:
                        cache_read_tokens = event.cache_read_input_tokens

            # Build the assistant message
            if thinking_parts:
                collected_blocks.append(ContentBlock(
                    type="thinking",
                    thinking="".join(thinking_parts),
                    signature=thinking_signature,
                ))
            if text_parts:
                collected_blocks.append(ContentBlock(type="text", text="".join(text_parts)))
            for tool_id, tool_info in pending_tools.items():
                collected_blocks.append(ContentBlock(
                    type="tool_use",
                    id=tool_id,
                    name=tool_info["name"],
                    input=tool_info["input"],
                ))

            # Compute cost — cache writes cost 1.25x input, cache reads cost 0.1x input
            pricing = MODEL_PRICING.get(conv.model, (3.0, 15.0))
            input_price, output_price = pricing
            cost = (
                message_input_tokens * input_price
                + message_output_tokens * output_price
                + cache_creation_tokens * (input_price * 1.25)
                + cache_read_tokens * (input_price * 0.1)
            ) / 1_000_000

            if collected_blocks:
                assistant_msg = Message(
                    role="assistant",
                    content=collected_blocks,
                    parent_id=conv.messages[-1].id,
                )
                conv.messages.append(assistant_msg)
                self.db.save_message(
                    conversation_id,
                    assistant_msg,
                    input_tokens=message_input_tokens,
                    output_tokens=message_output_tokens,
                    cost=cost,
                    cache_creation_input_tokens=cache_creation_tokens,
                    cache_read_input_tokens=cache_read_tokens,
                )

            if not pending_tools:
                break

            # Execute tools
            tool_use_blocks = [b for b in collected_blocks if b.type == "tool_use"]
            tool_results = self._execute_tool_blocks(tool_use_blocks)

            for result_block in tool_results:
                yield StreamEvent(
                    type=StreamEventType.TOOL_RESULT,
                    tool_use_id=result_block.tool_use_id,
                    tool_result=result_block.content,
                )

            tool_msg = Message(
                role="user",
                content=tool_results,
                parent_id=conv.messages[-1].id,
            )
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)

        # Auto-generate title after first exchange
        if is_first_message:
            title_text = user_msg.text() if isinstance(msg_content, list) else str(user_content)
            title = await self._generate_title(title_text)
            self.db.update_conversation_title(conversation_id, title)
            yield StreamEvent(type=StreamEventType.TITLE_UPDATE, text=title)

        # Emit final usage with conversation totals
        conv_cost = self.db.get_conversation_cost(conversation_id)
        yield StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=conv_cost["input_tokens"],
            output_tokens=conv_cost["output_tokens"],
            cache_creation_input_tokens=conv_cost["cache_creation_tokens"],
            cache_read_input_tokens=conv_cost["cache_read_tokens"],
        )
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Model speaks first (no user message)
    # ------------------------------------------------------------------

    async def stream_init(
        self,
        conversation_id: str,
        model: str = "claude-haiku-4-5-20251001",
    ) -> AsyncGenerator[StreamEvent, None]:
        """Generate an initial assistant message with no user input.

        Used for "model speaks first" flows like brain dump — the model
        reads the system prompt and starts the conversation. Always uses
        the specified model with no thinking budget.
        """
        conv = self.db.load_conversation(conversation_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation not found")
            return
        if conv.messages:
            yield StreamEvent(type=StreamEventType.ERROR, error="Conversation already has messages")
            return

        effective_system = self._get_effective_system_prompt(conv)

        # Single user message to prime the model — invisible to the user
        api_messages = [{"role": "user", "content": "Go ahead."}]

        client, tool_defs, is_anthropic = self._get_client_and_tools(model)
        collected_blocks: list[ContentBlock] = []
        text_parts: list[str] = []
        message_input_tokens = 0
        message_output_tokens = 0
        cache_creation_tokens = 0
        cache_read_tokens = 0

        async for event in client.stream(
            messages=api_messages,
            tools=tool_defs,
            model=get_api_model_id(model),
            system=effective_system,
            web_search=is_anthropic,
        ):
            if event.type == StreamEventType.MESSAGE_DONE:
                continue
            yield event

            if event.type == StreamEventType.TEXT_DELTA and event.text:
                text_parts.append(event.text)
            elif event.type == StreamEventType.USAGE:
                if event.input_tokens:
                    message_input_tokens = event.input_tokens
                if event.output_tokens:
                    message_output_tokens = event.output_tokens
                if event.cache_creation_input_tokens:
                    cache_creation_tokens = event.cache_creation_input_tokens
                if event.cache_read_input_tokens:
                    cache_read_tokens = event.cache_read_input_tokens

        if text_parts:
            collected_blocks.append(ContentBlock(type="text", text="".join(text_parts)))

        pricing = MODEL_PRICING.get(model, (5.0, 25.0))
        input_price, output_price = pricing
        cost = (
            message_input_tokens * input_price
            + message_output_tokens * output_price
            + cache_creation_tokens * (input_price * 1.25)
            + cache_read_tokens * (input_price * 0.1)
        ) / 1_000_000

        if collected_blocks:
            assistant_msg = Message(
                role="assistant",
                content=collected_blocks,
                parent_id=None,
            )
            conv.messages.append(assistant_msg)
            self.db.save_message(
                conversation_id, assistant_msg,
                input_tokens=message_input_tokens,
                output_tokens=message_output_tokens,
                cost=cost,
                cache_creation_input_tokens=cache_creation_tokens,
                cache_read_input_tokens=cache_read_tokens,
            )

        conv_cost = self.db.get_conversation_cost(conversation_id)
        yield StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=conv_cost["input_tokens"],
            output_tokens=conv_cost["output_tokens"],
            cache_creation_input_tokens=conv_cost["cache_creation_tokens"],
            cache_read_input_tokens=conv_cost["cache_read_tokens"],
        )
        # Include actual model used so the frontend can label it correctly
        model_name = None
        for m in AVAILABLE_MODELS:
            if m["id"] == model:
                model_name = m["name"]
                break
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE, model_id=model, model_label=model_name or model)

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

        # Build message content — string stays as-is, list becomes ContentBlocks
        msg_content = self._normalize_user_content(new_content)

        # Create new user message branching from parent_id
        user_msg = Message(role="user", content=msg_content, parent_id=parent_id)
        self.db.save_message(conversation_id, user_msg)

        # Reload conversation from the new leaf
        conv = self.db.load_conversation(conversation_id)

        client, tool_defs, is_anthropic = self._get_client_and_tools(conv.model)
        compactions = self._get_compactions(conversation_id)
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages, compactions)
            collected_blocks: list[ContentBlock] = []
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            thinking_signature: str | None = None
            pending_tools: dict[str, dict[str, Any]] = {}
            message_input_tokens: int = 0
            message_output_tokens: int = 0
            cache_creation_tokens: int = 0
            cache_read_tokens: int = 0

            async for event in client.stream(
                messages=api_messages,
                tools=tool_defs,
                model=get_api_model_id(conv.model),
                system=effective_system,
                thinking_budget=thinking_budget,
                web_search=is_anthropic,
            ):
                # Don't forward MESSAGE_DONE from inner stream — we emit our own
                if event.type == StreamEventType.MESSAGE_DONE:
                    continue
                yield event

                if event.type == StreamEventType.TEXT_DELTA and event.text:
                    text_parts.append(event.text)
                elif event.type == StreamEventType.THINKING_DELTA and event.thinking:
                    thinking_parts.append(event.thinking)
                elif event.type == StreamEventType.THINKING_DONE:
                    thinking_signature = event.signature
                elif event.type == StreamEventType.TOOL_USE_START:
                    pending_tools[event.tool_use_id] = {"name": event.tool_name, "input": {}}
                elif event.type == StreamEventType.TOOL_USE_DELTA:
                    if event.tool_use_id and isinstance(event.tool_input, dict):
                        pending_tools[event.tool_use_id]["input"] = event.tool_input
                elif event.type == StreamEventType.USAGE:
                    if event.input_tokens:
                        message_input_tokens = event.input_tokens
                    if event.output_tokens:
                        message_output_tokens = event.output_tokens
                    if event.cache_creation_input_tokens:
                        cache_creation_tokens = event.cache_creation_input_tokens
                    if event.cache_read_input_tokens:
                        cache_read_tokens = event.cache_read_input_tokens

            if thinking_parts:
                collected_blocks.append(ContentBlock(
                    type="thinking",
                    thinking="".join(thinking_parts),
                    signature=thinking_signature,
                ))
            if text_parts:
                collected_blocks.append(ContentBlock(type="text", text="".join(text_parts)))
            for tool_id, tool_info in pending_tools.items():
                collected_blocks.append(ContentBlock(
                    type="tool_use", id=tool_id, name=tool_info["name"], input=tool_info["input"],
                ))

            pricing = MODEL_PRICING.get(conv.model, (3.0, 15.0))
            input_price, output_price = pricing
            cost = (
                message_input_tokens * input_price
                + message_output_tokens * output_price
                + cache_creation_tokens * (input_price * 1.25)
                + cache_read_tokens * (input_price * 0.1)
            ) / 1_000_000

            if collected_blocks:
                assistant_msg = Message(
                    role="assistant", content=collected_blocks,
                    parent_id=conv.messages[-1].id,
                )
                conv.messages.append(assistant_msg)
                self.db.save_message(
                    conversation_id, assistant_msg, message_input_tokens, message_output_tokens, cost,
                    cache_creation_input_tokens=cache_creation_tokens,
                    cache_read_input_tokens=cache_read_tokens,
                )

            if not pending_tools:
                break

            tool_use_blocks = [b for b in collected_blocks if b.type == "tool_use"]
            tool_results = self._execute_tool_blocks(tool_use_blocks)
            for result_block in tool_results:
                yield StreamEvent(
                    type=StreamEventType.TOOL_RESULT,
                    tool_use_id=result_block.tool_use_id,
                    tool_result=result_block.content,
                )
            tool_msg = Message(role="user", content=tool_results, parent_id=conv.messages[-1].id)
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)

        conv_cost = self.db.get_conversation_cost(conversation_id)
        yield StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=conv_cost["input_tokens"],
            output_tokens=conv_cost["output_tokens"],
            cache_creation_input_tokens=conv_cost["cache_creation_tokens"],
            cache_read_input_tokens=conv_cost["cache_read_tokens"],
        )
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

    def _get_effective_system_prompt(self, conv: Conversation) -> str:
        """Build the system prompt from universal prompt + saved prompt (if selected).

        The universal prompt can be set two ways:
        - universal_prompt_id: references a saved chat prompt (preferred)
        - universal_prompt: legacy raw text fallback
        Falls back to conv.system_prompt for legacy conversations that have
        a baked-in prompt but no prompt_id.
        """
        universal = ""
        universal_id = self.db.get_setting("universal_prompt_id")
        if universal_id:
            prompt = self.db.get_prompt(universal_id)
            if prompt:
                universal = prompt["content"]
        if not universal:
            universal = self.db.get_setting("universal_prompt") or ""
        parts = [universal] if universal else []
        if conv.prompt_id:
            prompt = self.db.get_prompt(conv.prompt_id)
            if prompt:
                parts.append(prompt["content"])
        if conv.system_prompt:
            parts.append(conv.system_prompt)
        # Append injected files if any are active for this conversation
        files_block = self._build_injected_files_block(conv.id)
        if files_block:
            parts.append(files_block)
        return "\n\n".join(parts)

    def _build_injected_files_block(self, conversation_id: str) -> str:
        """Build XML block of injected files and tagged pins for the system prompt."""
        parts = []

        # Inject active files
        if self.file_db:
            active_file_ids = self.file_db.get_active_file_ids(conversation_id)
            files = []
            for fid in active_file_ids:
                f = self.file_db.get_file(fid)
                if f:
                    files.append(f)
            if files:
                files.sort(key=lambda f: f["filename"])
                parts.append("<injected_files>")
                for f in files:
                    tags_str = ", ".join(f["tags"]) if isinstance(f["tags"], list) else f["tags"]
                    parts.append(f'<file name="{f["filename"]}" tags="{tags_str}" tokens="{f["token_count"]}">')
                    parts.append(f["content"])
                    parts.append("</file>")
                parts.append("</injected_files>")

        # Inject active pins (skip image pins — data URIs too large for context)
        if self.pin_db:
            active_pin_ids = self.pin_db.get_active_pin_ids(conversation_id)
            pins = []
            for pid in active_pin_ids:
                p = self.pin_db.get(pid)
                if p and p["type"] != "image":
                    pins.append(p)
            if pins:
                parts.append("<injected_pins>")
                for p in pins:
                    tags_str = ", ".join(p["tags"]) if isinstance(p["tags"], list) else str(p["tags"])
                    parts.append(f'<pin type="{p["type"]}" tags="{tags_str}">')
                    parts.append(p["content"])
                    parts.append("</pin>")
                parts.append("</injected_pins>")

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

    def _execute_tool_blocks(self, tool_blocks: list[ContentBlock]) -> list[ContentBlock]:
        results: list[ContentBlock] = []
        for block in tool_blocks:
            result_text = self.tools.execute(block.name, block.input or {})
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
