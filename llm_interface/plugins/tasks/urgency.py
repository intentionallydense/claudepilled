"""Urgency scoring for tasks.

Computes a dynamic urgency score at render time (not stored).
Used by task_routes.py to sort the task list and by task_tools.py
to generate context summaries for Claude.

Coefficients are intentionally simple — tweak the DEFAULT_COEFFICIENTS
dict to adjust behavior.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone


def parse_date(date_str: str) -> datetime:
    """Parse a date string into a timezone-aware datetime.

    Handles multiple formats:
    - ISO 8601 with Z suffix: "2026-03-03T08:00:00.000Z"
    - ISO 8601 with offset: "2026-03-03T08:00:00+00:00"
    - ISO date only: "2026-03-03"
    - ISO datetime no tz: "2026-03-03T08:00:00"
    - US format: "3/3/2026"

    Always returns a UTC-aware datetime.
    """
    s = date_str.strip()

    # Replace Z with +00:00 for fromisoformat compatibility (Python < 3.11)
    s = re.sub(r"Z$", "+00:00", s)

    # Try US date format (M/D/YYYY)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return datetime(year, month, day, tzinfo=timezone.utc)

    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt

# Days before due date when urgency starts ramping
DUE_RAMP_DAYS = 14
# Max urgency score for a due task (before overdue bonus)
DUE_MAX = 12
# Overdue cap (max additional points beyond DUE_MAX)
DUE_OVERDUE_CAP = 20

DEFAULT_COEFFICIENTS = {
    "priority_H": 6.0,
    "priority_M": 3.0,
    "priority_L": 1.0,
    "active_boost": 4.0,
    "blocked_penalty": -5.0,
    "waiting_penalty": -10.0,
    "age_max": 2.0,
    "age_days": 60.0,  # days to reach max age score
}


def compute_urgency(task: dict, all_tasks: dict[str, dict] | None = None,
                    coefficients: dict | None = None) -> float:
    """Compute urgency score for a single task.

    Args:
        task: A task dict from the database.
        all_tasks: Map of task_id → task dict, used for dependency checking.
                   If None, blocked penalty is skipped.
        coefficients: Override default coefficients.
    """
    coeff = {**DEFAULT_COEFFICIENTS, **(coefficients or {})}
    now = datetime.now(timezone.utc)
    score = 0.0

    # Priority
    priority = task.get("priority")
    if priority:
        score += coeff.get(f"priority_{priority}", 0.0)

    # Due date urgency
    due_str = task.get("due")
    if due_str:
        score += _due_score(due_str, now)

    # Age — older pending tasks slowly rise
    created_str = task.get("created")
    if created_str:
        created = parse_date(created_str)
        age_days = (now - created).total_seconds() / 86400
        score += min(coeff["age_max"], age_days / coeff["age_days"] * coeff["age_max"])

    # Active boost
    if task.get("status") == "active":
        score += coeff["active_boost"]

    # Blocked penalty
    if all_tasks:
        depends_raw = task.get("depends", "[]")
        depends = json.loads(depends_raw) if isinstance(depends_raw, str) else depends_raw
        if depends:
            incomplete = any(
                all_tasks.get(dep_id, {}).get("status") not in ("completed", "deleted")
                for dep_id in depends
            )
            if incomplete:
                score += coeff["blocked_penalty"]

    # Waiting penalty
    wait_str = task.get("wait")
    if wait_str:
        wait = parse_date(wait_str)
        if wait > now:
            score += coeff["waiting_penalty"]

    return round(score, 1)


def _due_score(due_str: str, now: datetime) -> float:
    """Score based on proximity to due date."""
    due = parse_date(due_str)

    days_until = (due - now).total_seconds() / 86400

    if days_until < 0:
        # Overdue: max score + 1 per day overdue, capped
        overdue_days = abs(days_until)
        return min(DUE_MAX + overdue_days, DUE_OVERDUE_CAP)

    if days_until > DUE_RAMP_DAYS:
        return 0.0

    # Linear ramp from 0 to DUE_MAX over DUE_RAMP_DAYS
    return DUE_MAX * (1 - days_until / DUE_RAMP_DAYS)


def sort_by_urgency(tasks: list[dict]) -> list[dict]:
    """Sort tasks by urgency score descending. Mutates and returns the list."""
    task_map = {t["id"]: t for t in tasks}
    for task in tasks:
        task["urgency"] = compute_urgency(task, task_map)
    tasks.sort(key=lambda t: t["urgency"], reverse=True)
    return tasks
