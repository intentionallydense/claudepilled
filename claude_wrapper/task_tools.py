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
from claude_wrapper.task_urgency import sort_by_urgency
from claude_wrapper.tools import ToolRegistry


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
            kwargs["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
        if due:
            kwargs["due"] = due
        if depends:
            kwargs["depends"] = [d.strip() for d in depends.split(",") if d.strip()]
        if wait:
            kwargs["wait"] = wait
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
            updates["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
        if due:
            updates["due"] = due
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
