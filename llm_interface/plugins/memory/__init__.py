"""Memory plugin — Graphiti knowledge graph search as an LLM tool.

Registers a `memory_search` tool that lets models query the user's
personal knowledge graph built from past conversations. Returns
temporally-aware context from the Graphiti graph.

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
        def memory_search(query: str) -> str:
            """
            Params:
                query: What to search for in the knowledge graph (e.g., "coupled cluster theory", "RSD", "antibody project")
            """
            try:
                from src.retrieve import retrieve_context
                from src.graph import load_config

                config = load_config(str(_GRAPHITI_DIR / "config.yaml"))
                # Run the async retrieval in a new event loop
                # (tool handlers are sync in the current ToolRegistry)
                loop = asyncio.new_event_loop()
                try:
                    context = loop.run_until_complete(
                        retrieve_context(query, config=config)
                    )
                finally:
                    loop.close()

                if not context:
                    return json.dumps({"result": "No relevant memories found."})
                return json.dumps({"result": context})

            except Exception as exc:
                log.warning("memory_search failed: %s", exc)
                return json.dumps({"error": f"Memory search unavailable: {exc}"})

    def provides(self) -> list[str]:
        return ["memory_search"]


plugin = MemoryPlugin()
