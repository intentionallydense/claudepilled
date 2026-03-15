"""Backward compatibility shim — actual implementation in plugins/briefing/db.py"""
from llm_interface.plugins.briefing.db import BriefingDatabase  # noqa: F401

__all__ = ["BriefingDatabase"]
