"""SQLite persistence for briefings.

Shares the same DB file as the core database. Reading progress and feed
dedup are handled by the standalone briefing project (~/.briefing/state.db),
not here.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class BriefingDatabase:
    """CRUD for the briefings table."""

    def __init__(self, db_or_path):
        """Accept either a db_path string or a Database instance with .db_path."""
        if isinstance(db_or_path, str):
            self.db_path = db_or_path
        else:
            self.db_path = db_or_path.db_path
        self._init_tables()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_tables(self) -> None:
        conn = self._connect()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS briefings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL UNIQUE,
                sections TEXT NOT NULL DEFAULT '{}',
                assembled_text TEXT NOT NULL DEFAULT '',
                assembled_at TEXT NOT NULL
            );
        """)
        # Idempotent migration: add chat_conversation_id column
        try:
            conn.execute("ALTER TABLE briefings ADD COLUMN chat_conversation_id TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        # Track which model generated the briefing
        try:
            conn.execute("ALTER TABLE briefings ADD COLUMN model TEXT")
        except sqlite3.OperationalError:
            pass
        conn.commit()
        conn.close()

    def save_briefing(self, date_str: str, sections: dict, assembled_text: str, model: str | None = None) -> dict:
        """Insert or replace a briefing for the given date."""
        now = _utcnow()
        conn = self._connect()
        conn.execute(
            """INSERT INTO briefings (date, sections, assembled_text, assembled_at, model)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                   sections = excluded.sections,
                   assembled_text = excluded.assembled_text,
                   assembled_at = excluded.assembled_at, model = excluded.model""",
            (date_str, json.dumps(sections), assembled_text, now, model),
        )
        conn.commit()
        conn.close()
        return self.get_briefing_by_date(date_str)

    def get_briefing_by_date(self, date_str: str) -> dict | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM briefings WHERE date = ?", (date_str,)
        ).fetchone()
        conn.close()
        if row is None:
            return None
        result = dict(row)
        result["sections"] = json.loads(result["sections"])
        return result

    def list_briefings(self) -> list[dict]:
        """Return all briefing dates, sorted newest-first."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT date, chat_conversation_id FROM briefings ORDER BY date DESC"
        ).fetchall()
        conn.close()
        return [
            {"date": r["date"], "has_chat": bool(r["chat_conversation_id"])}
            for r in rows
        ]

    def set_chat_conversation_id(self, date_str: str, conversation_id: str) -> None:
        """Link a chat conversation to a briefing date."""
        conn = self._connect()
        conn.execute(
            "UPDATE briefings SET chat_conversation_id = ? WHERE date = ?",
            (conversation_id, date_str),
        )
        conn.commit()
        conn.close()
