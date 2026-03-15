"""Sequential reading list pointer management.

Tracks position across multi-item series (Sequences, Gwern essays,
ACX best-of, album list). Each series advances one item per day.
Used by briefing_assembly.py during daily assembly.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from .db import BriefingDatabase

# Relative to project root's data/ directory
SERIES_CONFIG = {
    "sequences": {
        "list_path": "sequences_order.json",
        "display_name": "LessWrong Sequences",
    },
    "gwern": {
        "list_path": "gwern_essays.json",
        "display_name": "Gwern Essays",
    },
    "acx": {
        "list_path": "acx_best_of.json",
        "display_name": "ACX/SSC Best Of",
    },
    "albums": {
        "list_path": "album_list.json",
        "display_name": "Album of the Day",
    },
}

# Resolve the data/ directory — sits alongside llm_interface/ in project root.
# Path: plugins/briefing/sequential.py -> plugins/ -> llm_interface/ -> project root
_DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data"


def init_all_series(briefing_db: BriefingDatabase) -> None:
    """Register all series in the DB. Idempotent — safe to call on every startup."""
    for series_key, config in SERIES_CONFIG.items():
        briefing_db.init_series(series_key, config["list_path"])


def load_list(list_path: str) -> list[dict]:
    """Load a JSON reading list from the data/ directory."""
    full_path = _DATA_DIR / list_path
    if not full_path.exists():
        return []
    with open(full_path) as f:
        return json.load(f)


def get_todays_item(series: str, briefing_db: BriefingDatabase) -> dict | None:
    """Return the current item for a series, advancing if not yet done today.

    Returns None if the series is paused, unknown, or exhausted.
    """
    config = SERIES_CONFIG.get(series)
    if config is None:
        return None

    progress = briefing_db.get_progress(series)
    if progress is None or progress["paused"]:
        return None

    # Advance pointer if it hasn't been advanced today
    today = date.today().isoformat()
    if progress["last_advanced"] != today:
        progress = briefing_db.advance_pointer(series)

    items = load_list(config["list_path"])
    index = progress["current_index"]

    if index >= len(items):
        return None  # series exhausted

    item = items[index]
    item["_series"] = series
    item["_display_name"] = config["display_name"]
    item["_index"] = index
    item["_total"] = len(items)
    return item


def get_long_read(briefing_db: BriefingDatabase, acx_new_post: dict | None = None) -> dict:
    """Pick today's long read: Gwern/ACX alternation via day_of_year % 2.

    If acx_new_post is provided (from RSS), it overrides the ACX slot
    regardless of alternation schedule.
    """
    day = date.today().timetuple().tm_yday

    if acx_new_post is not None:
        return {
            "type": "acx_new",
            "title": acx_new_post.get("title", "New ACX Post"),
            "url": acx_new_post.get("url", ""),
            "source": "acx_rss",
        }

    if day % 2 == 0:
        # Gwern day
        item = get_todays_item("gwern", briefing_db)
        if item:
            return {"type": "gwern", **item}
        # Fallback to ACX if gwern exhausted
        item = get_todays_item("acx", briefing_db)
        if item:
            return {"type": "acx", **item}
    else:
        # ACX day
        item = get_todays_item("acx", briefing_db)
        if item:
            return {"type": "acx", **item}
        # Fallback to Gwern if ACX exhausted
        item = get_todays_item("gwern", briefing_db)
        if item:
            return {"type": "gwern", **item}

    return {"type": "none", "title": "No long read available today"}
