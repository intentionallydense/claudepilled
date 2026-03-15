"""Calendar plugin — Google Calendar integration with OAuth2, caching, and LLM tools.

Provides event caching, OAuth2 flow, event CRUD, and LLM tools for calendar queries.
"""

from llm_interface.plugin_protocol import (
    FrontendManifest,
    NavEntry,
    PluginContext,
    WrapperPlugin,
)


class CalendarPlugin(WrapperPlugin):
    """Plugin for Google Calendar integration."""

    name = "calendar"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import CalendarDatabase
        self._db = CalendarDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from .routes import init, router
        init(self._db, self._ctx.core_db)
        return router

    @property
    def route_prefix(self) -> str:
        return "/api/calendar"

    def register_tools(self, registry) -> None:
        from .tools import register_calendar_tools
        register_calendar_tools(registry, self._db, self._ctx.core_db)

    def register_services(self, registry) -> None:
        registry.register("calendar_db", self._db)

    def provides(self) -> list[str]:
        return ["calendar_db"]


plugin = CalendarPlugin()
