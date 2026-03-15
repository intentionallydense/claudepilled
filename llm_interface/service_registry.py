"""Named callable registry for inter-plugin communication.

Plugins register services via register(name, fn). Other plugins retrieve
them via get(name), which returns None if not registered. Plugins handle
None gracefully. Not an event bus — just a dict of named functions.

Used by plugin_loader.py during startup and by plugins at runtime.
"""

from __future__ import annotations

from typing import Any, Callable


class ServiceRegistry:
    """Simple dict-based service registry."""

    def __init__(self) -> None:
        self._services: dict[str, Any] = {}

    def register(self, name: str, fn: Callable | Any) -> None:
        """Register a named service. Overwrites if already registered."""
        self._services[name] = fn

    def get(self, name: str) -> Any | None:
        """Get a named service, or None if not registered."""
        return self._services.get(name)

    def has(self, name: str) -> bool:
        """Check if a service is registered."""
        return name in self._services

    def list_services(self) -> list[str]:
        """Return all registered service names."""
        return list(self._services.keys())
