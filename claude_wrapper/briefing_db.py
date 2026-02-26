"""SQLite persistence for briefings, reading progress, and shown-post dedup.

Shares the same DB file as db.py. Used by all other briefing_* modules.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, date, timezone

from claude_wrapper.db import Database


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return date.today().isoformat()


class BriefingDatabase:
    """CRUD for briefing-related tables."""

    def __init__(self, db: Database):
        self.db_path = db.db_path
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

            CREATE TABLE IF NOT EXISTS reading_progress (
                series TEXT PRIMARY KEY,
                current_index INTEGER NOT NULL DEFAULT 0,
                list_path TEXT NOT NULL,
                last_advanced TEXT,
                paused INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS shown_posts (
                url TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                shown_date TEXT NOT NULL
            );
        """)
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Briefings
    # ------------------------------------------------------------------

    def save_briefing(self, date_str: str, sections: dict, assembled_text: str) -> dict:
        """Insert or replace a briefing for the given date."""
        now = _utcnow()
        conn = self._connect()
        conn.execute(
            """INSERT INTO briefings (date, sections, assembled_text, assembled_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                   sections = excluded.sections,
                   assembled_text = excluded.assembled_text,
                   assembled_at = excluded.assembled_at""",
            (date_str, json.dumps(sections), assembled_text, now),
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

    # ------------------------------------------------------------------
    # Reading progress
    # ------------------------------------------------------------------

    def get_all_progress(self) -> list[dict]:
        conn = self._connect()
        rows = conn.execute("SELECT * FROM reading_progress").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_progress(self, series: str) -> dict | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM reading_progress WHERE series = ?", (series,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def init_series(self, series: str, list_path: str) -> None:
        """INSERT OR IGNORE — idempotent, won't overwrite existing progress."""
        conn = self._connect()
        conn.execute(
            """INSERT OR IGNORE INTO reading_progress (series, current_index, list_path, paused)
               VALUES (?, 0, ?, 0)""",
            (series, list_path),
        )
        conn.commit()
        conn.close()

    def advance_pointer(self, series: str) -> dict | None:
        """Move to next item. Idempotent within a day — won't advance twice."""
        progress = self.get_progress(series)
        if progress is None:
            return None

        today = _today()
        if progress["last_advanced"] == today:
            return progress  # already advanced today

        new_index = progress["current_index"] + 1
        conn = self._connect()
        conn.execute(
            """UPDATE reading_progress
               SET current_index = ?, last_advanced = ?
               WHERE series = ?""",
            (new_index, today, series),
        )
        conn.commit()
        conn.close()
        return self.get_progress(series)

    def set_paused(self, series: str, paused: bool) -> dict | None:
        conn = self._connect()
        conn.execute(
            "UPDATE reading_progress SET paused = ? WHERE series = ?",
            (1 if paused else 0, series),
        )
        conn.commit()
        conn.close()
        return self.get_progress(series)

    def mark_unread(self, series: str) -> dict | None:
        """Rewind pointer by one so the same item re-appears tomorrow."""
        progress = self.get_progress(series)
        if progress is None:
            return None

        new_index = max(0, progress["current_index"] - 1)
        conn = self._connect()
        conn.execute(
            """UPDATE reading_progress
               SET current_index = ?
               WHERE series = ?""",
            (new_index, series),
        )
        conn.commit()
        conn.close()
        return self.get_progress(series)

    def skip_item(self, series: str) -> dict | None:
        """Advance pointer unconditionally (ignores daily idempotency)."""
        progress = self.get_progress(series)
        if progress is None:
            return None

        new_index = progress["current_index"] + 1
        conn = self._connect()
        conn.execute(
            """UPDATE reading_progress
               SET current_index = ?
               WHERE series = ?""",
            (new_index, series),
        )
        conn.commit()
        conn.close()
        return self.get_progress(series)

    # ------------------------------------------------------------------
    # Shown posts (RSS dedup)
    # ------------------------------------------------------------------

    def mark_shown(self, url: str, source: str) -> None:
        today = _today()
        conn = self._connect()
        conn.execute(
            "INSERT OR IGNORE INTO shown_posts (url, source, shown_date) VALUES (?, ?, ?)",
            (url, source, today),
        )
        conn.commit()
        conn.close()

    def was_shown(self, url: str) -> bool:
        conn = self._connect()
        row = conn.execute(
            "SELECT 1 FROM shown_posts WHERE url = ?", (url,)
        ).fetchone()
        conn.close()
        return row is not None
