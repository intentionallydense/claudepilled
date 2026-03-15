"""Retrieval engine — search the Graphiti graph and return formatted context.

Core function: retrieve_context(query) returns a formatted string suitable
for injection into a Claude system prompt.
"""

from __future__ import annotations

import logging
from datetime import datetime

from .formatting import format_context
from .graph import get_client, load_config

log = logging.getLogger(__name__)


async def retrieve_context(
    query: str,
    max_results: int = 10,
    max_tokens: int = 1500,
    config: dict | None = None,
) -> str:
    """Search the knowledge graph and return formatted context for a system prompt.

    Uses Graphiti's built-in hybrid search (semantic + keyword + graph traversal).
    Returns an empty string if no relevant context is found.
    """
    if config is None:
        config = load_config()

    max_results = config.get("max_search_results", max_results)
    max_tokens = config.get("max_context_tokens", max_tokens)

    client = await get_client(config)
    try:
        result = await client.search(
            query=query,
            num_results=max_results,
        )

        nodes = getattr(result, "nodes", []) if not isinstance(result, list) else []
        edges = getattr(result, "edges", []) if not isinstance(result, list) else result
        episodes = getattr(result, "episodes", []) if not isinstance(result, list) else []

        return format_context(
            nodes=nodes,
            edges=edges,
            episodes=episodes,
            max_tokens=max_tokens,
        )
    except Exception as exc:
        log.warning("Graph search failed: %s", exc)
        return ""
    finally:
        await client.close()
