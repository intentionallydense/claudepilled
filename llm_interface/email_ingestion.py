"""Backward compatibility shim — actual implementation in plugins/email/ingestion.py"""
from llm_interface.plugins.email.ingestion import *  # noqa: F401, F403
from llm_interface.plugins.email.ingestion import (
    _DEFAULT_PARSE_PROMPT,
    _resolve_parse_prompt,
    cli_main,
    ingestion_status,
    process_inbox,
)
__all__ = [
    "process_inbox", "cli_main", "ingestion_status",
    "_DEFAULT_PARSE_PROMPT", "_resolve_parse_prompt",
]
