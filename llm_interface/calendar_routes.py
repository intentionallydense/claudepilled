"""Backward compatibility shim — actual implementation in plugins/calendar/routes.py"""
from llm_interface.plugins.calendar.routes import *  # noqa: F401, F403
from llm_interface.plugins.calendar.routes import init, router
__all__ = ["router", "init"]
