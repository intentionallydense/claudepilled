"""Pins plugin — moodboard with text, links, images, and pinned chat messages.

Provides pin CRUD, tag-based context injection, LLM tools for pinning content,
and REST API endpoints. Other plugins can consume pin services via the registry:
    pin_db, pin_create
"""

from llm_interface.plugin_protocol import (
    Column4Panel,
    ContextSource,
    FrontendManifest,
    PluginContext,
    WrapperPlugin,
)


def _format_pins_block(pins: list[dict]) -> str:
    """Format active pins as XML for injection into the system prompt.

    Image pins are excluded upstream (in get_active) — data URIs are too large.
    """
    if not pins:
        return ""
    parts = ["<injected_pins>"]
    for p in pins:
        tags_str = ", ".join(p["tags"]) if isinstance(p["tags"], list) else str(p["tags"])
        parts.append(f'<pin type="{p["type"]}" tags="{tags_str}">')
        parts.append(p["content"])
        parts.append("</pin>")
    parts.append("</injected_pins>")
    return "\n".join(parts)


def _pin_preview(p: dict) -> dict:
    """Build a context bar preview dict for a pin."""
    pin_tokens = len(p["content"]) // 4
    return {
        "id": p["id"],
        "type": p["type"],
        "content": p["content"][:100],
        "tags": p["tags"],
        "token_count": pin_tokens,
    }


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

    def frontend_manifest(self):
        return FrontendManifest(
            column4_panels=[Column4Panel(
                name="moodboard",
                label="board",
                order=10,
                js_module="/plugins/moodboard/panel.js",
                context="always",
            )],
        )

    def context_sources(self) -> list[ContextSource]:
        db = self._db

        def get_active(conv_id: str) -> list[dict]:
            items = []
            for pid in db.get_active_pin_ids(conv_id):
                p = db.get(pid)
                # Skip image pins — data URIs too large for system prompt
                if p and p["type"] != "image":
                    items.append(p)
            return items

        return [ContextSource(
            name="pins",
            resolve_tags=db.get_pins_by_tags,
            get_active=get_active,
            set_active=db.add_active_pin_ids,
            remove_active=db.remove_active_pin_ids,
            format_block=_format_pins_block,
            build_preview=_pin_preview,
        )]


plugin = PinsPlugin()
