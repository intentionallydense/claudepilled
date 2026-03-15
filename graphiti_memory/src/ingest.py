"""Ingestion pipeline — parse Claude.ai exports and add episodes to the Graphiti graph.

CLI entry point. Processes episodes chronologically with checkpointing
so ingestion can be resumed after interruption.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path

import click
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, MofNCompleteColumn

from .graph import get_client, load_config
from .parser import parse_export

log = logging.getLogger(__name__)
console = Console()

CHECKPOINT_DIR = Path(__file__).resolve().parent.parent / "data" / "checkpoints"


def _load_checkpoint(export_path: str) -> int:
    """Return the index of the last successfully ingested episode, or -1."""
    cp_file = CHECKPOINT_DIR / f"{Path(export_path).stem}.json"
    if cp_file.exists():
        data = json.loads(cp_file.read_text())
        return data.get("last_index", -1)
    return -1


def _save_checkpoint(export_path: str, index: int, stats: dict) -> None:
    """Save ingestion progress."""
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    cp_file = CHECKPOINT_DIR / f"{Path(export_path).stem}.json"
    cp_file.write_text(json.dumps({
        "last_index": index,
        "timestamp": datetime.utcnow().isoformat(),
        "stats": stats,
    }, indent=2))


async def _run_ingestion(
    export_path: str,
    resume: bool = False,
    after: str | None = None,
    dry_run: bool = False,
    config: dict | None = None,
) -> dict:
    """Core ingestion logic. Returns stats dict."""
    if config is None:
        config = load_config()

    episodes = parse_export(export_path, after=after)
    if not episodes:
        console.print("[yellow]No episodes to ingest.[/yellow]")
        return {"total": 0, "ingested": 0, "skipped": 0, "errors": 0}

    start_index = 0
    if resume:
        last = _load_checkpoint(export_path)
        if last >= 0:
            start_index = last + 1
            console.print(f"[cyan]Resuming from episode {start_index}/{len(episodes)}[/cyan]")

    if dry_run:
        console.print(f"[cyan]Dry run: {len(episodes)} episodes parsed, {start_index} would be skipped[/cyan]")
        for i, ep in enumerate(episodes[:5]):
            console.print(f"  [{i}] {ep.conversation_title[:50]} — {ep.timestamp[:10]} — {len(ep.content)} chars")
        if len(episodes) > 5:
            console.print(f"  ... and {len(episodes) - 5} more")
        return {"total": len(episodes), "ingested": 0, "skipped": start_index, "errors": 0, "dry_run": True}

    client = await get_client(config)

    delay = config.get("episode_delay_seconds", 0.5)
    checkpoint_interval = config.get("checkpoint_interval", 50)

    stats = {"total": len(episodes), "ingested": 0, "skipped": start_index, "errors": 0}
    failed_episodes = []

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("Ingesting episodes", total=len(episodes) - start_index)

            for i in range(start_index, len(episodes)):
                ep = episodes[i]
                try:
                    await client.add_episode(
                        name=f"turn_{ep.conversation_id}_{i}",
                        episode_body=ep.content,
                        reference_time=datetime.fromisoformat(
                            ep.timestamp.replace("Z", "+00:00")
                        ),
                        source_description=f"Claude.ai conversation: {ep.conversation_title}",
                        source=ep.source,
                    )
                    stats["ingested"] += 1
                except Exception as exc:
                    log.warning("Failed to ingest episode %d: %s", i, exc)
                    stats["errors"] += 1
                    failed_episodes.append({"index": i, "error": str(exc), **ep.to_dict()})

                progress.advance(task)

                # Checkpoint
                if (i - start_index + 1) % checkpoint_interval == 0:
                    _save_checkpoint(export_path, i, stats)

                # Rate limit
                if delay > 0:
                    time.sleep(delay)

        # Final checkpoint
        _save_checkpoint(export_path, len(episodes) - 1, stats)

    finally:
        await client.close()

    # Save failed episodes for retry
    if failed_episodes:
        fail_path = CHECKPOINT_DIR / f"{Path(export_path).stem}_failed.json"
        fail_path.write_text(json.dumps(failed_episodes, indent=2))
        console.print(f"[yellow]{len(failed_episodes)} failed episodes saved to {fail_path}[/yellow]")

    return stats


@click.command()
@click.option("--export-path", required=True, help="Path to conversations.json")
@click.option("--resume", is_flag=True, help="Resume from last checkpoint")
@click.option("--after", default=None, help="Only ingest conversations after this date (ISO format)")
@click.option("--dry-run", is_flag=True, help="Parse only, don't write to graph")
@click.option("--config", "config_path", default="config.yaml", help="Path to config file")
def main(export_path: str, resume: bool, after: str | None, dry_run: bool, config_path: str):
    """Ingest Claude.ai conversation exports into the Graphiti knowledge graph."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    config = load_config(config_path)
    stats = asyncio.run(_run_ingestion(export_path, resume=resume, after=after, dry_run=dry_run, config=config))

    console.print()
    console.print(f"[green]Done.[/green] {stats['ingested']} ingested, {stats['errors']} errors, {stats['skipped']} skipped of {stats['total']} total")


if __name__ == "__main__":
    main()
