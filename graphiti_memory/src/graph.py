"""Graphiti connection and configuration.

Manages the Graphiti client instance and Neo4j connection.
All graph operations go through the client returned by get_client().

Supports both Anthropic and Z.AI (OpenAI-compatible) LLM clients.
Set extraction_model to a glm-* model to use Z.AI directly.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml
from dotenv import load_dotenv
from graphiti_core import Graphiti

# Load .env from the project root (parent of graphiti_memory/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_PROJECT_ROOT / ".env")


_DEFAULT_CONFIG = {
    "extraction_model": "glm-5",
    "neo4j_uri": "bolt://localhost:7687",
    "neo4j_user": "neo4j",
    "neo4j_password": "",
    "zai_api_key": "",
    "zai_base_url": "https://api.z.ai/api/paas/v4",
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
    config["zai_api_key"] = os.environ.get(
        "ZAI_API_KEY", config.get("zai_api_key", "")
    )

    return config


def _make_llm_client(config: dict):
    """Create the appropriate LLM client based on model name."""
    model = config["extraction_model"]

    if model.startswith("glm"):
        # Z.AI via OpenAI-compatible client
        from graphiti_core.llm_client import OpenAIGenericClient
        from graphiti_core.llm_client.config import LLMConfig

        api_key = config["zai_api_key"]
        if not api_key:
            raise ValueError("ZAI_API_KEY required for GLM models")

        return OpenAIGenericClient(
            config=LLMConfig(
                api_key=api_key,
                model=model,
                base_url=config["zai_base_url"],
            ),
        )
    else:
        # Anthropic
        from graphiti_core.llm_client import AnthropicClient
        return AnthropicClient(model=model)


async def get_client(config: dict | None = None) -> Graphiti:
    """Create and return a configured Graphiti client.

    The caller is responsible for calling client.close() when done.
    """
    if config is None:
        config = load_config()

    llm_client = _make_llm_client(config)

    client = Graphiti(
        neo4j_uri=config["neo4j_uri"],
        neo4j_user=config["neo4j_user"],
        neo4j_password=config["neo4j_password"],
        llm_client=llm_client,
    )

    await client.build_indices()
    return client
