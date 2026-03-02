"""Claude tool definitions for task management.

Registers task CRUD operations as tools that Claude can call during
conversations. Also provides the brain-dump system prompt and a
context injection helper.

Used by server.py — call register_task_tools(registry, task_db) at startup.
"""

from __future__ import annotations

import json
from typing import Any

from claude_wrapper.task_db import TaskDatabase
from claude_wrapper.task_urgency import parse_date, sort_by_urgency
from claude_wrapper.tools import ToolRegistry


def _normalize_date(raw: str) -> str:
    """Validate and normalize a date string to ISO format.

    Accepts whatever parse_date handles (ISO, US format, Z suffix, etc.)
    and returns a clean ISO string that Python's fromisoformat can always parse.
    """
    return parse_date(raw).isoformat()


def _parse_tags(raw: str) -> list[str]:
    """Parse tags from comma-separated string or JSON array string.

    Claude sometimes passes tags as '["tag1", "tag2"]' instead of 'tag1, tag2'.
    This handles both formats so the stored value is always a clean list.
    """
    raw = raw.strip()
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(t).strip() for t in parsed if str(t).strip()]
        except json.JSONDecodeError:
            pass
    return [t.strip() for t in raw.split(",") if t.strip()]


BRAIN_DUMP_PROMPT = """\
The user wants to capture a task but may only have a vague idea. Your job is \
to interview them until you have enough detail to create a well-formed task \
their future self will understand.

Ask about:
- What specifically needs to happen? (get to an actionable title)
- Is there a deadline? (even a soft one)
- Does it depend on anything else being done first?
- What project or area of life does this belong to?
- Any context future-them will need?

Be conversational, not interrogative. 2-3 questions max per message. When you \
have enough, create the task using task_create and confirm what you've captured."""


def build_task_context(task_db: TaskDatabase) -> str:
    """Build a context string summarizing current tasks for Claude's system prompt."""
    tasks = task_db.list_tasks()
    if not tasks:
        return ""

    for t in tasks:
        for field in ("tags", "depends", "annotations"):
            if isinstance(t.get(field), str):
                t[field] = json.loads(t[field])

    sorted_tasks = sort_by_urgency(tasks)
    lines = ["<task_context>", "Current pending tasks sorted by urgency:", ""]

    for i, t in enumerate(sorted_tasks[:15], 1):
        parts = [f"{i}. [U:{t['urgency']}] {t['title']}"]
        if t.get("due"):
            parts.append(f"due:{t['due'][:10]}")
        if t.get("project"):
            parts.append(f"project:{t['project']}")
        if t.get("tags"):
            parts.append(" ".join(f"#{tag}" for tag in t["tags"]))
        lines.append(" — ".join(parts))
        if t.get("description"):
            lines.append(f"   {t['description'][:120]}")

    remaining = len(sorted_tasks) - 15
    if remaining > 0:
        lines.append(f"\n...and {remaining} more tasks.")

    lines.append("")
    lines.append("You can create, update, complete, and delete tasks using the task management tools.")
    lines.append("</task_context>")
    return "\n".join(lines)


def register_task_tools(registry: ToolRegistry, task_db: TaskDatabase) -> None:
    """Register all task management tools on the given registry."""

    @registry.tool(description="Create a new task with title and optional fields (description, priority, project, tags, due, depends, wait, recurrence).")
    def task_create(
        title: str,
        description: str = "",
        priority: str = "",
        project: str = "",
        tags: str = "",
        due: str = "",
        depends: str = "",
        wait: str = "",
        recurrence: str = "",
    ) -> str:
        kwargs: dict[str, Any] = {"title": title}
        if description:
            kwargs["description"] = description
        if priority and priority in ("H", "M", "L"):
            kwargs["priority"] = priority
        if project:
            kwargs["project"] = project
        if tags:
            kwargs["tags"] = _parse_tags(tags)
        if due:
            kwargs["due"] = _normalize_date(due)
        if depends:
            kwargs["depends"] = [d.strip() for d in depends.split(",") if d.strip()]
        if wait:
            kwargs["wait"] = _normalize_date(wait)
        if recurrence:
            kwargs["recurrence"] = recurrence
        task = task_db.create(**kwargs)
        return json.dumps(task, default=str)

    @registry.tool(description="Update fields on an existing task. Pass only the fields you want to change.")
    def task_update(
        id: str,
        title: str = "",
        description: str = "",
        priority: str = "",
        project: str = "",
        tags: str = "",
        due: str = "",
        depends: str = "",
        wait: str = "",
        recurrence: str = "",
        status: str = "",
    ) -> str:
        updates: dict[str, Any] = {}
        if title:
            updates["title"] = title
        if description:
            updates["description"] = description
        if priority:
            updates["priority"] = priority if priority in ("H", "M", "L") else None
        if project:
            updates["project"] = project
        if tags:
            updates["tags"] = _parse_tags(tags)
        if due:
            updates["due"] = _normalize_date(due)
        if depends:
            updates["depends"] = [d.strip() for d in depends.split(",") if d.strip()]
        if wait:
            updates["wait"] = _normalize_date(wait)
        if recurrence:
            updates["recurrence"] = recurrence
        if status and status in ("pending", "active"):
            updates["status"] = status
        task = task_db.update(id, **updates)
        if task is None:
            return json.dumps({"error": "Task not found"})
        return json.dumps(task, default=str)

    @registry.tool(description="Mark a task as completed by its ID.")
    def task_complete(id: str) -> str:
        task = task_db.complete(id)
        if task is None:
            return json.dumps({"error": "Task not found"})
        return json.dumps(task, default=str)

    @registry.tool(description="Soft-delete a task by its ID.")
    def task_delete(id: str) -> str:
        task_db.delete(id)
        return json.dumps({"ok": True})

    @registry.tool(description="Set a task's status to 'active' (started working on it).")
    def task_start(id: str) -> str:
        task = task_db.start(id)
        if task is None:
            return json.dumps({"error": "Task not found"})
        return json.dumps(task, default=str)

    @registry.tool(description="Set a task's status back to 'pending' (stop working on it).")
    def task_stop(id: str) -> str:
        task = task_db.stop(id)
        if task is None:
            return json.dumps({"error": "Task not found"})
        return json.dumps(task, default=str)

    @registry.tool(description="Add a timestamped note/annotation to a task.")
    def task_annotate(id: str, text: str) -> str:
        task = task_db.annotate(id, text)
        if task is None:
            return json.dumps({"error": "Task not found"})
        return json.dumps(task, default=str)

    @registry.tool(description="List current tasks sorted by urgency. Optional filter by status, project, or tag.")
    def task_list(filter: str = "", sort: str = "urgency", limit: str = "20") -> str:
        kwargs: dict[str, Any] = {}
        if filter:
            # Simple filter parsing: "project:foo", "tag:bar", "status:active"
            for part in filter.split():
                if ":" in part:
                    key, val = part.split(":", 1)
                    if key in ("project", "tag", "status"):
                        kwargs[key] = val
        tasks = task_db.list_tasks(**kwargs)
        for t in tasks:
            for field in ("tags", "depends", "annotations"):
                if isinstance(t.get(field), str):
                    t[field] = json.loads(t[field])
        sorted_tasks = sort_by_urgency(tasks)
        n = min(int(limit), len(sorted_tasks))
        return json.dumps(sorted_tasks[:n], default=str)

    # ------------------------------------------------------------------
    # Schema refresher — injects current projects/tags into tool descriptions
    # so the LLM sees them in the schema without an extra round-trip.
    # ------------------------------------------------------------------

    def _refresh_task_schemas() -> None:
        projects = task_db.list_projects()
        tags = task_db.list_tags()

        proj_desc = "Project name."
        if projects:
            proj_desc = f"Existing projects: {', '.join(projects)}. You can also create a new one."

        tags_desc = "Comma-separated tags."
        if tags:
            tags_desc = f"Comma-separated tags. Existing tags: {', '.join(tags)}. You can also create new ones."

        for tool_name in ("task_create", "task_update"):
            tool = registry._tools.get(tool_name)
            if not tool:
                continue
            props = tool.input_schema.get("properties", {})
            if "project" in props:
                props["project"]["description"] = proj_desc
            if "tags" in props:
                props["tags"]["description"] = tags_desc

        # Also enrich task_list filter description
        task_list_tool = registry._tools.get("task_list")
        if task_list_tool:
            props = task_list_tool.input_schema.get("properties", {})
            if "filter" in props:
                filter_parts = ['Filters like "project:X", "tag:Y", "status:active".']
                if projects:
                    filter_parts.append(f"Projects: {', '.join(projects)}.")
                if tags:
                    filter_parts.append(f"Tags: {', '.join(tags)}.")
                props["filter"]["description"] = " ".join(filter_parts)

    registry.add_refresher(_refresh_task_schemas)
