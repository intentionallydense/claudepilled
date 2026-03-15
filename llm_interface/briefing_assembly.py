"""Backward compatibility shim — actual implementation in plugins/briefing/assembly.py"""
from llm_interface.plugins.briefing.assembly import *  # noqa: F401, F403
from llm_interface.plugins.briefing.assembly import assemble_briefing, cli_main  # noqa: F811

__all__ = ["assemble_briefing", "cli_main"]
