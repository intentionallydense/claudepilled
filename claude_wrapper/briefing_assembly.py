"""Orchestrates daily briefing: gather data, prompt Claude, store in DB.

Called by the cron CLI (cli_main) or /api/briefing/assemble endpoint.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date

from claude_wrapper.briefing_anki import get_anki_stats
from claude_wrapper.briefing_db import BriefingDatabase
from claude_wrapper.briefing_feeds import (
    check_acx_new_posts,
    fetch_chemistry_news,
    fetch_ft_headlines,
    fetch_physics_news,
    fetch_wikipedia_featured,
)
from claude_wrapper.briefing_sequential import get_long_read, get_todays_item
from claude_wrapper.task_db import TaskDatabase
from claude_wrapper.task_urgency import sort_by_urgency


ASSEMBLY_PROMPT = """You are assembling a morning briefing — a warm, concise daily newsletter.
The reader opens this with coffee. Be conversational but information-dense.
Use markdown formatting (## headers, bullets, links).

Write exactly these sections in order:

## Good morning
A one-line greeting referencing the day of the week and date.

## Headlines
List all FT headlines as bullet points. For each, one sentence on what it means
or why it matters. If the feed is empty, say so briefly.

## Science
Pick the most interesting 2-3 items from the science news. One sentence each,
plus why it matters. Note the source (Nature Chemistry, C&EN, or Nature Physics).
Chemistry and physics alternate by day. Skip if empty.

## Today's Read
Present the long read recommendation with a 2-3 sentence hook explaining
why it's worth reading. Include the link.

## Sequences
Present today's LessWrong Sequences post. Give a one-sentence preview of
what the post argues. Include the link and note the progress (e.g., "Post 42 of 338").

## Album of the Day
Present today's album with artist, year, and a 1-2 sentence description of
what it sounds like and why it's on the list.

## Wikipedia
Present the featured article with a 2-3 sentence summary and the link.

## Anki
If Anki stats are available, give a brief nudge: how many cards are due,
which deck needs attention, and any encouragement based on the numbers.
If Anki isn't running, just say "Anki not connected."

## Tasks
List the top 5 most urgent tasks with their urgency scores. For each,
one line with the title and a brief note on why it's urgent (due date,
priority, age). End with a suggestion for what to tackle first.

Finally, add a brief ## Connections section: find one interesting link between
any two sections above (e.g., a headline that connects to a Sequences concept,
or a chemistry paper that relates to the Wikipedia article). This makes the
briefing feel curated rather than mechanical.

Here is today's data:
"""


def assemble_briefing(
    briefing_db: BriefingDatabase,
    task_db: TaskDatabase,
    client,
    force: bool = False,
) -> dict:
    """Gather sections, call Claude, store in DB. Idempotent unless force=True."""
    today = date.today().isoformat()

    if not force:
        existing = briefing_db.get_briefing_by_date(today)
        if existing is not None:
            return existing

    # Gather all section data
    sections = _gather_sections(briefing_db, task_db)

    # Build the prompt with gathered data
    data_block = json.dumps(sections, indent=2, default=str)
    messages = [{"role": "user", "content": ASSEMBLY_PROMPT + data_block}]

    # Call Claude synchronously — no streaming needed for assembly
    response = client.send(
        messages,
        model="claude-sonnet-4-6",
        system="You are a personal briefing assistant. Be warm and concise.",
        web_search=False,
    )

    # Extract text from response
    assembled_text = ""
    for block in response.content:
        if block.type == "text" and block.text:
            assembled_text += block.text

    return briefing_db.save_briefing(today, sections, assembled_text)


def _gather_sections(briefing_db: BriefingDatabase, task_db: TaskDatabase) -> dict:
    """Collect data from all sources into a structured dict."""
    sections = {}

    # Date context
    today = date.today()
    sections["date"] = today.isoformat()
    sections["day_of_week"] = today.strftime("%A")

    # FT headlines
    sections["ft_headlines"] = fetch_ft_headlines(max_items=10)

    # Science news — chemistry/physics alternate by day-of-year parity
    # (same pattern as Gwern/ACX long read alternation)
    day = today.timetuple().tm_yday
    if day % 2 == 0:
        sections["science_news"] = fetch_chemistry_news(briefing_db, max_items=5)
        sections["science_topic"] = "chemistry"
    else:
        sections["science_news"] = fetch_physics_news(briefing_db, max_items=5)
        sections["science_topic"] = "physics"

    # ACX RSS check (before long read, so we can pass new post)
    acx_new = check_acx_new_posts(briefing_db)
    sections["acx_new_post"] = acx_new

    # Long read (Gwern/ACX alternation)
    sections["long_read"] = get_long_read(briefing_db, acx_new)

    # LessWrong Sequences
    sections["sequences_post"] = get_todays_item("sequences", briefing_db)

    # Album of the day
    sections["album"] = get_todays_item("albums", briefing_db)

    # Wikipedia featured article
    sections["wikipedia"] = fetch_wikipedia_featured(today)

    # Anki stats
    sections["anki"] = get_anki_stats()

    # Task triage
    sections["tasks"] = _get_task_summary(task_db)

    return sections


def _get_task_summary(task_db: TaskDatabase) -> list[dict]:
    """Get the top 5 most urgent open tasks for the briefing.

    Filters to pending/active tasks only — completed tasks aren't actionable.
    """
    tasks = task_db.list_tasks()
    # Only include open tasks — completed ones aren't useful in a morning briefing
    tasks = [t for t in tasks if t.get("status") in ("pending", "active")]
    for t in tasks:
        for field in ("tags", "depends", "annotations"):
            if isinstance(t.get(field), str):
                t[field] = json.loads(t[field])
    sorted_tasks = sort_by_urgency(tasks)
    return [
        {k: t[k] for k in ("title", "urgency", "priority", "due", "status", "project")}
        for t in sorted_tasks[:5]
    ]


def cli_main() -> None:
    """CLI entry point for cron: assemble today's briefing and print it."""
    from dotenv import load_dotenv

    from claude_wrapper.client import ClaudeClient
    from claude_wrapper.db import Database
    from claude_wrapper.briefing_sequential import init_all_series

    load_dotenv()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = ClaudeClient(api_key=api_key)
    db = Database()
    task_db = TaskDatabase(db)
    briefing_db = BriefingDatabase(db)
    init_all_series(briefing_db)

    result = assemble_briefing(briefing_db, task_db, client, force=True)
    print(result["assembled_text"])
