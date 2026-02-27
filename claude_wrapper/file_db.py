"""SQLite persistence layer for uploaded files and tag-based injection.

Shares the same database file as db.py (via Database.db_path).
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone

from claude_wrapper.db import Database


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _normalize_tag(tag: str) -> str:
    return re.sub(r"[^a-z0-9-]", "", tag.lower().strip())


class FileDatabase:
    """CRUD operations for the files table and per-conversation active context."""

    def __init__(self, db: Database):
        self.db_path = db.db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    # ------------------------------------------------------------------
    # File CRUD
    # ------------------------------------------------------------------

    def save_file(self, filename: str, tags: list[str], content: str) -> dict:
        file_id = _new_id()
        normalized_tags = [_normalize_tag(t) for t in tags if _normalize_tag(t)]
        token_count = len(content) // 4
        now = _utcnow()
        conn = self._connect()
        conn.execute(
            """INSERT INTO files (id, filename, tags, content, token_count, uploaded_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (file_id, filename, json.dumps(normalized_tags), content, token_count, now),
        )
        conn.commit()
        conn.close()
        return {
            "id": file_id,
            "filename": filename,
            "tags": normalized_tags,
            "content": content,
            "token_count": token_count,
            "uploaded_at": now,
        }

    def get_file(self, file_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        conn.close()
        if row is None:
            return None
        return self._row_to_dict(row)

    def list_files(self) -> list[dict]:
        conn = self._connect()
        rows = conn.execute(
            "SELECT id, filename, tags, token_count, uploaded_at FROM files ORDER BY uploaded_at DESC"
        ).fetchall()
        conn.close()
        result = []
        for row in rows:
            d = dict(row)
            d["tags"] = json.loads(d["tags"])
            result.append(d)
        return result

    def delete_file(self, file_id: str) -> bool:
        conn = self._connect()
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.commit()
        conn.close()
        return True

    def update_tags(self, file_id: str, tags: list[str]) -> dict | None:
        normalized = [_normalize_tag(t) for t in tags if _normalize_tag(t)]
        conn = self._connect()
        conn.execute(
            "UPDATE files SET tags = ? WHERE id = ?",
            (json.dumps(normalized), file_id),
        )
        conn.commit()
        conn.close()
        return self.get_file(file_id)

    # ------------------------------------------------------------------
    # Tag queries
    # ------------------------------------------------------------------

    def list_all_tags(self) -> list[str]:
        conn = self._connect()
        rows = conn.execute("SELECT tags FROM files").fetchall()
        conn.close()
        all_tags: set[str] = set()
        for row in rows:
            all_tags.update(json.loads(row["tags"]))
        return sorted(all_tags)

    def get_files_by_tags(self, tags: list[str]) -> list[dict]:
        """Return files matching ANY of the given tags (union, deduplicated)."""
        normalized = {_normalize_tag(t) for t in tags if _normalize_tag(t)}
        if not normalized:
            return []
        conn = self._connect()
        rows = conn.execute("SELECT * FROM files ORDER BY filename").fetchall()
        conn.close()
        seen = set()
        result = []
        for row in rows:
            file_tags = set(json.loads(row["tags"]))
            if file_tags & normalized and row["id"] not in seen:
                seen.add(row["id"])
                result.append(self._row_to_dict(row))
        return result

    # ------------------------------------------------------------------
    # Per-conversation active file context
    # ------------------------------------------------------------------

    def get_active_file_ids(self, conv_id: str) -> list[str]:
        conn = self._connect()
        row = conn.execute(
            "SELECT active_file_ids FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
        conn.close()
        if row is None or row["active_file_ids"] is None:
            return []
        return json.loads(row["active_file_ids"])

    def set_active_file_ids(self, conv_id: str, ids: list[str]) -> None:
        conn = self._connect()
        now = _utcnow()
        conn.execute(
            "UPDATE conversations SET active_file_ids = ?, updated_at = ? WHERE id = ?",
            (json.dumps(ids), now, conv_id),
        )
        conn.commit()
        conn.close()

    def add_active_file_ids(self, conv_id: str, new_ids: list[str]) -> list[str]:
        existing = self.get_active_file_ids(conv_id)
        existing_set = set(existing)
        for fid in new_ids:
            if fid not in existing_set:
                existing.append(fid)
                existing_set.add(fid)
        self.set_active_file_ids(conv_id, existing)
        return existing

    def remove_active_file_ids(self, conv_id: str, ids_to_remove: list[str]) -> list[str]:
        existing = self.get_active_file_ids(conv_id)
        remove_set = set(ids_to_remove)
        updated = [fid for fid in existing if fid not in remove_set]
        self.set_active_file_ids(conv_id, updated)
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
