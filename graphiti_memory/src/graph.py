"""Graphiti connection and configuration.

Manages the Graphiti client instance and Neo4j connection.
All graph operations go through the client returned by get_client().

Uses OpenAI models via OpenRouter for extraction, embeddings, and reranking.
Local sentence-transformers embedder for vectors (OpenRouter doesn't proxy embeddings).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import yaml
from dotenv import load_dotenv
from graphiti_core import Graphiti

# Load .env from the project root (parent of graphiti_memory/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_PROJECT_ROOT / ".env")

log = logging.getLogger(__name__)

_DEFAULT_CONFIG = {
    "extraction_model": "gpt-4.1-nano",
    "small_model": "gpt-4.1-nano",
    "neo4j_uri": "bolt://localhost:7687",
    "neo4j_user": "neo4j",
    "neo4j_password": "",
    "openrouter_api_key": "",
    "openrouter_base_url": "https://openrouter.ai/api/v1",
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
    config["openrouter_api_key"] = os.environ.get(
        "OPENROUTER_API_KEY", config.get("openrouter_api_key", "")
    )

    return config


def _make_llm_client(config: dict):
    """Create an OpenAI client pointed at OpenRouter."""
    from graphiti_core.llm_client import OpenAIClient
    from graphiti_core.llm_client.config import LLMConfig

    api_key = config["openrouter_api_key"]
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY required")

    return OpenAIClient(
        config=LLMConfig(
            api_key=api_key,
            model=config["extraction_model"],
            small_model=config.get("small_model", "gpt-4.1-nano"),
            base_url=config["openrouter_base_url"],
        ),
    )


def _make_local_embedder():
    """Create a local sentence-transformers embedder for Graphiti.
    OpenRouter doesn't proxy embedding endpoints, so we run locally.
    thenlper/gte-large produces 1024-dim vectors matching Graphiti's default."""
    from graphiti_core.embedder.client import EmbedderClient
    from sentence_transformers import SentenceTransformer

    _model = SentenceTransformer("thenlper/gte-large")

    class LocalEmbedder(EmbedderClient):
        async def create(self, input_data):
            if isinstance(input_data, str):
                input_data = [input_data]
            texts = [str(t)[:8000] for t in input_data]
            embeddings = _model.encode(texts, normalize_embeddings=True)
            return embeddings[0].tolist()

        async def create_batch(self, input_data_list):
            texts = [str(t)[:8000] for t in input_data_list]
            embeddings = _model.encode(texts, normalize_embeddings=True)
            return [e.tolist() for e in embeddings]

    return LocalEmbedder()


async def get_client(config: dict | None = None) -> Graphiti:
    """Create and return a configured Graphiti client.

    The caller is responsible for calling client.close() when done.
    """
    if config is None:
        config = load_config()

    llm_client = _make_llm_client(config)
    embedder = _make_local_embedder()

    # Reranker also goes through OpenRouter
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
    from graphiti_core.llm_client.config import LLMConfig

    cross_encoder = OpenAIRerankerClient(
        config=LLMConfig(
            api_key=config["openrouter_api_key"],
            base_url=config["openrouter_base_url"],
            model=config.get("small_model", "gpt-4.1-nano"),
            small_model=config.get("small_model", "gpt-4.1-nano"),
        ),
    )

    client = Graphiti(
        uri=config["neo4j_uri"],
        user=config["neo4j_user"],
        password=config["neo4j_password"],
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=cross_encoder,
    )

    await client.build_indices_and_constraints()
    return client
