"""RSS feed fetching and Wikipedia API for the daily briefing.

Pulls headlines from FT, chemistry news from C&EN / Nature Chemistry,
checks ACX RSS for new posts, and fetches Wikipedia's featured article.

Used by briefing_assembly.py during daily gathering.
"""

from __future__ import annotations

import json
import ssl
import urllib.request
import urllib.error
from datetime import date
from typing import Any

import certifi
import feedparser

from claude_wrapper.briefing_db import BriefingDatabase

# SSL context using certifi's CA bundle — fixes macOS Python cert issues
_SSL_CTX = ssl.create_default_context(cafile=certifi.where())
_HTTPS_HANDLER = urllib.request.HTTPSHandler(context=_SSL_CTX)
_OPENER = urllib.request.build_opener(_HTTPS_HANDLER)


# Feed URLs
FT_RSS = "https://www.ft.com/rss/home"
CEN_RSS = "https://cen.acs.org/rss/feed.html"
NATURE_CHEM_RSS = "https://www.nature.com/nchem.rss"
ACX_RSS = "https://www.astralcodexten.com/feed"

# Wikipedia REST API for featured article
WIKI_FEATURED_URL = "https://en.wikipedia.org/api/rest_v1/feed/featured/{year}/{month}/{day}"


def _parse_feed(url: str, max_items: int = 10) -> list[dict]:
    """Shared feedparser wrapper with error handling.

    Returns a list of dicts with title, url, published (if available).
    Returns empty list on any failure — briefing should never crash on a feed.
    """
    try:
        # feedparser needs an SSL-aware handler on macOS
        feed = feedparser.parse(url, handlers=[_HTTPS_HANDLER])
        results = []
        for entry in feed.entries[:max_items]:
            item = {
                "title": entry.get("title", "Untitled"),
                "url": entry.get("link", ""),
            }
            if hasattr(entry, "published"):
                item["published"] = entry.published
            if hasattr(entry, "summary"):
                # Truncate long summaries
                summary = entry.summary
                if len(summary) > 300:
                    summary = summary[:300] + "..."
                item["summary"] = summary
            results.append(item)
        return results
    except Exception:
        return []


def fetch_ft_headlines(max_items: int = 10) -> list[dict]:
    """Fetch Financial Times homepage headlines via RSS."""
    return _parse_feed(FT_RSS, max_items)


def fetch_chemistry_news(max_items: int = 5) -> list[dict]:
    """Fetch chemistry news from C&EN and Nature Chemistry, merged by recency."""
    cen = _parse_feed(CEN_RSS, max_items)
    nature = _parse_feed(NATURE_CHEM_RSS, max_items)

    # Tag the source
    for item in cen:
        item["source"] = "C&EN"
    for item in nature:
        item["source"] = "Nature Chemistry"

    # Merge and take most recent
    merged = cen + nature
    # feedparser dates are strings — sort alphabetically works for RSS date formats
    merged.sort(key=lambda x: x.get("published", ""), reverse=True)
    return merged[:max_items]


def fetch_wikipedia_featured(target_date: date | None = None) -> dict | None:
    """Fetch Wikipedia's featured article for a given date via REST API.

    Returns dict with title, extract, url — or None on failure.
    """
    d = target_date or date.today()
    url = WIKI_FEATURED_URL.format(
        year=d.year,
        month=str(d.month).zfill(2),
        day=str(d.day).zfill(2),
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ClaudeWrapper/1.0"})
        resp = _OPENER.open(req, timeout=10)
        data = json.loads(resp.read().decode("utf-8"))

        tfa = data.get("tfa")
        if tfa is None:
            return None

        return {
            "title": tfa.get("normalizedtitle", tfa.get("title", "Unknown")),
            "extract": tfa.get("extract", ""),
            "url": tfa.get("content_urls", {}).get("desktop", {}).get("page", ""),
        }
    except (urllib.error.URLError, json.JSONDecodeError, OSError):
        return None


def check_acx_new_posts(briefing_db: BriefingDatabase) -> dict | None:
    """Check ACX RSS for the newest post not yet shown in a briefing.

    Returns the newest unseen post dict, or None if nothing new.
    Marks returned post as shown in the DB.
    """
    posts = _parse_feed(ACX_RSS, 5)
    for post in posts:
        url = post.get("url", "")
        if url and not briefing_db.was_shown(url):
            briefing_db.mark_shown(url, "acx_rss")
            return post
    return None
