"""Files plugin — PDF and Markdown upload with tag-based context injection.

Provides file CRUD, tag-based querying, per-conversation active file context,
and REST API endpoints. Other plugins can consume file services via the registry:
    file_db
"""

from llm_interface.plugin_protocol import PluginContext, WrapperPlugin


class FilesPlugin(WrapperPlugin):
    """Plugin for file upload and tag-based injection."""

    name = "files"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import FileDatabase

        self._db = FileDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from .routes import init, router

        init(self._db)
        return router

    @property
    def route_prefix(self) -> str:
        return "/api/files"

    def register_services(self, registry) -> None:
        registry.register("file_db", self._db)

    def provides(self) -> list[str]:
        return ["file_db"]


plugin = FilesPlugin()
