"""Conversation manager — orchestrates chat turns, tool execution, and persistence."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from typing import Any

from claude_wrapper.client import ClaudeClient
from claude_wrapper.db import Database
from claude_wrapper.models import (
    MODEL_PRICING,
    ContentBlock,
    Conversation,
    Message,
    StreamEvent,
    StreamEventType,
)
from claude_wrapper.tools import ToolRegistry


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

        tool_defs = self.tools.get_definitions() or None
        api_messages = self._to_api_messages(conv.messages)
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            assistant_msg = self.client.send(
                messages=api_messages,
                tools=tool_defs,
                model=conv.model,
                system=effective_system,
                thinking_budget=thinking_budget,
            )
            assistant_msg.parent_id = conv.messages[-1].id
            conv.messages.append(assistant_msg)
            self.db.save_message(conversation_id, assistant_msg)
            api_messages = self._to_api_messages(conv.messages)

            tool_blocks = assistant_msg.tool_use_blocks()
            if not tool_blocks:
                break

            tool_results = self._execute_tool_blocks(tool_blocks)
            tool_msg = Message(role="user", content=tool_results, parent_id=assistant_msg.id)
            conv.messages.append(tool_msg)
            self.db.save_message(conversation_id, tool_msg)
            api_messages = self._to_api_messages(conv.messages)

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

        tool_defs = self.tools.get_definitions() or None
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages)
            collected_blocks: list[ContentBlock] = []
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            thinking_signature: str | None = None
            pending_tools: dict[str, dict[str, Any]] = {}
            message_input_tokens: int = 0
            message_output_tokens: int = 0

            async for event in self.client.stream(
                messages=api_messages,
                tools=tool_defs,
                model=conv.model,
                system=effective_system,
                thinking_budget=thinking_budget,
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

            # Compute cost
            pricing = MODEL_PRICING.get(conv.model, (3.0, 15.0))
            cost = (message_input_tokens * pricing[0] + message_output_tokens * pricing[1]) / 1_000_000

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
        )
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

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

        tool_defs = self.tools.get_definitions() or None
        effective_system = self._get_effective_system_prompt(conv)

        for _ in range(10):
            api_messages = self._to_api_messages(conv.messages)
            collected_blocks: list[ContentBlock] = []
            text_parts: list[str] = []
            thinking_parts: list[str] = []
            thinking_signature: str | None = None
            pending_tools: dict[str, dict[str, Any]] = {}
            message_input_tokens: int = 0
            message_output_tokens: int = 0

            async for event in self.client.stream(
                messages=api_messages,
                tools=tool_defs,
                model=conv.model,
                system=effective_system,
                thinking_budget=thinking_budget,
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
            cost = (message_input_tokens * pricing[0] + message_output_tokens * pricing[1]) / 1_000_000

            if collected_blocks:
                assistant_msg = Message(
                    role="assistant", content=collected_blocks,
                    parent_id=conv.messages[-1].id,
                )
                conv.messages.append(assistant_msg)
                self.db.save_message(conversation_id, assistant_msg, message_input_tokens, message_output_tokens, cost)

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
        """Generate a short title from the first user message using Haiku."""
        try:
            response = await self.client._async_client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=30,
                messages=[{
                    "role": "user",
                    "content": (
                        "Generate a brief title (max 6 words) for a conversation that starts with "
                        "this message. Return only the title, no quotes or punctuation.\n\n"
                        + user_text[:500]
                    ),
                }],
            )
            return response.content[0].text.strip().strip('"').strip("'")
        except Exception:
            return user_text[:40] + ("..." if len(user_text) > 40 else "")

    # ------------------------------------------------------------------
    # Prompt composition
    # ------------------------------------------------------------------

    def _get_effective_system_prompt(self, conv: Conversation) -> str:
        """Build the system prompt from universal_prompt + saved prompt (if selected).

        Falls back to conv.system_prompt for legacy conversations that have
        a baked-in prompt but no prompt_id.
        """
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
    def _to_api_messages(messages: list[Message]) -> list[dict[str, Any]]:
        return [m.to_api_format() for m in messages]
