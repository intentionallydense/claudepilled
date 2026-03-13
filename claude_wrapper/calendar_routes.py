"""FastAPI router for Google Calendar integration.

Handles OAuth2 flow (authorization + callback), event fetching with
local caching, and event creation. All routes prefixed with /api/calendar.

Used by server.py — call init(calendar_db, db) at startup.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from claude_wrapper.calendar_db import CalendarDatabase
from claude_wrapper.db import Database

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# Set during server startup
cal_db: CalendarDatabase | None = None
main_db: Database | None = None

# Google API scopes — read+write events
SCOPES = ["https://www.googleapis.com/auth/calendar.events"]


def init(calendar_db: CalendarDatabase, db: Database) -> None:
    """Called by server.py on startup to inject dependencies."""
    global cal_db, main_db
    cal_db = calendar_db
    main_db = db


def _get_credentials():
    """Load stored OAuth2 credentials from settings, refresh if needed.

    Returns a google.oauth2.credentials.Credentials object or None.
    """
    token_json = main_db.get_setting("gcal_token")
    if not token_json:
        return None

    try:
        from google.oauth2.credentials import Credentials
        token_data = json.loads(token_json)
        creds = Credentials(
            token=token_data.get("token"),
            refresh_token=token_data.get("refresh_token"),
            token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=os.environ.get("GOOGLE_CLIENT_ID", ""),
            client_secret=os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            scopes=SCOPES,
        )
        # Refresh if expired
        if creds.expired and creds.refresh_token:
            from google.auth.transport.requests import Request as GoogleRequest
            creds.refresh(GoogleRequest())
            _save_credentials(creds)
        return creds
    except Exception:
        return None


def _save_credentials(creds) -> None:
    """Persist OAuth2 credentials to settings table."""
    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
    }
    main_db.set_setting("gcal_token", json.dumps(token_data))


def _build_service(creds):
    """Build a Google Calendar API v3 service object."""
    from googleapiclient.discovery import build
    return build("calendar", "v3", credentials=creds)


def _parse_gcal_event(event: dict, calendar_id: str = "primary", calendar_name: str | None = None, color: str | None = None) -> dict:
    """Convert a Google Calendar API event dict to our cache format."""
    start = event.get("start", {})
    end = event.get("end", {})

    # All-day events use 'date', timed events use 'dateTime'
    all_day = "date" in start and "dateTime" not in start
    if all_day:
        start_time = start["date"] + "T00:00:00"
        end_time = end["date"] + "T00:00:00"
    else:
        start_time = start.get("dateTime", "")
        end_time = end.get("dateTime", "")

    return {
        "google_event_id": event["id"],
        "calendar_id": calendar_id,
        "summary": event.get("summary", "(No title)"),
        "description": event.get("description"),
        "location": event.get("location"),
        "start_time": start_time,
        "end_time": end_time,
        "all_day": all_day,
        "calendar_name": calendar_name,
        "color": color,
        "status": event.get("status", "confirmed"),
    }


# ------------------------------------------------------------------
# OAuth2 flow
# ------------------------------------------------------------------

@router.get("/status")
async def calendar_status():
    """Check if Google Calendar is connected."""
    creds = _get_credentials()
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    return {
        "connected": creds is not None and creds.valid,
        "configured": bool(client_id),
    }


@router.get("/auth")
async def calendar_auth(request: Request):
    """Start the OAuth2 authorization flow — redirects to Google."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400,
            detail="GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env",
        )

    from google_auth_oauthlib.flow import Flow
    # Determine redirect URI from the request
    redirect_uri = str(request.url_for("calendar_callback"))

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )

    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
    )
    # Store state for callback verification
    main_db.set_setting("gcal_oauth_state", state)

    return RedirectResponse(url=auth_url)


@router.get("/callback")
async def calendar_callback(request: Request, code: str = "", state: str = ""):
    """Handle the OAuth2 callback from Google."""
    stored_state = main_db.get_setting("gcal_oauth_state")
    if not state or state != stored_state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")

    from google_auth_oauthlib.flow import Flow
    redirect_uri = str(request.url_for("calendar_callback"))

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=redirect_uri,
    )

    flow.fetch_token(code=code)
    _save_credentials(flow.credentials)

    # Clean up state
    main_db.set_setting("gcal_oauth_state", "")

    # Redirect back to tasks page with success indicator
    return HTMLResponse(
        "<html><body><p>Google Calendar connected. Redirecting...</p>"
        "<script>window.location.href='/tasks';</script></body></html>"
    )


@router.post("/disconnect")
async def calendar_disconnect():
    """Remove stored OAuth credentials."""
    main_db.set_setting("gcal_token", "")
    cal_db.clear_all()
    return {"ok": True}


# ------------------------------------------------------------------
# Event fetching + caching
# ------------------------------------------------------------------

@router.get("/events")
async def get_events(
    start: str | None = None,
    end: str | None = None,
    refresh: bool = False,
):
    """Get calendar events for a date range.

    Defaults to today through 7 days out. If refresh=true, re-fetches
    from Google and updates the cache.
    """
    now = datetime.now(timezone.utc)
    if not start:
        start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    if not end:
        end = (now + timedelta(days=7)).replace(hour=23, minute=59, second=59).isoformat()

    creds = _get_credentials()

    # If connected and (refresh requested or cache empty), fetch from Google
    if creds and creds.valid:
        cached = cal_db.get_events(start, end)
        if refresh or not cached:
            try:
                fetched = await _fetch_from_google(creds, start, end)
                if fetched is not None:
                    # Clear old cache for this range and insert fresh data
                    cal_db.clear_range(start, end)
                    cal_db.upsert_events(fetched)
            except Exception as exc:
                # If fetch fails, fall back to cache
                if not cached:
                    return {"events": [], "error": str(exc), "cached": False}

    events = cal_db.get_events(start, end)
    return {"events": events, "cached": True}


async def _fetch_from_google(creds, start: str, end: str) -> list[dict] | None:
    """Fetch events from all visible Google calendars."""
    service = _build_service(creds)
    all_events = []

    # Get calendar list for names and colors
    calendar_list = service.calendarList().list().execute()
    calendars = calendar_list.get("items", [])

    for cal in calendars:
        cal_id = cal["id"]
        cal_name = cal.get("summary", cal_id)
        cal_color = cal.get("backgroundColor")

        # Skip hidden calendars
        if cal.get("hidden"):
            continue

        events_result = service.events().list(
            calendarId=cal_id,
            timeMin=start,
            timeMax=end,
            singleEvents=True,
            orderBy="startTime",
            maxResults=250,
        ).execute()

        for event in events_result.get("items", []):
            parsed = _parse_gcal_event(event, cal_id, cal_name, cal_color)
            all_events.append(parsed)

    return all_events


# ------------------------------------------------------------------
# Event creation
# ------------------------------------------------------------------

class CreateEventRequest(BaseModel):
    summary: str
    start: str  # ISO datetime
    end: str  # ISO datetime
    description: str = ""
    location: str = ""
    calendar_id: str = "primary"


@router.post("/events")
async def create_event(req: CreateEventRequest):
    """Create a new event on Google Calendar."""
    creds = _get_credentials()
    if not creds or not creds.valid:
        raise HTTPException(status_code=401, detail="Google Calendar not connected")

    service = _build_service(creds)

    event_body: dict = {
        "summary": req.summary,
        "start": {"dateTime": req.start},
        "end": {"dateTime": req.end},
    }
    if req.description:
        event_body["description"] = req.description
    if req.location:
        event_body["location"] = req.location

    created = service.events().insert(
        calendarId=req.calendar_id,
        body=event_body,
    ).execute()

    # Cache the new event locally
    parsed = _parse_gcal_event(created, req.calendar_id)
    cal_db.upsert_events([parsed])

    return {"ok": True, "event_id": created["id"]}
