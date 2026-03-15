"""Backward compatibility shim — actual implementation in plugins/calendar/tools.py"""
from llm_interface.plugins.calendar.tools import register_calendar_tools  # noqa: F401
__all__ = ["register_calendar_tools"]
