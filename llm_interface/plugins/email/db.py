"""CRUD for the email_log table — tracks ingested emails and their actions.

Follows the same pattern as tasks plugin db.py: accepts a db_path string or
a Database instance, manages its own _connect(). JSON fields stored as strings,
_deserialize() helper for API responses.

Used by: ingestion.py (CLI), routes.py (REST API), __init__.py (plugin loader)
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


class EmailDatabase:
    """CRUD for ingested email log entries."""

    def __init__(self, db_or_path):
        """Accept either a db_path string or an object with .db_path attribute.

        When given a string, implements its own _connect method.
        When given a Database instance, delegates to db._connect.
        """
        if isinstance(db_or_path, str):
            self.db_path = db_or_path
        else:
            self.db_path = db_or_path.db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def create(self, **kwargs: Any) -> dict:
        """Create an email log entry. Returns the full dict."""
        now = _utcnow()
        entry = {
            "id": _new_id(),
            "message_id": kwargs.get("message_id"),
            "sender": kwargs.get("sender", ""),
            "subject": kwargs.get("subject", ""),
            "body_preview": kwargs.get("body_preview", ""),
            "received_at": kwargs.get("received_at", now),
            "processed_at": now,
            "actions": json.dumps(kwargs.get("actions", [])),
            "model_used": kwargs.get("model_used"),
            "parse_result": kwargs.get("parse_result"),
            "classification": kwargs.get("classification"),
            "archived": 0,
        }
        conn = self._connect()
        conn.execute(
            """INSERT INTO email_log
               (id, message_id, sender, subject, body_preview, received_at,
                processed_at, actions, model_used, parse_result, classification, archived)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                entry["id"], entry["message_id"], entry["sender"],
                entry["subject"], entry["body_preview"], entry["received_at"],
                entry["processed_at"], entry["actions"], entry["model_used"],
                entry["parse_result"], entry["classification"], entry["archived"],
            ),
        )
        conn.commit()
        conn.close()
        entry["actions"] = kwargs.get("actions", [])
        return entry

    def get(self, entry_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM email_log WHERE id = ?", (entry_id,)
        ).fetchone()
        conn.close()
        if row is None:
            return None
        return self._deserialize(dict(row))

    def get_by_message_id(self, message_id: str) -> dict | None:
        """Look up by IMAP Message-ID for deduplication."""
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM email_log WHERE message_id = ?", (message_id,)
        ).fetchone()
        conn.close()
        if row is None:
            return None
        return self._deserialize(dict(row))

    def list_recent(
        self, limit: int = 20, include_archived: bool = False
    ) -> list[dict]:
        """Return recent entries, newest first."""
        conn = self._connect()
        if include_archived:
            rows = conn.execute(
                "SELECT * FROM email_log ORDER BY processed_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM email_log WHERE archived = 0 ORDER BY processed_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        conn.close()
        return [self._deserialize(dict(r)) for r in rows]

    def archive(self, entry_id: str) -> dict | None:
        """Mark an entry as archived."""
        conn = self._connect()
        conn.execute(
            "UPDATE email_log SET archived = 1 WHERE id = ?", (entry_id,)
        )
        conn.commit()
        conn.close()
        return self.get(entry_id)

    @staticmethod
    def _deserialize(entry: dict) -> dict:
        """Ensure JSON fields are parsed for API responses."""
        if isinstance(entry.get("actions"), str):
            entry["actions"] = json.loads(entry["actions"])
        return entry
