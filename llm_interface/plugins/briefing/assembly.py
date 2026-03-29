"""Briefing assembly — delegates to the standalone `briefing` package.

The standalone `briefing` package handles all data gathering (RSS feeds,
reading lists, Wikipedia, Anki), LLM/template rendering, and file output.
This module calls its Python API directly, then copies the result into the
wrapper's own DB so the UI can serve it.

Called by the cron CLI (cli_main) or /api/briefing/assemble endpoint.
"""

from __future__ import annotations

import logging
from datetime import date

from .db import BriefingDatabase as WrapperBriefingDB

log = logging.getLogger(__name__)


def assemble_briefing(
    wrapper_db: WrapperBriefingDB,
    force: bool = False,
) -> dict:
    """Run the standalone briefing assembler and import the result.

    Calls briefing.assembly.assemble_briefing() which gathers data,
    renders markdown, writes to ~/.briefing/briefings/{date}.md, and
    updates the standalone DB. We then read the output and store it in
    the wrapper's DB for the UI to serve.
    """
    today = date.today().isoformat()

    if not force:
        existing = wrapper_db.get_briefing_by_date(today)
        if existing is not None:
            return existing

    # Import and run the standalone assembler
    from briefing.config import load_config
    from briefing.assembly import assemble_briefing as standalone_assemble
    from briefing.db import BriefingDatabase as StandaloneBriefingDB
    from briefing.sequential import init_all_series

    config = load_config()
    standalone_db = StandaloneBriefingDB(str(config.state_dir / "state.db"))

    # Seed reading progress DB for all configured sequences (idempotent).
    # Without this, get_todays_item() returns None for every sequence.
    init_all_series(config.sequences, standalone_db)

    try:
        output_path = standalone_assemble(standalone_db, config, force=True)
        assembled_text = output_path.read_text(encoding="utf-8")

        # Pull sections and model from the standalone DB
        standalone_record = standalone_db.get_briefing_by_date(today)
        model = standalone_record.get("model", "unknown") if standalone_record else "unknown"
        sections = standalone_record.get("sections", {}) if standalone_record else {}

    except Exception as e:
        log.warning("Standalone briefing assembly failed: %s", e)
        assembled_text = (
            f"## Good morning\n\n"
            f"Briefing assembly failed for {today}.\n\n"
            f"Error: {e}"
        )
        model = "error"
        sections = {}

    return wrapper_db.save_briefing(today, sections, assembled_text, model=model)


def cli_main() -> None:
    """CLI entry point: assemble today's briefing and print it."""
    from llm_interface.db import Database

    db = Database()
    wrapper_db = WrapperBriefingDB(db.db_path)

    result = assemble_briefing(wrapper_db, force=True)
    print(result["assembled_text"])
