"""LLM tool definitions for Google Calendar.

Registers calendar query and event creation tools so the LLM can
answer questions like "what's my day look like" and create events
via natural language.

Used by the calendar plugin __init__.py — call
register_calendar_tools(registry, cal_db, main_db) at load time.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import CalendarDatabase
from llm_interface.tools import ToolRegistry


def register_calendar_tools(
    registry: ToolRegistry,
    cal_db: CalendarDatabase,
    main_db,
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
                    "event_id": e.get("google_event_id"),
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
                "event_id": e.get("google_event_id"),
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
            "start time, and end time as ISO datetime strings with timezone "
            "offset (e.g. 2026-03-15T14:00:00+00:00). Optionally accepts "
            "description and location."
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
            from .routes import _get_credentials, _build_service, _parse_gcal_event
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

    @registry.tool(
        description=(
            "Update an existing Google Calendar event. Requires the event_id "
            "(from calendar_today or calendar_week results). Only the fields "
            "you provide will be changed — omit fields to leave them as-is. "
            "Use this when the user wants to reschedule, rename, or edit an event."
        )
    )
    def calendar_update(
        event_id: str,
        summary: str = "",
        start: str = "",
        end: str = "",
        description: str = "",
        location: str = "",
    ) -> str:
        if not _is_connected():
            return json.dumps({"error": "Google Calendar not connected. Visit /tasks to connect."})

        try:
            from .routes import _get_credentials, _build_service, _parse_gcal_event
        except ImportError:
            return json.dumps({"error": "Google Calendar API libraries not installed"})

        creds = _get_credentials()
        if not creds or not creds.valid:
            return json.dumps({"error": "Google Calendar credentials expired. Re-authorize at /tasks."})

        service = _build_service(creds)

        try:
            # Fetch the existing event first
            existing = service.events().get(
                calendarId="primary", eventId=event_id,
            ).execute()

            # Only update fields that were provided
            if summary:
                existing["summary"] = summary
            if start:
                existing["start"] = {"dateTime": start}
            if end:
                existing["end"] = {"dateTime": end}
            if description:
                existing["description"] = description
            if location:
                existing["location"] = location

            updated = service.events().update(
                calendarId="primary", eventId=event_id, body=existing,
            ).execute()

            parsed = _parse_gcal_event(updated, "primary")
            cal_db.upsert_events([parsed])
            return json.dumps({"ok": True, "event_id": event_id, "summary": updated.get("summary", "")})
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    @registry.tool(
        description=(
            "Delete a Google Calendar event. Requires the event_id "
            "(from calendar_today or calendar_week results). "
            "Use this when the user wants to cancel or remove an event."
        )
    )
    def calendar_delete(event_id: str) -> str:
        if not _is_connected():
            return json.dumps({"error": "Google Calendar not connected. Visit /tasks to connect."})

        try:
            from .routes import _get_credentials, _build_service
        except ImportError:
            return json.dumps({"error": "Google Calendar API libraries not installed"})

        creds = _get_credentials()
        if not creds or not creds.valid:
            return json.dumps({"error": "Google Calendar credentials expired. Re-authorize at /tasks."})

        service = _build_service(creds)

        try:
            service.events().delete(
                calendarId="primary", eventId=event_id,
            ).execute()
            # Remove from local cache
            cal_db.delete_event(event_id)
            return json.dumps({"ok": True, "event_id": event_id})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
