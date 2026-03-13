"""SQLite cache layer for Google Calendar events.

Caches events fetched from the Google Calendar API to avoid hitting
the API on every render. Events are keyed by Google event ID and
deduped on upsert. The cache is refreshed periodically by calendar_routes.

Used by calendar_routes.py (API endpoints) and calendar_tools.py (Claude tools).
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


class CalendarDatabase:
    """CRUD for cached calendar events + OAuth token storage."""

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
            CREATE TABLE IF NOT EXISTS calendar_events (
                id TEXT PRIMARY KEY,
                google_event_id TEXT NOT NULL,
                calendar_id TEXT NOT NULL DEFAULT 'primary',
                summary TEXT NOT NULL DEFAULT '',
                description TEXT,
                location TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                all_day INTEGER NOT NULL DEFAULT 0,
                calendar_name TEXT,
                color TEXT,
                status TEXT NOT NULL DEFAULT 'confirmed',
                cached_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cal_events_start
                ON calendar_events(start_time);
            CREATE INDEX IF NOT EXISTS idx_cal_events_google_id
                ON calendar_events(google_event_id);
        """)
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Upsert events from Google API
    # ------------------------------------------------------------------

    def upsert_events(self, events: list[dict]) -> int:
        """Insert or update events from the Google Calendar API.

        Each event dict should have: google_event_id, summary, start_time,
        end_time, and optionally: description, location, all_day,
        calendar_id, calendar_name, color, status.

        Returns the number of events upserted.
        """
        if not events:
            return 0

        conn = self._connect()
        now = _utcnow()
        count = 0
        for ev in events:
            google_id = ev["google_event_id"]
            # Check if exists
            existing = conn.execute(
                "SELECT id FROM calendar_events WHERE google_event_id = ? AND calendar_id = ?",
                (google_id, ev.get("calendar_id", "primary")),
            ).fetchone()

            row_id = existing["id"] if existing else uuid.uuid4().hex[:12]
            conn.execute(
                """INSERT OR REPLACE INTO calendar_events
                   (id, google_event_id, calendar_id, summary, description,
                    location, start_time, end_time, all_day, calendar_name,
                    color, status, cached_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    row_id,
                    google_id,
                    ev.get("calendar_id", "primary"),
                    ev.get("summary", "(No title)"),
                    ev.get("description"),
                    ev.get("location"),
                    ev["start_time"],
                    ev["end_time"],
                    1 if ev.get("all_day") else 0,
                    ev.get("calendar_name"),
                    ev.get("color"),
                    ev.get("status", "confirmed"),
                    now,
                ),
            )
            count += 1

        conn.commit()
        conn.close()
        return count

    # ------------------------------------------------------------------
    # Query cached events
    # ------------------------------------------------------------------

    def get_events(
        self,
        start: str,
        end: str,
        calendar_id: str | None = None,
    ) -> list[dict]:
        """Return cached events in a time range, sorted by start_time.

        start/end are ISO datetime strings.
        """
        conn = self._connect()
        if calendar_id:
            rows = conn.execute(
                """SELECT * FROM calendar_events
                   WHERE start_time < ? AND end_time > ? AND calendar_id = ?
                         AND status != 'cancelled'
                   ORDER BY start_time""",
                (end, start, calendar_id),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT * FROM calendar_events
                   WHERE start_time < ? AND end_time > ?
                         AND status != 'cancelled'
                   ORDER BY start_time""",
                (end, start),
            ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def clear_range(self, start: str, end: str) -> None:
        """Delete cached events in a range before re-fetching."""
        conn = self._connect()
        conn.execute(
            "DELETE FROM calendar_events WHERE start_time < ? AND end_time > ?",
            (end, start),
        )
        conn.commit()
        conn.close()

    def delete_event(self, google_event_id: str) -> None:
        """Remove a single event from the cache by its Google event ID."""
        conn = self._connect()
        conn.execute(
            "DELETE FROM calendar_events WHERE google_event_id = ?",
            (google_event_id,),
        )
        conn.commit()
        conn.close()

    def clear_all(self) -> None:
        """Wipe the entire event cache."""
        conn = self._connect()
        conn.execute("DELETE FROM calendar_events")
        conn.commit()
        conn.close()
