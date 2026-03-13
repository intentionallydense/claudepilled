"""Claude tool definitions for Google Calendar.

Registers calendar query and event creation tools so Claude can
answer questions like "what's my day look like" and create events
via natural language.

Used by server.py — call register_calendar_tools(registry, cal_db, main_db)
at startup.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from claude_wrapper.calendar_db import CalendarDatabase
from claude_wrapper.db import Database
from claude_wrapper.tools import ToolRegistry


def register_calendar_tools(
    registry: ToolRegistry,
    cal_db: CalendarDatabase,
    main_db: Database,
) -> None:
    """Register calendar tools on the given registry."""

    def _is_connected() -> bool:
        """Check if gcal credentials are available."""
        token_json = main_db.get_setting("gcal_token")
        return bool(token_json)

    @registry.tool(
        description=(
            "Get today's calendar events and tasks. Returns a chronological "
            "view of the day including Google Calendar events. Use this when "
            "the user asks about their schedule, agenda, or what's coming up."
        )
    )
    def calendar_today() -> str:
        if not _is_connected():
            return json.dumps({"error": "Google Calendar not connected. Visit /tasks to connect."})

        now = datetime.now(timezone.utc)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        end = now.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()

        events = cal_db.get_events(start, end)
        return json.dumps({
            "date": now.strftime("%A %B %d, %Y"),
            "events": [
                {
                    "summary": e["summary"],
                    "start": e["start_time"],
                    "end": e["end_time"],
                    "all_day": bool(e["all_day"]),
                    "location": e.get("location"),
                    "calendar": e.get("calendar_name"),
                }
                for e in events
            ],
            "count": len(events),
        })

    @registry.tool(
        description=(
            "Get calendar events for a date range. Accepts start and end as "
            "ISO date strings (YYYY-MM-DD). Defaults to next 7 days if no "
            "range given. Use this for questions about upcoming schedule."
        )
    )
    def calendar_week(start: str = "", end: str = "") -> str:
        if not _is_connected():
            return json.dumps({"error": "Google Calendar not connected. Visit /tasks to connect."})

        now = datetime.now(timezone.utc)
        if not start:
            start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            start_dt = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)

        if not end:
            end_dt = start_dt + timedelta(days=7)
        else:
            end_dt = datetime.fromisoformat(end).replace(
                hour=23, minute=59, second=59, tzinfo=timezone.utc,
            )

        events = cal_db.get_events(start_dt.isoformat(), end_dt.isoformat())

        # Group by date
        by_date: dict[str, list[dict]] = {}
        for e in events:
            date_key = e["start_time"][:10]
            if date_key not in by_date:
                by_date[date_key] = []
            by_date[date_key].append({
                "summary": e["summary"],
                "start": e["start_time"],
                "end": e["end_time"],
                "all_day": bool(e["all_day"]),
                "location": e.get("location"),
                "calendar": e.get("calendar_name"),
            })

        return json.dumps({
            "start": start_dt.strftime("%Y-%m-%d"),
            "end": end_dt.strftime("%Y-%m-%d"),
            "days": by_date,
            "total_events": len(events),
        })

    @registry.tool(
        description=(
            "Create a Google Calendar event. Requires summary (title), "
            "start time, and end time as ISO datetime strings. Optionally "
            "accepts description and location."
        )
    )
    def calendar_create(
        summary: str,
        start: str,
        end: str,
        description: str = "",
        location: str = "",
    ) -> str:
        if not _is_connected():
            return json.dumps({"error": "Google Calendar not connected. Visit /tasks to connect."})

        # Import here to avoid startup dependency if google libs aren't installed
        try:
            from claude_wrapper.calendar_routes import _get_credentials, _build_service, _parse_gcal_event
        except ImportError:
            return json.dumps({"error": "Google Calendar API libraries not installed"})

        creds = _get_credentials()
        if not creds or not creds.valid:
            return json.dumps({"error": "Google Calendar credentials expired. Re-authorize at /tasks."})

        service = _build_service(creds)
        event_body: dict = {
            "summary": summary,
            "start": {"dateTime": start},
            "end": {"dateTime": end},
        }
        if description:
            event_body["description"] = description
        if location:
            event_body["location"] = location

        try:
            created = service.events().insert(
                calendarId="primary",
                body=event_body,
            ).execute()
            # Cache locally
            parsed = _parse_gcal_event(created, "primary")
            cal_db.upsert_events([parsed])
            return json.dumps({"ok": True, "event_id": created["id"], "summary": summary})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
