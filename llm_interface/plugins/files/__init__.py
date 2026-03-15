"""Files plugin — PDF and Markdown upload with tag-based context injection.

Provides file CRUD, tag-based querying, per-conversation active file context,
and REST API endpoints. Other plugins can consume file services via the registry:
    file_db
"""

from llm_interface.plugin_protocol import ContextSource, PluginContext, WrapperPlugin


def _format_files_block(files: list[dict]) -> str:
    """Format active files as XML for injection into the system prompt."""
    if not files:
        return ""
    files.sort(key=lambda f: f["filename"])
    parts = ["<injected_files>"]
    for f in files:
        tags_str = ", ".join(f["tags"]) if isinstance(f["tags"], list) else f["tags"]
        parts.append(f'<file name="{f["filename"]}" tags="{tags_str}" tokens="{f["token_count"]}">')
        parts.append(f["content"])
        parts.append("</file>")
    parts.append("</injected_files>")
    return "\n".join(parts)


def _file_preview(f: dict) -> dict:
    """Build a context bar preview dict for a file."""
    return {
        "id": f["id"],
        "filename": f["filename"],
        "tags": f["tags"],
        "token_count": f["token_count"],
    }


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

    def context_sources(self) -> list[ContextSource]:
        db = self._db

        def get_active(conv_id: str) -> list[dict]:
            items = []
            for fid in db.get_active_file_ids(conv_id):
                f = db.get_file(fid)
                if f:
                    items.append(f)
            return items

        return [ContextSource(
            name="files",
            resolve_tags=db.get_files_by_tags,
            get_active=get_active,
            set_active=db.add_active_file_ids,
            remove_active=db.remove_active_file_ids,
            format_block=_format_files_block,
            build_preview=_file_preview,
        )]


plugin = FilesPlugin()
