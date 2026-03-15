"""Backward compatibility shim — actual implementation in plugins/briefing/anki.py"""
from llm_interface.plugins.briefing.anki import get_anki_stats  # noqa: F401

__all__ = ["get_anki_stats"]
