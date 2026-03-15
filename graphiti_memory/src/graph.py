"""Graphiti connection and configuration.

Manages the Graphiti client instance and Neo4j connection.
All graph operations go through the client returned by get_client().
"""

from __future__ import annotations

import os

import yaml
from graphiti_core import Graphiti
from graphiti_core.llm_client import AnthropicClient


_DEFAULT_CONFIG = {
    "extraction_model": "claude-sonnet-4-20250514",
    "neo4j_uri": "bolt://localhost:7687",
    "neo4j_user": "neo4j",
    "neo4j_password": "",
}


def load_config(config_path: str = "config.yaml") -> dict:
    """Load config from YAML, falling back to env vars and defaults."""
    config = dict(_DEFAULT_CONFIG)

    if os.path.exists(config_path):
        with open(config_path) as f:
            file_config = yaml.safe_load(f) or {}
        config.update(file_config)

    # Env vars override file config
    config["neo4j_password"] = os.environ.get(
        "NEO4J_PASSWORD", config.get("neo4j_password", "")
    )
    config["neo4j_uri"] = os.environ.get(
        "NEO4J_URI", config.get("neo4j_uri", _DEFAULT_CONFIG["neo4j_uri"])
    )

    return config


async def get_client(config: dict | None = None) -> Graphiti:
    """Create and return a configured Graphiti client.

    The caller is responsible for calling client.close() when done.
    """
    if config is None:
        config = load_config()

    llm_client = AnthropicClient(model=config["extraction_model"])

    client = Graphiti(
        neo4j_uri=config["neo4j_uri"],
        neo4j_user=config["neo4j_user"],
        neo4j_password=config["neo4j_password"],
        llm_client=llm_client,
    )

    await client.build_indices()
    return client
