"""Backward compatibility shim — actual implementation in plugins/email/db.py"""
from llm_interface.plugins.email.db import EmailDatabase  # noqa: F401
__all__ = ["EmailDatabase"]
