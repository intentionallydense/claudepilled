"""Example tools to get you started. Add your own!"""

from datetime import datetime, timezone

from llm_interface.tools import ToolRegistry

registry = ToolRegistry()


@registry.tool(description="Get the current date and time in UTC.")
def get_current_time() -> str:
    """Returns the current UTC datetime."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


@registry.tool(description="Evaluate a math expression safely and return the result.")
def calculate(expression: str) -> str:
    """Evaluate a math expression.

    Args:
        expression: A math expression like '2 + 2' or 'sqrt(16) * 3'.
    """
    import math

    allowed_names = {
        k: v for k, v in math.__dict__.items() if not k.startswith("_")
    }
    allowed_names["abs"] = abs
    allowed_names["round"] = round
    allowed_names["min"] = min
    allowed_names["max"] = max

    try:
        result = eval(expression, {"__builtins__": {}}, allowed_names)
        return str(result)
    except Exception as exc:
        return f"Error: {exc}"


