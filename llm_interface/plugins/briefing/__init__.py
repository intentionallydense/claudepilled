"""Briefing plugin — reads daily briefings from the standalone briefing project.

The standalone project (github.com/anthropics/briefing) handles feed
fetching, reading list management, and LLM assembly. This plugin reads
the resulting .md files and serves them via the web UI, with a chat
interface and reading progress proxy.
"""

from llm_interface.plugin_protocol import (
    FrontendManifest,
    NavEntry,
    PluginContext,
    WrapperPlugin,
)


class BriefingPlugin(WrapperPlugin):
    """Plugin for daily briefing delivery and chat."""

    name = "briefing"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import BriefingDatabase
        self._db = BriefingDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from fastapi import APIRouter
        from .routes import init, router, progress_router, anki_router

        init(self._db, svc=self._ctx.service_registry, get_setting=self._ctx.get_setting)

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
        return []

    def cron_jobs(self) -> list[dict]:
        from .assembly import assemble_briefing

        def _daily_assemble():
            """Assemble today's briefing if not already done."""
            if self._db is not None:
                assemble_briefing(self._db, force=False)

        return [{
            "name": "briefing_assemble",
            "fn": _daily_assemble,
            # Check every 30 minutes; idempotent so it only assembles once per day
            "interval_seconds": 30 * 60,
            "run_on_start": True,
        }]

    def cli_commands(self) -> dict:
        from .assembly import cli_main
        return {"briefing": cli_main}

    def frontend_manifest(self):
        return FrontendManifest(
            nav_entries=[NavEntry(label="Briefing", href="/briefing.html", order=40)],
        )


plugin = BriefingPlugin()
