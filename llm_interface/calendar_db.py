"""Backward compatibility shim — actual implementation in plugins/calendar/db.py"""
from llm_interface.plugins.calendar.db import CalendarDatabase  # noqa: F401
__all__ = ["CalendarDatabase"]
