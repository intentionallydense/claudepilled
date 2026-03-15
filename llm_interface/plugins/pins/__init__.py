"""Pins plugin — moodboard with text, links, images, and pinned chat messages.

Provides pin CRUD, tag-based context injection, LLM tools for pinning content,
and REST API endpoints. Other plugins can consume pin services via the registry:
    pin_db, pin_create
"""

from llm_interface.plugin_protocol import (
    FrontendManifest,
    PluginContext,
    WrapperPlugin,
)


class PinsPlugin(WrapperPlugin):
    """Plugin for moodboard pin management."""

    name = "pins"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import PinDatabase

        self._db = PinDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from .routes import init, router

        init(self._db)
        return router

    @property
    def route_prefix(self) -> str:
        return "/api/pins"

    def register_tools(self, registry) -> None:
        from .tools import register_pin_tools

        register_pin_tools(registry, self._db)

    def register_services(self, registry) -> None:
        registry.register("pin_db", self._db)
        registry.register("pin_create", self._db.create)

    def provides(self) -> list[str]:
        return ["pin_db", "pin_create"]


plugin = PinsPlugin()
