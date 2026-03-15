"""Backward compatibility shim — actual implementation in plugins/pins/tools.py"""

from llm_interface.plugins.pins.tools import register_pin_tools  # noqa: F401

__all__ = ["register_pin_tools"]
