"""Backward compatibility shim — actual implementation in plugins/files/db.py"""

from llm_interface.plugins.files.db import FileDatabase  # noqa: F401

__all__ = ["FileDatabase"]
