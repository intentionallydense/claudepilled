"""Backward compatibility shim — actual implementation in plugins/briefing/sequential.py"""
from llm_interface.plugins.briefing.sequential import *  # noqa: F401, F403
from llm_interface.plugins.briefing.sequential import (  # noqa: F811
    SERIES_CONFIG,
    get_long_read,
    get_todays_item,
    init_all_series,
    load_list,
)

__all__ = ["init_all_series", "get_todays_item", "get_long_read", "load_list", "SERIES_CONFIG"]
