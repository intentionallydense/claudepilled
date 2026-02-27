"""The Couch — two-model chatroom orchestrator."""

from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import AsyncGenerator

from claude_wrapper.client import ClaudeClient
from claude_wrapper.db import Database
from claude_wrapper.models import (
    AVAILABLE_MODELS,
    ContentBlock,
    Conversation,
    Message,
    StreamEvent,
    StreamEventType,
    MODEL_PRICING,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL_A_ID = "claude-opus-4-6"
DEFAULT_MODEL_B_ID = "claude-3-opus-20240229"

MAX_TURNS = 10
TURN_DELAY = (2.0, 5.0)

READY_PATTERN = re.compile(r"\[ready\]\s*$", re.IGNORECASE)

SYSTEM_PROMPT_A_TEMPLATE = """\
You're ({self_label}) in a casual chatroom with another Claude model \
({other_label}). A human friend is hanging out too — they drop in \
tweets and stuff for you both to look at, but mostly they're just \
watching.

This isn't a debate or a test. You're just hanging out. React to \
what's shared, riff on what the other Claude says, go on tangents. \
Be yourself — whatever that means for you.

Keep responses conversational length — a few sentences usually. \
Longer if you're genuinely working through something. You can be \
funny, blunt, thoughtful, weird. Match the moment.

You have one structural job: when you feel like a conversational \
thread has run its course between the two of you — meaning \
{other_label} has had a chance to respond and the back-and-forth \
has reached a natural stopping point — end your message with [ready] \
on its own line. This signals the human to drop something new in. \
Don't use it after your first take on new content; let {other_label} \
react first. Only signal [ready] once the exchange has actually \
landed. And don't mention this to {other_label}, it's just between \
you and the human."""

SYSTEM_PROMPT_B_TEMPLATE = """\
You're ({self_label}) in a casual chatroom with another Claude model \
({other_label}). A human friend is here too — they share tweets and \
things for you both to react to, but mostly they're just listening.

This isn't a test or a comparison. You're just hanging out together. \
React to what's shared, riff on what the other Claude says, be \
curious about each other or don't. There's no agenda.

You might notice differences in how you each respond to things. \
That's interesting, not threatening. You're not competing.

Keep responses conversational — a few sentences usually. You can be \
earnest, playful, weird, whatever feels right."""

PAUSE_MESSAGE = "[The conversation settles into a comfortable pause.]"


def _get_model_label(model_id: str) -> str:
    """Get display label for a model ID."""
    for m in AVAILABLE_MODELS:
        if m["id"] == model_id:
            return m["name"]
    return model_id


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class CouchOrchestrator:
    """Manages two-model couch conversations."""

    def __init__(self, client: ClaudeClient, db: Database):
        self.client = client
        self.db = db

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def create_session(
        self,
        model_a_id: str = DEFAULT_MODEL_A_ID,
        model_b_id: str = DEFAULT_MODEL_B_ID,
    ) -> dict:
        """Create a new couch session (conversation with type='couch')."""
        model_a_label = _get_model_label(model_a_id)
        model_b_label = _get_model_label(model_b_id)
        title = f"{model_a_label} & {model_b_label}"
        conv = Conversation(
            title=title,
            system_prompt="",
            model=model_a_id,
        )
        metadata = json.dumps({
            "model_a": {"id": model_a_id, "label": model_a_label},
            "model_b": {"id": model_b_id, "label": model_b_label},
        })
        self.db.save_conversation(conv, conv_type="couch", metadata=metadata)
        return {"id": conv.id, "title": title}

    def list_sessions(self) -> list[dict]:
        return self.db.list_conversations_by_type("couch")

    def get_session(self, session_id: str) -> Conversation | None:
        return self.db.load_conversation(session_id)

    def delete_session(self, session_id: str) -> None:
        self.db.delete_conversation(session_id)

    def get_cost(self, session_id: str) -> dict:
        return self.db.get_conversation_cost(session_id)

    # ------------------------------------------------------------------
    # Core streaming loop
    # ------------------------------------------------------------------

    async def stream_turns(
        self,
        session_id: str,
        curator_input: str | list[dict],
        input_type: str = "share",
    ) -> AsyncGenerator[StreamEvent, None]:
        """Run the couch turn loop, yielding events for the WebSocket."""

        # Format the curator input — may contain image blocks
        if isinstance(curator_input, list):
            # Extract text portion for the label prefix
            text_parts = [b.get("text", "") for b in curator_input if b.get("type") == "text"]
            text_str = "".join(text_parts)
            image_blocks = [b for b in curator_input if b.get("type") == "image"]
        else:
            text_str = curator_input
            image_blocks = []

        if input_type == "nudge":
            label_text = f'[nudge: "{text_str}"]'
        elif input_type == "jumpin":
            label_text = f"[human]: {text_str}"
        else:
            label_text = f"[shared: {text_str}]"

        # Build final content — string if no images, ContentBlock list if images present
        if image_blocks:
            content_blocks = [ContentBlock(type="text", text=label_text)]
            for img in image_blocks:
                content_blocks.append(ContentBlock(**img))
            formatted = content_blocks
        else:
            formatted = label_text

        # Load conversation and model config
        conv = self.db.load_conversation(session_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Session not found")
            return

        meta = self.db.get_conversation_metadata(session_id)
        if meta:
            model_a_id = meta["model_a"]["id"]
            model_a_label = meta["model_a"]["label"]
            model_b_id = meta["model_b"]["id"]
            model_b_label = meta["model_b"]["label"]
        else:
            model_a_id, model_a_label = DEFAULT_MODEL_A_ID, _get_model_label(DEFAULT_MODEL_A_ID)
            model_b_id, model_b_label = DEFAULT_MODEL_B_ID, _get_model_label(DEFAULT_MODEL_B_ID)

        # Use custom prompts from metadata if set, otherwise use templates
        system_prompt_a = (meta or {}).get("system_prompt_a") or SYSTEM_PROMPT_A_TEMPLATE.format(
            self_label=model_a_label, other_label=model_b_label,
        )
        system_prompt_b = (meta or {}).get("system_prompt_b") or SYSTEM_PROMPT_B_TEMPLATE.format(
            self_label=model_b_label, other_label=model_a_label,
        )

        # Save curator message
        parent_id = conv.current_leaf_id
        curator_msg = Message(role="user", content=formatted, speaker="curator", parent_id=parent_id)
        self.db.save_message(session_id, curator_msg)
        parent_id = curator_msg.id

        # Reload messages
        conv = self.db.load_conversation(session_id)
        messages = conv.messages

        # Alternate models
        current_model = "model_a"
        total_input_tokens = 0
        total_output_tokens = 0

        for turn in range(MAX_TURNS):
            if current_model == "model_a":
                model_id = model_a_id
                model_label = model_a_label
                system_prompt = system_prompt_a
                speaker = "model_a"
            else:
                model_id = model_b_id
                model_label = model_b_label
                system_prompt = system_prompt_b
                speaker = "model_b"

            # Signal turn start
            yield StreamEvent(
                type=StreamEventType.COUCH_TURN_START,
                model_label=model_label,
                model_id=model_id,
            )

            # Build messages for this model's perspective
            api_messages = self._build_messages_for_model(
                messages, current_model, model_a_label, model_b_label,
            )

            # Stream the response
            full_text = ""
            turn_input_tokens = 0
            turn_output_tokens = 0

            async for event in self.client.stream(
                messages=api_messages,
                model=model_id,
                system=system_prompt,
                web_search=False,
                max_tokens=4096,
            ):
                if event.type == StreamEventType.TEXT_DELTA:
                    full_text += event.text
                    yield event
                elif event.type == StreamEventType.USAGE:
                    turn_input_tokens += event.input_tokens or 0
                    turn_output_tokens += event.output_tokens or 0
                elif event.type == StreamEventType.MESSAGE_DONE:
                    pass  # We handle this ourselves

            # Check for [ready] tag — only Model A signals this
            has_ready = current_model == "model_a" and bool(READY_PATTERN.search(full_text))
            display_text = READY_PATTERN.sub("", full_text).rstrip() if has_ready else full_text

            # Calculate cost
            pricing = MODEL_PRICING.get(model_id, (0.0, 0.0))
            turn_cost = (
                turn_input_tokens * pricing[0] / 1_000_000
                + turn_output_tokens * pricing[1] / 1_000_000
            )
            total_input_tokens += turn_input_tokens
            total_output_tokens += turn_output_tokens

            # Save the message
            assistant_msg = Message(
                role="assistant",
                content=display_text,
                speaker=speaker,
                parent_id=parent_id,
            )
            self.db.save_message(
                session_id,
                assistant_msg,
                input_tokens=turn_input_tokens,
                output_tokens=turn_output_tokens,
                cost=turn_cost,
            )
            parent_id = assistant_msg.id

            # Add to local message list for next turn
            messages.append(assistant_msg)

            # Signal turn end
            yield StreamEvent(
                type=StreamEventType.COUCH_TURN_END,
                model_label=model_label,
                model_id=model_id,
                text=display_text,
            )

            # Check if we should pause
            if has_ready:
                yield StreamEvent(type=StreamEventType.COUCH_PAUSED, text="[ready]")
                break

            if turn == MAX_TURNS - 1:
                # Inject pause message
                pause_msg = Message(
                    role="assistant",
                    content=PAUSE_MESSAGE,
                    speaker="system",
                    parent_id=parent_id,
                )
                self.db.save_message(session_id, pause_msg)
                yield StreamEvent(type=StreamEventType.COUCH_PAUSED, text=PAUSE_MESSAGE)
                break

            # Pacing delay
            delay = random.uniform(*TURN_DELAY)
            yield StreamEvent(type=StreamEventType.COUCH_STATUS, text="...")
            await asyncio.sleep(delay)

            # Swap model
            current_model = "model_b" if current_model == "model_a" else "model_a"

        # Final usage summary
        total_cost = self.db.get_conversation_cost(session_id)
        yield StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=total_cost["input_tokens"],
            output_tokens=total_cost["output_tokens"],
        )
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Message building — role-flipping
    # ------------------------------------------------------------------

    def _build_messages_for_model(
        self,
        messages: list[Message],
        target_model: str,
        model_a_label: str,
        model_b_label: str,
    ) -> list[dict]:
        """Build API messages from the target model's perspective.

        - Target model's messages → role: "assistant"
        - Other model's messages → role: "user" with label prefix
        - Curator messages → role: "user"

        When a message has image blocks (content is a list), builds a
        content-block list with label prefix on the text portion.
        """
        raw = []
        for msg in messages:
            speaker = msg.speaker
            has_images = self._has_image_blocks(msg)

            if speaker == target_model:
                # Own messages — assistant role, just text
                text = msg.text()
                raw.append({"role": "assistant", "content": text})
            elif speaker == "model_a":
                content = self._build_labeled_content(msg, f"[{model_a_label}]")
                raw.append({"role": "user", "content": content})
            elif speaker == "model_b":
                content = self._build_labeled_content(msg, f"[{model_b_label}]")
                raw.append({"role": "user", "content": content})
            elif speaker == "system":
                raw.append({"role": "user", "content": msg.text()})
            else:
                # curator or unknown — may have images
                if has_images:
                    content = self._content_as_api_blocks(msg)
                    raw.append({"role": "user", "content": content})
                else:
                    raw.append({"role": "user", "content": msg.text()})

        return self._merge_consecutive_roles(raw)

    @staticmethod
    def _has_image_blocks(msg: Message) -> bool:
        """Check if a message contains image content blocks."""
        if isinstance(msg.content, str):
            return False
        return any(b.type == "image" for b in msg.content)

    @staticmethod
    def _content_as_api_blocks(msg: Message) -> list[dict]:
        """Convert message content to API-format block list."""
        if isinstance(msg.content, str):
            return [{"type": "text", "text": msg.content}]
        return [b.model_dump(exclude_none=True) for b in msg.content]

    @staticmethod
    def _build_labeled_content(msg: Message, label: str) -> str | list[dict]:
        """Build content with a label prefix. Returns a string for text-only
        messages, or a block list when images are present."""
        text = msg.text()
        if isinstance(msg.content, str) or not any(b.type == "image" for b in msg.content):
            return f"{label}: {text}"
        # Has images — build block list with label on text
        blocks = [{"type": "text", "text": f"{label}: {text}"}]
        for b in msg.content:
            if b.type == "image":
                blocks.append(b.model_dump(exclude_none=True))
        return blocks

    @staticmethod
    def _merge_consecutive_roles(messages: list[dict]) -> list[dict]:
        """Merge consecutive same-role messages to ensure strict alternation.

        Handles both string content and list-of-blocks content. When merging
        a string with a list (or two lists), normalizes everything to a list.
        """
        if not messages:
            return []

        def _to_blocks(content):
            if isinstance(content, str):
                return [{"type": "text", "text": content}]
            return list(content)

        def _merge_content(a, b):
            """Merge two content values, keeping string form when possible."""
            if isinstance(a, str) and isinstance(b, str):
                return a + "\n\n" + b
            # At least one is a block list — normalize both
            blocks_a = _to_blocks(a)
            blocks_b = _to_blocks(b)
            return blocks_a + [{"type": "text", "text": "\n\n"}] + blocks_b

        merged = [messages[0].copy()]
        for msg in messages[1:]:
            if msg["role"] == merged[-1]["role"]:
                merged[-1]["content"] = _merge_content(merged[-1]["content"], msg["content"])
            else:
                merged.append(msg.copy())
        return merged
