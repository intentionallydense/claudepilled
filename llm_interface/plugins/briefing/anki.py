"""AnkiConnect proxy — re-exports from the standalone briefing package.

The standalone `briefing` package has the full implementation with
configurable host/port/timeout. This module re-exports for use by
the /api/anki/stats endpoint.
"""

from briefing.anki import get_anki_stats  # noqa: F401

__all__ = ["get_anki_stats"]
