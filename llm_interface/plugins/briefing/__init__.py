"""Briefing plugin — daily briefing assembly from RSS, reading lists, and calendar.

Provides briefing CRUD, reading progress tracking, Anki stats proxy,
assembly pipeline, and briefing chat conversations.
Consumes task services from the tasks plugin.
"""

from llm_interface.plugin_protocol import (
    FrontendManifest,
    NavEntry,
    PluginContext,
    WrapperPlugin,
)


class BriefingPlugin(WrapperPlugin):
    """Plugin for daily briefing assembly and delivery."""

    name = "briefing"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import BriefingDatabase
        self._db = BriefingDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx
        from .sequential import init_all_series
        init_all_series(self._db)

    def routes(self):
        from fastapi import APIRouter
        from .routes import init, router, progress_router, anki_router

        task_db = self._ctx.service_registry.get("task_db")
        init(self._db, task_db, self._ctx.llm_client, svc=self._ctx.service_registry)

        # Combine all three sub-routers into one router mounted at /api
        combined = APIRouter()
        combined.include_router(router, prefix="/briefing")
        combined.include_router(progress_router, prefix="/reading-progress")
        combined.include_router(anki_router, prefix="/anki")
        return combined

    @property
    def route_prefix(self) -> str:
        # Single combined router mounted at /api holds all three sub-routers
        return "/api"

    def register_services(self, registry) -> None:
        registry.register("briefing_db", self._db)

    def provides(self) -> list[str]:
        return ["briefing_db"]

    def consumes(self) -> list[str]:
        return ["task_db"]

    def cli_commands(self) -> dict:
        from .assembly import cli_main
        return {"briefing": cli_main}

    def frontend_manifest(self):
        return FrontendManifest(
            nav_entries=[NavEntry(label="Briefing", href="/briefing.html", order=40)],
        )


plugin = BriefingPlugin()
