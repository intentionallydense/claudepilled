"""Plugin discovery and loading.

Scans llm_interface/plugins/ for Python packages that export a `plugin`
attribute (a WrapperPlugin instance). Loads them in dependency order
based on provides()/consumes() declarations. Also starts background
cron jobs declared by plugins.

Called by server.py during startup.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from pathlib import Path
from typing import Any

from llm_interface.plugin_protocol import PluginContext, WrapperPlugin
from llm_interface.service_registry import ServiceRegistry

logger = logging.getLogger(__name__)

# Active cron tasks — kept alive for the process lifetime
_cron_tasks: list[asyncio.Task] = []

_PLUGINS_DIR = Path(__file__).resolve().parent / "plugins"


def discover_plugins() -> list[WrapperPlugin]:
    """Scan the plugins directory and return plugin instances."""
    plugins = []
    if not _PLUGINS_DIR.is_dir():
        return plugins

    for entry in sorted(_PLUGINS_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        init_file = entry / "__init__.py"
        if not init_file.exists():
            continue

        try:
            module = importlib.import_module(f"llm_interface.plugins.{entry.name}")
            plugin = getattr(module, "plugin", None)
            if plugin is None:
                logger.warning("Plugin %s has no 'plugin' attribute, skipping", entry.name)
                continue
            if not isinstance(plugin, WrapperPlugin):
                logger.warning("Plugin %s.plugin is not a WrapperPlugin, skipping", entry.name)
                continue
            plugins.append(plugin)
            logger.info("Discovered plugin: %s", plugin.name)
        except Exception:
            logger.exception("Failed to load plugin from %s", entry.name)

    return plugins


def _sort_by_dependencies(plugins: list[WrapperPlugin]) -> list[WrapperPlugin]:
    """Sort plugins so that providers come before consumers.

    Simple topological sort — plugins with no unmet deps load first.
    Falls back to discovery order for circular or unresolvable deps.
    """
    provided: dict[str, str] = {}  # service_name -> plugin_name
    for p in plugins:
        for svc in p.provides():
            provided[svc] = p.name

    sorted_plugins: list[WrapperPlugin] = []
    remaining = list(plugins)
    loaded_names: set[str] = set()

    max_iterations = len(remaining) + 1
    for _ in range(max_iterations):
        if not remaining:
            break
        next_remaining = []
        for p in remaining:
            # Only block on deps that ARE provided by another plugin
            unmet = [
                svc for svc in p.consumes()
                if svc in provided and provided[svc] not in loaded_names
            ]
            if not unmet:
                sorted_plugins.append(p)
                loaded_names.add(p.name)
            else:
                next_remaining.append(p)
        if len(next_remaining) == len(remaining):
            logger.warning(
                "Unresolvable plugin dependencies, loading remaining: %s",
                [p.name for p in next_remaining],
            )
            sorted_plugins.extend(next_remaining)
            break
        remaining = next_remaining

    return sorted_plugins


def load_plugins(
    db_path: str,
    get_setting: Any,
    set_setting: Any,
    service_registry: ServiceRegistry,
    llm_client: Any = None,
    core_db: Any = None,
    app: Any = None,
    tool_registry: Any = None,
) -> list[WrapperPlugin]:
    """Discover, initialize, and wire all plugins.

    Returns the list of loaded plugins in dependency order.
    """
    plugins = discover_plugins()
    plugins = _sort_by_dependencies(plugins)

    ctx = PluginContext(
        db_path=db_path,
        get_setting=get_setting,
        set_setting=set_setting,
        service_registry=service_registry,
        llm_client=llm_client,
        core_db=core_db,
    )

    for plugin in plugins:
        logger.info("Loading plugin: %s", plugin.name)

        # 1. Database init
        plugin.db_init(db_path)

        # 2. Plugin context
        plugin.on_load(ctx)

        # 3. Register services (before routes/tools so other plugins can consume)
        plugin.register_services(service_registry)

        # 4. Mount routes
        if app is not None:
            router = plugin.routes()
            if router is not None:
                app.include_router(router, prefix=plugin.route_prefix)

        # 5. Register tools
        if tool_registry is not None:
            plugin.register_tools(tool_registry)
            refresher = plugin.tool_schema_refresher()
            if refresher is not None:
                tool_registry.add_refresher(refresher)

    # 6. Start cron jobs from all plugins
    _start_cron_jobs(plugins)

    return plugins


def _start_cron_jobs(plugins: list[WrapperPlugin]) -> None:
    """Collect cron_jobs() from all plugins and start asyncio background tasks."""
    for plugin in plugins:
        for job in plugin.cron_jobs():
            name = job.get("name", f"{plugin.name}_cron")
            fn = job["fn"]
            interval = job["interval_seconds"]
            run_on_start = job.get("run_on_start", False)

            task = asyncio.create_task(
                _run_cron(name, fn, interval, run_on_start),
                name=f"cron:{name}",
            )
            _cron_tasks.append(task)
            logger.info("Started cron job: %s (every %ds)", name, interval)


async def _run_cron(name: str, fn, interval: int, run_on_start: bool) -> None:
    """Run a function on a fixed interval.

    Sync functions are run in the default thread executor to avoid blocking
    the event loop (important since cron jobs may do network I/O like LLM calls).
    """
    loop = asyncio.get_running_loop()

    async def _invoke():
        if asyncio.iscoroutinefunction(fn):
            await fn()
        else:
            await loop.run_in_executor(None, fn)

    if run_on_start:
        try:
            await _invoke()
        except Exception:
            logger.exception("Cron job %s failed on startup run", name)

    while True:
        await asyncio.sleep(interval)
        try:
            await _invoke()
        except Exception:
            logger.exception("Cron job %s failed", name)
