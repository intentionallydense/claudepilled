"""Parse Claude.ai conversation exports into episodes for Graphiti ingestion.

Input: Claude.ai JSON export (conversations.json from Settings > Account > Export Data)
Output: List of Episode dicts, each representing one human-assistant turn.

The export format is a JSON array of conversation objects:
  [{uuid, name, summary, created_at, updated_at, chat_messages: [{uuid, text,
    content: [{type, text, ...}], sender, created_at, ...}]}]

Content block types: text, thinking, tool_use, tool_result.
Only text blocks are extracted; thinking/tool_use/tool_result are stripped.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass
class Episode:
    """One conversational turn (human message + assistant response)."""

    content: str  # Combined human + assistant text
    timestamp: str  # ISO timestamp of the human message
    conversation_id: str
    conversation_title: str
    source: str = "claude.ai_export"

    def to_dict(self) -> dict:
        return {
            "content": self.content,
            "timestamp": self.timestamp,
            "conversation_id": self.conversation_id,
            "conversation_title": self.conversation_title,
            "source": self.source,
        }


def _extract_text(message: dict) -> str:
    """Extract plain text from a message, stripping tool_use/tool_result/thinking blocks."""
    content = message.get("content", [])
    if isinstance(content, str):
        return content.strip()

    parts = []
    for block in content:
        if block.get("type") == "text" and block.get("text"):
            parts.append(block["text"].strip())
    return "\n".join(parts)


def _parse_conversation(conv: dict) -> list[Episode]:
    """Parse a single conversation into a list of episodes (turn pairs)."""
    messages = conv.get("chat_messages", [])
    title = conv.get("name", "") or conv.get("summary", "") or "(untitled)"
    conv_id = conv.get("uuid", "")

    episodes = []
    i = 0
    while i < len(messages):
        msg = messages[i]

        # Look for human message
        if msg.get("sender") != "human":
            i += 1
            continue

        human_text = _extract_text(msg)
        human_ts = msg.get("created_at", conv.get("created_at", ""))

        # Collect all following assistant messages (there may be multiple
        # from tool use loops) until the next human message
        assistant_parts = []
        j = i + 1
        while j < len(messages) and messages[j].get("sender") != "human":
            if messages[j].get("sender") == "assistant":
                text = _extract_text(messages[j])
                if text:
                    assistant_parts.append(text)
            j += 1

        assistant_text = "\n".join(assistant_parts)

        # Only create an episode if we have substantive content
        if human_text or assistant_text:
            # Truncate very long messages to keep entity extraction manageable
            combined = f"Human: {human_text}\n\nAssistant: {assistant_text}"
            if len(combined) > 15000:
                combined = combined[:15000] + "\n[truncated]"

            episodes.append(Episode(
                content=combined,
                timestamp=human_ts,
                conversation_id=conv_id,
                conversation_title=title,
            ))

        i = j  # Skip to next human message

    return episodes


def parse_export(export_path: str | Path, after: str | None = None) -> list[Episode]:
    """Parse a Claude.ai export file into a chronologically sorted list of episodes.

    Args:
        export_path: Path to conversations.json
        after: Optional ISO date string — only include conversations after this date
    """
    path = Path(export_path)
    if not path.exists():
        raise FileNotFoundError(f"Export file not found: {path}")

    with open(path) as f:
        conversations = json.load(f)

    if not isinstance(conversations, list):
        raise ValueError(f"Expected a JSON array, got {type(conversations).__name__}")

    log.info("Parsing %d conversations", len(conversations))

    after_dt = None
    if after:
        after_dt = datetime.fromisoformat(after.replace("Z", "+00:00"))
        if after_dt.tzinfo is None:
            from datetime import timezone
            after_dt = after_dt.replace(tzinfo=timezone.utc)

    episodes = []
    skipped_empty = 0
    skipped_date = 0

    for conv in conversations:
        messages = conv.get("chat_messages", [])
        if len(messages) < 2:
            skipped_empty += 1
            continue

        if after_dt:
            conv_date = conv.get("created_at", "")
            if conv_date:
                try:
                    dt = datetime.fromisoformat(conv_date.replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        from datetime import timezone
                        dt = dt.replace(tzinfo=timezone.utc)
                    if dt < after_dt:
                        skipped_date += 1
                        continue
                except ValueError:
                    pass

        conv_episodes = _parse_conversation(conv)
        episodes.extend(conv_episodes)

    # Sort chronologically
    episodes.sort(key=lambda e: e.timestamp)

    log.info(
        "Parsed %d episodes from %d conversations (skipped %d empty, %d before date filter)",
        len(episodes),
        len(conversations) - skipped_empty - skipped_date,
        skipped_empty,
        skipped_date,
    )

    return episodes
