"""Backward compatibility shim — actual implementation in plugins/pins/routes.py"""

from llm_interface.plugins.pins.routes import init, router  # noqa: F401

__all__ = ["router", "init"]
