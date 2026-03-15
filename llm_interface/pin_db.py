"""Backward compatibility shim — actual implementation in plugins/pins/db.py"""

from llm_interface.plugins.pins.db import PinDatabase  # noqa: F401

__all__ = ["PinDatabase"]
