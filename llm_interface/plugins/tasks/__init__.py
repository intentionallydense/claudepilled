"""Tasks plugin — urgency-scored task list with brain-dump workflow.

Provides task CRUD, LLM tools for task management, and REST API endpoints.
Other plugins can consume task services via the service registry:
    task_db, task_list, task_create, task_complete, task_list_projects, task_list_tags
"""

from llm_interface.plugin_protocol import (
    FrontendManifest,
    NavEntry,
    PluginContext,
    WrapperPlugin,
)


class TasksPlugin(WrapperPlugin):
    """Plugin for task management with urgency scoring."""

    name = "tasks"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import TaskDatabase

        self._db = TaskDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from .routes import init, router

        init(self._db)
        return router

    @property
    def route_prefix(self) -> str:
        return "/api/tasks"

    def register_tools(self, registry) -> None:
        from .tools import register_task_tools

        register_task_tools(registry, self._db)

    # tool_schema_refresher is registered inside register_task_tools via
    # registry.add_refresher(), so we don't need to return one here.

    def register_services(self, registry) -> None:
        from .tools import build_task_context

        registry.register("task_db", self._db)
        registry.register("task_list", self._db.list_tasks)
        registry.register("task_create", self._db.create)
        registry.register("task_complete", self._db.complete)
        registry.register("task_list_projects", self._db.list_projects)
        registry.register("task_list_tags", self._db.list_tags)
        registry.register("task_context", lambda: build_task_context(self._db))

    def provides(self) -> list[str]:
        return [
            "task_db",
            "task_list",
            "task_create",
            "task_complete",
            "task_list_projects",
            "task_list_tags",
            "task_context",
        ]

    def frontend_manifest(self):
        return FrontendManifest(
            nav_entries=[NavEntry(label="Tasks", href="/tasks.html", order=30)],
        )


plugin = TasksPlugin()
