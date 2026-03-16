"""Memory plugin — Graphiti knowledge graph search and forget as LLM tools.

Registers `memory_search` and `memory_forget` tools that let models query
and remove entries from the user's personal knowledge graph built from
past conversations.

Requires Neo4j running and graphiti_memory configured.
Gracefully degrades if Neo4j is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

from llm_interface.plugin_protocol import PluginContext, WrapperPlugin
from llm_interface.tools import ToolRegistry

log = logging.getLogger(__name__)

# Add graphiti_memory to sys.path so we can import from it
_GRAPHITI_DIR = Path(__file__).resolve().parent.parent.parent.parent / "graphiti_memory"
if str(_GRAPHITI_DIR) not in sys.path:
    sys.path.insert(0, str(_GRAPHITI_DIR))


class MemoryPlugin(WrapperPlugin):
    """Plugin that exposes Graphiti knowledge graph search as an LLM tool."""

    name = "memory"

    def __init__(self):
        self._ctx = None
        self._available = False

    def on_load(self, ctx: PluginContext) -> None:
        self._ctx = ctx
        # Check if graphiti_memory is importable and configured
        try:
            from src.graph import load_config
            config = load_config(str(_GRAPHITI_DIR / "config.yaml"))
            # Don't actually connect to Neo4j at startup — just check config exists
            self._available = bool(config.get("neo4j_password") or config.get("neo4j_uri"))
            if self._available:
                log.info("Memory plugin: Graphiti config found, tool will be registered")
            else:
                log.info("Memory plugin: No Neo4j config, skipping tool registration")
        except Exception as exc:
            log.info("Memory plugin: graphiti_memory not available (%s)", exc)
            self._available = False

    def register_tools(self, registry: ToolRegistry) -> None:
        if not self._available:
            return

        @registry.tool(
            description=(
                "Search the user's personal knowledge graph for relevant memories "
                "from past conversations. Use this when the user references something "
                "you discussed before, asks you to remember something, or when context "
                "from past conversations would help. Returns temporally-aware context "
                "with dates. Don't use this for general knowledge — only for personal "
                "history and past conversations."
            )
        )
        async def memory_search(query: str) -> str:
            """
            Params:
                query: What to search for in the knowledge graph (e.g., "coupled cluster theory", "RSD", "antibody project")
            """
            try:
                from src.retrieve import retrieve_context
                from src.graph import load_config

                config = load_config(str(_GRAPHITI_DIR / "config.yaml"))
                context = await retrieve_context(query, config=config)

                if not context:
                    return json.dumps({"result": "No relevant memories found."})
                return json.dumps({"result": context})

            except Exception as exc:
                log.warning("memory_search failed: %s", exc)
                return json.dumps({"error": f"Memory search unavailable: {exc}"})

        @registry.tool(
            description=(
                "Remove memories from the user's knowledge graph. Use this when "
                "the user asks you to forget something, delete a memory, or remove "
                "information from their memory store. Searches for matching episodes "
                "and removes them. Be conservative — confirm what you're removing."
            )
        )
        async def memory_forget(query: str) -> str:
            """
            Params:
                query: What to forget / remove from the knowledge graph (e.g., "my old address", "the project we abandoned")
            """
            try:
                from src.graph import get_client, load_config

                config = load_config(str(_GRAPHITI_DIR / "config.yaml"))
                client = await get_client(config)

                try:
                    # Search for matching episodes
                    result = await client.search(query=query, num_results=10)

                    episodes = getattr(result, "episodes", []) if not isinstance(result, list) else []

                    if not episodes:
                        return json.dumps({
                            "result": "No matching memories found to remove."
                        })

                    # Remove each matching episode
                    removed = []
                    errors = []
                    for ep in episodes:
                        try:
                            await client.remove_episode(ep.uuid)
                            # Build a short description of what was removed
                            body = getattr(ep, "content", "") or getattr(ep, "body", "") or str(ep.uuid)
                            removed.append(body[:100])
                        except Exception as exc:
                            errors.append(str(exc))

                    summary = {
                        "removed_count": len(removed),
                        "removed_previews": removed,
                    }
                    if errors:
                        summary["errors"] = errors

                    return json.dumps(summary)

                finally:
                    await client.close()

            except Exception as exc:
                log.warning("memory_forget failed: %s", exc)
                return json.dumps({"error": f"Memory forget unavailable: {exc}"})

    def provides(self) -> list[str]:
        return ["memory_search", "memory_forget"]


plugin = MemoryPlugin()
