"""Backward compatibility shim — actual implementation in plugins/email/routes.py"""
from llm_interface.plugins.email.routes import init, router  # noqa: F401
__all__ = ["router", "init"]
