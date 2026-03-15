"""Backward compatibility shim — actual implementation in plugins/files/routes.py"""

from llm_interface.plugins.files.routes import init, router  # noqa: F401

__all__ = ["router", "init"]
