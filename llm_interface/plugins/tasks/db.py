"""SQLite persistence layer for tasks.

Used by routes.py (API endpoints) and tools.py (LLM tool calls).
Shares the same database file as the core db.py but manages its own table.
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


class TaskDatabase:
    """CRUD operations for the tasks table."""

    def __init__(self, db_or_path):
        """Accept either a db_path string or a Database instance with .db_path."""
        if isinstance(db_or_path, str):
            self.db_path = db_or_path
        else:
            self.db_path = db_or_path.db_path
        self._init_table()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_table(self) -> None:
        conn = self._connect()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                priority TEXT,
                project TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                due TEXT,
                created TEXT NOT NULL,
                modified TEXT NOT NULL,
                completed_at TEXT,
                depends TEXT NOT NULL DEFAULT '[]',
                annotations TEXT NOT NULL DEFAULT '[]',
                recurrence TEXT,
                wait TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
            CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
        """)
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Create
    # ------------------------------------------------------------------

    def create(self, **kwargs: Any) -> dict:
        """Create a task. Returns the full task dict."""
        now = _utcnow()
        task = {
            "id": _new_id(),
            "title": kwargs.get("title", "Untitled"),
            "description": kwargs.get("description", ""),
            "status": "pending",
            "priority": kwargs.get("priority"),
            "project": kwargs.get("project"),
            "tags": json.dumps(kwargs.get("tags", [])),
            "due": kwargs.get("due"),
            "created": now,
            "modified": now,
            "completed_at": None,
            "depends": json.dumps(kwargs.get("depends", [])),
            "annotations": "[]",
            "recurrence": kwargs.get("recurrence"),
            "wait": kwargs.get("wait"),
        }
        conn = self._connect()
        conn.execute(
            """INSERT INTO tasks
               (id, title, description, status, priority, project, tags,
                due, created, modified, completed_at, depends, annotations,
                recurrence, wait)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            tuple(task.values()),
        )
        conn.commit()
        conn.close()
        return self._deserialize(task)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def get(self, task_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        if row is None:
            return None
        return self._deserialize(dict(row))

    def list_tasks(
        self,
        status: str | None = None,
        project: str | None = None,
        tag: str | None = None,
        include_waiting: bool = False,
    ) -> list[dict]:
        """List tasks with optional filters. Excludes deleted by default."""
        conn = self._connect()
        clauses = ["status != 'deleted'"]
        params: list[Any] = []

        if status:
            clauses.append("status = ?")
            params.append(status)
        if project:
            clauses.append("project = ?")
            params.append(project)

        where = " AND ".join(clauses)
        rows = conn.execute(
            f"SELECT * FROM tasks WHERE {where} ORDER BY created", params
        ).fetchall()
        conn.close()

        tasks = [dict(r) for r in rows]

        # Filter by tag if requested (tags stored as JSON array)
        if tag:
            tasks = [t for t in tasks if tag in json.loads(t["tags"])]

        # Filter out waiting tasks unless requested
        if not include_waiting:
            now = _utcnow()
            tasks = [
                t for t in tasks
                if not t["wait"] or t["wait"] <= now
            ]

        return tasks

    def list_projects(self) -> list[str]:
        """Return distinct non-null project names."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL AND status != 'deleted'"
        ).fetchall()
        conn.close()
        return [r["project"] for r in rows]

    def list_tags(self) -> list[str]:
        """Return distinct tags across all non-deleted tasks."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT tags FROM tasks WHERE status != 'deleted'"
        ).fetchall()
        conn.close()
        all_tags: set[str] = set()
        for row in rows:
            all_tags.update(json.loads(row["tags"]))
        return sorted(all_tags)

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def update(self, task_id: str, **kwargs: Any) -> dict | None:
        """Update specified fields on a task."""
        task = self.get(task_id)
        if task is None:
            return None

        # JSON-encode list fields if provided
        for field in ("tags", "depends"):
            if field in kwargs and isinstance(kwargs[field], list):
                kwargs[field] = json.dumps(kwargs[field])

        kwargs["modified"] = _utcnow()
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        values = list(kwargs.values()) + [task_id]

        conn = self._connect()
        conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", values)
        conn.commit()
        conn.close()
        return self.get(task_id)

    def complete(self, task_id: str) -> dict | None:
        """Mark a task as completed. Handles recurrence."""
        task = self.get(task_id)
        if task is None:
            return None

        now = _utcnow()
        conn = self._connect()
        conn.execute(
            "UPDATE tasks SET status = 'completed', completed_at = ?, modified = ? WHERE id = ?",
            (now, now, task_id),
        )
        conn.commit()
        conn.close()

        # Handle recurrence — create next instance
        if task["recurrence"] and task["due"]:
            self._create_recurrence(task)

        return self.get(task_id)

    def delete(self, task_id: str) -> bool:
        """Soft delete — sets status to 'deleted'."""
        conn = self._connect()
        now = _utcnow()
        conn.execute(
            "UPDATE tasks SET status = 'deleted', modified = ? WHERE id = ?",
            (now, task_id),
        )
        conn.commit()
        conn.close()
        return True

    def start(self, task_id: str) -> dict | None:
        return self.update(task_id, status="active")

    def stop(self, task_id: str) -> dict | None:
        return self.update(task_id, status="pending")

    # ------------------------------------------------------------------
    # Annotations
    # ------------------------------------------------------------------

    def annotate(self, task_id: str, text: str) -> dict | None:
        """Add a timestamped annotation to a task."""
        task = self.get(task_id)
        if task is None:
            return None

        annotations = task.get("annotations", [])
        if isinstance(annotations, str):
            annotations = json.loads(annotations)
        annotations.append({"timestamp": _utcnow(), "text": text})

        return self.update(task_id, annotations=json.dumps(annotations))

    def update_annotation(self, task_id: str, index: int, text: str) -> dict | None:
        """Update the text of an annotation by index."""
        task = self.get(task_id)
        if task is None:
            return None

        annotations = task.get("annotations", [])
        if isinstance(annotations, str):
            annotations = json.loads(annotations)
        if index < 0 or index >= len(annotations):
            return None

        annotations[index]["text"] = text
        return self.update(task_id, annotations=json.dumps(annotations))

    def delete_annotation(self, task_id: str, index: int) -> dict | None:
        """Delete an annotation by index."""
        task = self.get(task_id)
        if task is None:
            return None

        annotations = task.get("annotations", [])
        if isinstance(annotations, str):
            annotations = json.loads(annotations)
        if index < 0 or index >= len(annotations):
            return None

        annotations.pop(index)
        return self.update(task_id, annotations=json.dumps(annotations))

    # ------------------------------------------------------------------
    # Recurrence
    # ------------------------------------------------------------------

    def _create_recurrence(self, completed_task: dict) -> None:
        """Create the next instance of a recurring task."""
        from .urgency import parse_date

        rule = completed_task["recurrence"].lower().strip()
        due = parse_date(completed_task["due"])

        new_due = _next_recurrence_date(rule, due)
        if new_due is None:
            return
        # tags may already be a list (from _deserialize) or a JSON string
        tags = completed_task["tags"]
        if isinstance(tags, str):
            tags = json.loads(tags)
        self.create(
            title=completed_task["title"],
            description=completed_task["description"],
            priority=completed_task["priority"],
            project=completed_task["project"],
            tags=tags,
            due=new_due.isoformat(),
            recurrence=completed_task["recurrence"],
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deserialize(task: dict) -> dict:
        """Ensure JSON fields are deserialized for API responses."""
        for field in ("tags", "depends", "annotations"):
            if isinstance(task.get(field), str):
                task[field] = json.loads(task[field])
        return task


def _next_recurrence_date(rule: str, from_date):
    """Compute the next due date given a recurrence rule and a starting date.

    Supported rules:
    - "daily", "weekly", "biweekly", "monthly"
    - "every N days", "every N weeks", "every N months"
    - "weekdays:mon,wed,fri" -- next matching weekday after from_date
    """
    import re
    from datetime import timedelta

    rule = rule.lower().strip()

    # Simple aliases
    if rule == "daily":
        return from_date + timedelta(days=1)
    if rule == "weekly":
        return from_date + timedelta(weeks=1)
    if rule == "biweekly":
        return from_date + timedelta(weeks=2)
    if rule == "monthly":
        return _add_months(from_date, 1)

    # "every N days/weeks/months"
    m = re.match(r"every\s+(\d+)\s+(days?|weeks?|months?)", rule)
    if m:
        n = int(m.group(1))
        unit = m.group(2).rstrip("s")
        if unit == "day":
            return from_date + timedelta(days=n)
        if unit == "week":
            return from_date + timedelta(weeks=n)
        if unit == "month":
            return _add_months(from_date, n)

    # "weekdays:mon,tue,thu" -- find the next matching day of week
    m = re.match(r"weekdays:(.+)", rule)
    if m:
        day_names = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
        target_days = set()
        for d in m.group(1).split(","):
            d = d.strip()
            if d in day_names:
                target_days.add(day_names[d])
        if not target_days:
            return None
        # Search up to 7 days forward for the next matching weekday
        for offset in range(1, 8):
            candidate = from_date + timedelta(days=offset)
            if candidate.weekday() in target_days:
                return candidate

    return None


def _add_months(dt, months: int):
    """Add N months to a date, clamping to month end if needed."""
    import calendar
    month = dt.month - 1 + months
    year = dt.year + month // 12
    month = month % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)
