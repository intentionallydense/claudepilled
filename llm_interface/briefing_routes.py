"""Backward compatibility shim — actual implementation in plugins/briefing/routes.py"""
from llm_interface.plugins.briefing.routes import (  # noqa: F401
    anki_router,
    init,
    progress_router,
    router,
)

__all__ = ["router", "progress_router", "anki_router", "init"]
