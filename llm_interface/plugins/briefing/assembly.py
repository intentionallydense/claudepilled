"""Reads daily briefings assembled by the standalone briefing project.

The standalone project handles feed fetching, reading list management,
LLM assembly, and writes markdown files to ~/.briefing/briefings/YYYY-MM-DD.md.
This module just reads those files and stores them in the wrapper's DB
for the UI to serve.

If the standalone project hasn't assembled today's briefing, the
/api/briefing/assemble endpoint will shell out to `briefing assemble`
to trigger it.

Called by the cron CLI (cli_main) or /api/briefing/assemble endpoint.
"""

from __future__ import annotations

import logging
import subprocess
from datetime import date
from pathlib import Path

from .db import BriefingDatabase

log = logging.getLogger(__name__)

# Where the standalone briefing project writes its output
_BRIEFING_DIR = Path.home() / ".briefing" / "briefings"


def assemble_briefing(
    briefing_db: BriefingDatabase,
    force: bool = False,
) -> dict:
    """Read today's briefing from the standalone project, store in wrapper DB.

    If the .md file doesn't exist yet, shells out to `briefing assemble`
    to trigger the standalone assembler.
    """
    today = date.today().isoformat()

    if not force:
        existing = briefing_db.get_briefing_by_date(today)
        if existing is not None:
            return existing

    md_path = _BRIEFING_DIR / f"{today}.md"

    # If no file yet, try to trigger the standalone assembler
    if not md_path.exists():
        log.info("No briefing file at %s — running 'briefing assemble'", md_path)
        try:
            subprocess.run(
                ["briefing", "assemble"],
                check=True,
                timeout=120,
                capture_output=True,
            )
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
            log.warning("Failed to run standalone briefing assembler: %s", e)

    # Read the file (may now exist after the subprocess call)
    if md_path.exists():
        assembled_text = md_path.read_text(encoding="utf-8")
        model = "standalone"
    else:
        assembled_text = f"## Good morning\n\nNo briefing available for {today}.\n\nRun `briefing assemble` to generate one."
        model = "none"

    return briefing_db.save_briefing(today, {}, assembled_text, model=model)


def cli_main() -> None:
    """CLI entry point: read today's briefing and print it.

    Triggers standalone assembly if needed.
    """
    from llm_interface.db import Database

    db = Database()
    briefing_db = BriefingDatabase(db.db_path)

    result = assemble_briefing(briefing_db, force=True)
    print(result["assembled_text"])
