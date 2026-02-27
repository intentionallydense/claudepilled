"""Tool registry and execution engine."""

from __future__ import annotations

import inspect
import json
from typing import Any, Callable, get_type_hints

from claude_wrapper.models import ToolDefinition

# Maps Python type annotations to JSON Schema types
_TYPE_MAP: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


class ToolRegistry:
    """Register and execute tools that Claude can call.

    Supports schema refreshers — callables registered via add_refresher()
    that update tool schemas dynamically before they're served to the API.
    Used by task tools to inject current project/tag lists into descriptions.
    """

    def __init__(self):
        self._tools: dict[str, ToolDefinition] = {}
        self._refreshers: list[Callable[[], None]] = []

    def tool(
        self,
        name: str | None = None,
        description: str | None = None,
    ) -> Callable:
        """Decorator to register a function as a tool.

        Usage:
            registry = ToolRegistry()

            @registry.tool(description="Add two numbers")
            def add(a: int, b: int) -> int:
                return a + b
        """
        def decorator(fn: Callable) -> Callable:
            tool_name = name or fn.__name__
            tool_desc = description or fn.__doc__ or f"Tool: {tool_name}"
            schema = _generate_schema(fn)
            self._tools[tool_name] = ToolDefinition(
                name=tool_name,
                description=tool_desc,
                input_schema=schema,
                callable=fn,
            )
            return fn
        return decorator

    def register(
        self,
        fn: Callable,
        name: str | None = None,
        description: str | None = None,
    ) -> None:
        """Register a function as a tool (non-decorator form)."""
        tool_name = name or fn.__name__
        tool_desc = description or fn.__doc__ or f"Tool: {tool_name}"
        schema = _generate_schema(fn)
        self._tools[tool_name] = ToolDefinition(
            name=tool_name,
            description=tool_desc,
            input_schema=schema,
            callable=fn,
        )

    def add_refresher(self, fn: Callable[[], None]) -> None:
        """Register a callable that updates tool schemas before they're served.

        Refreshers run each time get_definitions() or to_api_format() is called,
        keeping dynamic descriptions (like existing project/tag lists) current.
        """
        self._refreshers.append(fn)

    def _run_refreshers(self) -> None:
        for fn in self._refreshers:
            fn()

    def execute(self, tool_name: str, tool_input: dict[str, Any]) -> str:
        """Execute a registered tool and return the result as a string."""
        tool = self._tools.get(tool_name)
        if tool is None:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
        if tool.callable is None:
            return json.dumps({"error": f"Tool {tool_name} has no callable"})
        try:
            result = tool.callable(**tool_input)
            if isinstance(result, str):
                return result
            return json.dumps(result, default=str)
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    def list_tools(self) -> list[ToolDefinition]:
        self._run_refreshers()
        return list(self._tools.values())

    def to_api_format(self) -> list[dict[str, Any]]:
        self._run_refreshers()
        return [t.to_api_format() for t in self._tools.values()]

    def get_definitions(self) -> list[ToolDefinition]:
        self._run_refreshers()
        return list(self._tools.values())


def _generate_schema(fn: Callable) -> dict[str, Any]:
    """Generate a JSON Schema from a function's type hints and docstring."""
    hints = get_type_hints(fn)
    sig = inspect.signature(fn)
    params = sig.parameters

    properties: dict[str, Any] = {}
    required: list[str] = []

    # Parse parameter descriptions from docstring (simple "param: description" format)
    param_docs = _parse_param_docs(fn.__doc__ or "")

    for param_name, param in params.items():
        if param_name == "return":
            continue
        annotation = hints.get(param_name, str)
        json_type = _TYPE_MAP.get(annotation, "string")
        prop: dict[str, Any] = {"type": json_type}
        if param_name in param_docs:
            prop["description"] = param_docs[param_name]
        properties[param_name] = prop
        if param.default is inspect.Parameter.empty:
            required.append(param_name)

    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
    }
    if required:
        schema["required"] = required
    return schema


def _parse_param_docs(docstring: str) -> dict[str, str]:
    """Extract parameter descriptions from a docstring.

    Supports simple formats like:
        param_name: description text
    """
    result: dict[str, str] = {}
    in_params = False
    for line in docstring.splitlines():
        stripped = line.strip()
        if stripped.lower() in ("args:", "params:", "parameters:"):
            in_params = True
            continue
        if in_params:
            if not stripped or stripped.lower().startswith(("return", "raise", "example")):
                break
            if ":" in stripped:
                name, _, desc = stripped.partition(":")
                name = name.strip().lstrip("-").strip()
                result[name] = desc.strip()
    return result
