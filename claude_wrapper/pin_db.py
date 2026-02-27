"""SQLite persistence layer for moodboard pins.

Stores text, links, images (as data URIs), and pinned chat messages.
Used by pin_routes.py (API endpoints) and pin_tools.py (Claude tool calls).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from claude_wrapper.db import Database


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


class PinDatabase:
    """CRUD operations for the pins table."""

    def __init__(self, db: Database):
        self.db_path = db.db_path
        self._init_table()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_table(self) -> None:
        conn = self._connect()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS pins (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                note TEXT,
                source TEXT NOT NULL,
                conversation_id TEXT,
                message_id TEXT,
                created TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_pins_created ON pins(created);
        """)
        conn.commit()
        conn.close()

    def create(self, **kwargs: Any) -> dict:
        """Create a pin. Returns the full pin dict."""
        pin = {
            "id": _new_id(),
            "type": kwargs["type"],
            "content": kwargs["content"],
            "note": kwargs.get("note"),
            "source": kwargs.get("source", "sylvia"),
            "conversation_id": kwargs.get("conversation_id"),
            "message_id": kwargs.get("message_id"),
            "created": _utcnow(),
        }
        conn = self._connect()
        conn.execute(
            """INSERT INTO pins (id, type, content, note, source,
               conversation_id, message_id, created)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (pin["id"], pin["type"], pin["content"], pin["note"],
             pin["source"], pin["conversation_id"], pin["message_id"],
             pin["created"]),
        )
        conn.commit()
        conn.close()
        return pin

    def get(self, pin_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM pins WHERE id = ?", (pin_id,)).fetchone()
        conn.close()
        return dict(row) if row else None

    def list_pins(self, limit: int = 200) -> list[dict]:
        """List all pins, newest first."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT * FROM pins ORDER BY created DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def delete(self, pin_id: str) -> bool:
        """Permanently delete a pin."""
        conn = self._connect()
        conn.execute("DELETE FROM pins WHERE id = ?", (pin_id,))
        conn.commit()
        conn.close()
        return True
