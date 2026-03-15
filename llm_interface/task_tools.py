"""Backward compatibility shim — actual implementation in plugins/tasks/tools.py"""

from llm_interface.plugins.tasks.tools import (  # noqa: F401
    BRAIN_DUMP_PROMPT,
    build_task_context,
    register_task_tools,
)

__all__ = ["BRAIN_DUMP_PROMPT", "build_task_context", "register_task_tools"]
