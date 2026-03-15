"""Email plugin — IMAP ingestion with LLM parsing to create tasks.

Provides email log CRUD, manual ingestion trigger, and CLI entry point.
Consumes task services from the tasks plugin.
"""

from llm_interface.plugin_protocol import PluginContext, WrapperPlugin


class EmailPlugin(WrapperPlugin):
    """Plugin for email ingestion."""

    name = "email"

    def __init__(self):
        self._db = None
        self._ctx = None

    def db_init(self, db_path: str) -> None:
        from .db import EmailDatabase
        self._db = EmailDatabase(db_path)

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx

    def routes(self):
        from .routes import init, router
        task_db = self._ctx.service_registry.get("task_db")
        init(self._db, task_db, self._ctx.core_db)
        return router

    @property
    def route_prefix(self) -> str:
        return "/api/emails"

    def register_services(self, registry) -> None:
        registry.register("email_db", self._db)

    def provides(self) -> list[str]:
        return ["email_db"]

    def consumes(self) -> list[str]:
        return ["task_db"]

    def cli_commands(self) -> dict:
        from .ingestion import cli_main
        return {"email": cli_main}


plugin = EmailPlugin()
