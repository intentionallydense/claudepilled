"""Claude tool definitions for the moodboard.

Lets Claude pin content to and remove content from the shared moodboard.
Used by server.py — call register_pin_tools(registry, pin_db) at startup.
"""

from __future__ import annotations

import json

from claude_wrapper.pin_db import PinDatabase
from claude_wrapper.tools import ToolRegistry


def register_pin_tools(registry: ToolRegistry, pin_db: PinDatabase) -> None:
    """Register moodboard tools on the given registry."""

    @registry.tool(description="Pin content to the shared moodboard. Use this to save interesting text, links, or images for Sylvia to see.")
    def moodboard_pin(
        content: str,
        type: str,
        note: str = "",
    ) -> str:
        """
        Params:
            content: The text, URL, or image data to pin
            type: Pin type — 'text', 'link', or 'image'
            note: Optional annotation to display with the pin
        """
        if type not in ("text", "link", "image"):
            return json.dumps({"error": "type must be 'text', 'link', or 'image'"})
        kwargs = {
            "type": type,
            "content": content,
            "source": "claude",
        }
        if note:
            kwargs["note"] = note
        pin = pin_db.create(**kwargs)
        return json.dumps(pin, default=str)

    @registry.tool(description="Remove a pin from the shared moodboard by its ID.")
    def moodboard_remove(id: str) -> str:
        """
        Params:
            id: The pin ID to remove
        """
        pin = pin_db.get(id)
        if pin is None:
            return json.dumps({"error": "Pin not found"})
        pin_db.delete(id)
        return json.dumps({"ok": True, "removed": id})
