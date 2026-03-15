"""AnkiConnect proxy for the daily briefing.

Talks to AnkiConnect (localhost:8765) to pull review stats.
Fails gracefully when Anki isn't running — the briefing just
skips the Anki section.

Used by briefing_assembly.py during daily gathering.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any

ANKI_URL = "http://localhost:8765"
ANKI_TIMEOUT = 3  # seconds — don't block the briefing if Anki is slow


def _anki_request(action: str, **params: Any) -> Any:
    """Send a request to AnkiConnect. Returns result or raises on error."""
    payload = json.dumps({"action": action, "version": 6, "params": params})
    req = urllib.request.Request(
        ANKI_URL,
        data=payload.encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=ANKI_TIMEOUT)
    body = json.loads(resp.read().decode("utf-8"))
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body.get("result")


def get_anki_stats() -> dict:
    """Fetch review stats from Anki via AnkiConnect.

    Returns a dict with:
        available: bool — whether Anki was reachable
        total_due: int — cards due across all decks
        decks: list[dict] — per-deck name + due count
        reviewed_today: int — cards reviewed so far today
        most_overdue_deck: str | None — deck with most due cards

    On failure, returns {available: False} so the briefing can skip gracefully.
    """
    try:
        # Get deck names and their due counts
        deck_names = _anki_request("deckNames")
        decks = []
        total_due = 0

        for name in deck_names:
            # Skip sub-decks — only top-level
            if "::" in name:
                continue
            due = _anki_request("findCards", query=f'"deck:{name}" is:due')
            count = len(due) if isinstance(due, list) else 0
            decks.append({"name": name, "due": count})
            total_due += count

        # Sort by due count descending
        decks.sort(key=lambda d: d["due"], reverse=True)
        most_overdue = decks[0]["name"] if decks and decks[0]["due"] > 0 else None

        # Cards reviewed today
        reviewed_cards = _anki_request("findCards", query="rated:1")
        reviewed_today = len(reviewed_cards) if isinstance(reviewed_cards, list) else 0

        return {
            "available": True,
            "total_due": total_due,
            "decks": decks,
            "reviewed_today": reviewed_today,
            "most_overdue_deck": most_overdue,
        }

    except (urllib.error.URLError, ConnectionRefusedError, OSError, RuntimeError):
        return {"available": False}
