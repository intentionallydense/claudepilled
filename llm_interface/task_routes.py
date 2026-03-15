"""Backward compatibility shim — actual implementation in plugins/tasks/routes.py"""

from llm_interface.plugins.tasks.routes import init, router  # noqa: F401

__all__ = ["router", "init"]
