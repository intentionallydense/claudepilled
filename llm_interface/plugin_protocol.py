"""Plugin protocol and supporting types for the LLM Interface plugin system.

Defines WrapperPlugin (base class all plugins inherit from), PluginContext
(injected into plugins on load), ContextSource (for #tag injection), and
frontend manifest types. All plugin methods are optional except `name`.

Used by plugin_loader.py to discover and wire plugins, and by server.py
during startup.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class PluginContext:
    """Injected into plugins via on_load(). Provides access to core services.

    db_path: SQLite database file path (shared across all plugins).
    get_setting / set_setting: read/write from the settings table.
    service_registry: ServiceRegistry for inter-plugin communication.
    llm_client: ClaudeClient instance (may be None if no API key).
    """

    db_path: str
    get_setting: Callable[[str], str | None]
    set_setting: Callable[[str, str], None]
    service_registry: Any  # ServiceRegistry — avoid circular import
    llm_client: Any = None
    core_db: Any = None  # Database instance from core — for direct settings/prompt access


@dataclass
class ContextSource:
    """Allows a plugin to participate in #tag injection.

    Registered via plugin.context_sources(). The tag injection handler in
    server.py queries all registered sources when a user types #tag.
    """

    name: str  # e.g., "files", "pins"
    resolve_tags: Callable[[list[str]], list[dict]]
    get_active: Callable[[str], list[dict]]  # (conversation_id) -> items
    set_active: Callable[[str, list[str]], None]  # (conversation_id, ids)
    remove_active: Callable[[str, list[str]], None]  # (conversation_id, ids)
    format_block: Callable[[list[dict]], str]  # items -> XML string for system prompt


@dataclass
class NavEntry:
    """A navigation entry contributed by a plugin, rendered in the sidebar."""

    label: str
    href: str
    icon: str | None = None
    order: int = 50


@dataclass
class Column4Panel:
    """A panel that can be displayed in column 4 of the main layout.

    js_module points to a JS file exporting render(container) and destroy().
    The Column4Manager lazy-loads it on tab switch.
    """

    name: str
    label: str
    icon: str | None = None
    order: int = 50
    js_module: str = ""
    context: str = "always"  # "always", "chat", "backrooms"


@dataclass
class FrontendManifest:
    """Frontend assets and UI elements contributed by a plugin."""

    pages: list[dict] = field(default_factory=list)
    nav_entries: list[NavEntry] = field(default_factory=list)
    column4_panels: list[Column4Panel] = field(default_factory=list)


class WrapperPlugin:
    """Base class for LLM Interface plugins.

    All methods are optional except `name`. Override only what your plugin
    needs. The plugin loader calls methods in this order during startup:
        1. db_init(db_path) — create/migrate tables
        2. on_load(ctx) — receive PluginContext, store references
        3. register_services(registry) — expose services for other plugins
        4. routes() — return FastAPI router (mounted at route_prefix)
        5. register_tools(registry) — add tool definitions to shared registry
    """

    name: str = ""

    def on_load(self, ctx: PluginContext) -> None:
        """Receive PluginContext. Store references needed for operation."""

    def db_init(self, db_path: str) -> None:
        """Create or migrate database tables. Called before on_load."""

    def routes(self) -> Any | None:
        """Return a FastAPI APIRouter (no prefix — loader adds route_prefix)."""
        return None

    @property
    def route_prefix(self) -> str:
        """URL prefix for this plugin's routes. Default: /api/{name}."""
        return f"/api/{self.name}"

    def register_tools(self, registry: Any) -> None:
        """Register tool definitions on the shared ToolRegistry."""

    def tool_schema_refresher(self) -> Callable | None:
        """Return a callable that dynamically updates tool schemas."""
        return None

    def system_prompt_fragment(self, conv_meta: dict) -> str | None:
        """Return text to inject into the system prompt for a conversation."""
        return None

    def context_sources(self) -> list[ContextSource]:
        """Return ContextSource instances for #tag injection."""
        return []

    def cron_jobs(self) -> list[dict]:
        """Return cron job specs: [{name, fn, interval_seconds}]."""
        return []

    def cli_commands(self) -> dict[str, Callable]:
        """Return {command_name: callable} for CLI entry points."""
        return {}

    def frontend_manifest(self) -> FrontendManifest | None:
        """Return frontend manifest (pages, nav entries, column 4 panels)."""
        return None

    def provides(self) -> list[str]:
        """Service names this plugin registers in the service registry."""
        return []

    def consumes(self) -> list[str]:
        """Service names this plugin needs from other plugins."""
        return []

    def register_services(self, registry: Any) -> None:
        """Register named services for inter-plugin communication."""
