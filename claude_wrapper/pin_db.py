"""SQLite persistence layer for moodboard pins.

Stores text, links, images (as data URIs), and pinned chat messages.
Pins can have tags for context injection alongside files.
Used by pin_routes.py (API endpoints) and pin_tools.py (Claude tool calls).
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from claude_wrapper.db import Database


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _normalize_tag(tag: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", tag.lower().strip())


class PinDatabase:
    """CRUD operations for the pins table and per-conversation active pin context."""

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
        # Idempotent migrations
        for migration in [
            "ALTER TABLE pins ADD COLUMN tags TEXT DEFAULT '[]'",
            "ALTER TABLE pins ADD COLUMN archived INTEGER DEFAULT 0",
        ]:
            try:
                conn.execute(migration)
                conn.commit()
            except sqlite3.OperationalError:
                pass
        conn.close()

    # ------------------------------------------------------------------
    # Pin CRUD
    # ------------------------------------------------------------------

    def create(self, **kwargs: Any) -> dict:
        """Create a pin. Returns the full pin dict including parsed tags."""
        raw_tags = kwargs.get("tags", [])
        normalized_tags = [_normalize_tag(t) for t in raw_tags if _normalize_tag(t)]
        pin = {
            "id": _new_id(),
            "type": kwargs["type"],
            "content": kwargs["content"],
            "note": kwargs.get("note"),
            "source": kwargs.get("source", "sylvia"),
            "conversation_id": kwargs.get("conversation_id"),
            "message_id": kwargs.get("message_id"),
            "tags": normalized_tags,
            "created": _utcnow(),
        }
        conn = self._connect()
        conn.execute(
            """INSERT INTO pins (id, type, content, note, source,
               conversation_id, message_id, tags, created)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pin["id"], pin["type"], pin["content"], pin["note"],
             pin["source"], pin["conversation_id"], pin["message_id"],
             json.dumps(pin["tags"]), pin["created"]),
        )
        conn.commit()
        conn.close()
        return pin

    def get(self, pin_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM pins WHERE id = ?", (pin_id,)).fetchone()
        conn.close()
        return self._row_to_dict(row) if row else None

    def list_pins(self, limit: int = 200, include_archived: bool = False) -> list[dict]:
        """List pins, newest first. Excludes archived by default."""
        conn = self._connect()
        if include_archived:
            rows = conn.execute(
                "SELECT * FROM pins ORDER BY created DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM pins WHERE archived = 0 ORDER BY created DESC LIMIT ?",
                (limit,),
            ).fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def archive(self, pin_id: str) -> bool:
        """Archive a pin (soft-delete, hidden from board but preserved)."""
        conn = self._connect()
        conn.execute("UPDATE pins SET archived = 1 WHERE id = ?", (pin_id,))
        conn.commit()
        conn.close()
        return True

    def delete(self, pin_id: str) -> bool:
        """Permanently delete a pin."""
        conn = self._connect()
        conn.execute("DELETE FROM pins WHERE id = ?", (pin_id,))
        conn.commit()
        conn.close()
        return True

    # ------------------------------------------------------------------
    # Tag operations
    # ------------------------------------------------------------------

    def update_tags(self, pin_id: str, tags: list[str]) -> dict | None:
        """Replace a pin's tags. Returns the updated pin."""
        normalized = [_normalize_tag(t) for t in tags if _normalize_tag(t)]
        conn = self._connect()
        conn.execute(
            "UPDATE pins SET tags = ? WHERE id = ?",
            (json.dumps(normalized), pin_id),
        )
        conn.commit()
        conn.close()
        return self.get(pin_id)

    def list_all_tags(self) -> list[str]:
        """Return sorted unique tags across all pins."""
        conn = self._connect()
        rows = conn.execute("SELECT tags FROM pins").fetchall()
        conn.close()
        all_tags: set[str] = set()
        for row in rows:
            all_tags.update(json.loads(row["tags"]))
        return sorted(all_tags)

    def get_pins_by_tags(self, tags: list[str]) -> list[dict]:
        """Return pins matching ANY of the given tags (union, deduplicated)."""
        normalized = {_normalize_tag(t) for t in tags if _normalize_tag(t)}
        if not normalized:
            return []
        conn = self._connect()
        rows = conn.execute("SELECT * FROM pins ORDER BY created DESC").fetchall()
        conn.close()
        seen: set[str] = set()
        result: list[dict] = []
        for row in rows:
            pin_tags = set(json.loads(row["tags"]))
            if pin_tags & normalized and row["id"] not in seen:
                seen.add(row["id"])
                result.append(self._row_to_dict(row))
        return result

    # ------------------------------------------------------------------
    # Per-conversation active pin context
    # ------------------------------------------------------------------

    def get_active_pin_ids(self, conv_id: str) -> list[str]:
        conn = self._connect()
        row = conn.execute(
            "SELECT active_pin_ids FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        conn.close()
        if row is None or row["active_pin_ids"] is None:
            return []
        return json.loads(row["active_pin_ids"])

    def set_active_pin_ids(self, conv_id: str, ids: list[str]) -> None:
        conn = self._connect()
        now = _utcnow()
        conn.execute(
            "UPDATE conversations SET active_pin_ids = ?, updated_at = ? WHERE id = ?",
            (json.dumps(ids), now, conv_id),
        )
        conn.commit()
        conn.close()

    def add_active_pin_ids(self, conv_id: str, new_ids: list[str]) -> list[str]:
        existing = self.get_active_pin_ids(conv_id)
        existing_set = set(existing)
        for pid in new_ids:
            if pid not in existing_set:
                existing.append(pid)
                existing_set.add(pid)
        self.set_active_pin_ids(conv_id, existing)
        return existing

    def remove_active_pin_ids(self, conv_id: str, ids_to_remove: list[str]) -> list[str]:
        existing = self.get_active_pin_ids(conv_id)
        remove_set = set(ids_to_remove)
        updated = [pid for pid in existing if pid not in remove_set]
        self.set_active_pin_ids(conv_id, updated)
        return updated

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_dict(row) -> dict:
        d = dict(row)
        if isinstance(d.get("tags"), str):
            d["tags"] = json.loads(d["tags"])
        return d
