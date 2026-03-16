"""Ingestion pipeline — parse Claude.ai exports and add episodes to the Graphiti graph.

CLI entry point. Processes episodes sequentially (Z.AI rate limits are too strict
for bulk mode) with conversation-level checkpointing so ingestion can be resumed.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import click
from graphiti_core.nodes import EpisodeType
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, MofNCompleteColumn

from .graph import get_client, load_config
from .parser import parse_export

log = logging.getLogger(__name__)
console = Console()

CHECKPOINT_DIR = Path(__file__).resolve().parent.parent / "data" / "checkpoints"


def _load_checkpoint(export_path: str) -> set[str]:
    """Return the set of conversation IDs already ingested."""
    cp_file = CHECKPOINT_DIR / f"{Path(export_path).stem}.json"
    if cp_file.exists():
        data = json.loads(cp_file.read_text())
        return set(data.get("completed_conversations", []))
    return set()


def _save_checkpoint(export_path: str, completed: set[str], stats: dict) -> None:
    """Save ingestion progress."""
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    cp_file = CHECKPOINT_DIR / f"{Path(export_path).stem}.json"
    cp_file.write_text(json.dumps({
        "completed_conversations": sorted(completed),
        "timestamp": datetime.utcnow().isoformat(),
        "stats": stats,
    }, indent=2))


def _group_by_conversation(episodes) -> dict[str, list]:
    """Group episodes by conversation_id, preserving chronological order."""
    groups = defaultdict(list)
    for ep in episodes:
        groups[ep.conversation_id].append(ep)
    return dict(groups)


async def _run_ingestion(
    export_path: str,
    resume: bool = False,
    after: str | None = None,
    dry_run: bool = False,
    config: dict | None = None,
) -> dict:
    """Core ingestion logic — sequential add_episode with conversation checkpointing."""
    if config is None:
        config = load_config()

    episodes = parse_export(export_path, after=after)
    if not episodes:
        console.print("[yellow]No episodes to ingest.[/yellow]")
        return {"total": 0, "ingested": 0, "skipped": 0, "errors": 0}

    conv_groups = _group_by_conversation(episodes)

    completed_convs: set[str] = set()
    if resume:
        completed_convs = _load_checkpoint(export_path)
        if completed_convs:
            console.print(f"[cyan]Resuming: {len(completed_convs)}/{len(conv_groups)} conversations already done[/cyan]")

    remaining = {cid: eps for cid, eps in conv_groups.items() if cid not in completed_convs}
    remaining_episodes = sum(len(eps) for eps in remaining.values())

    if dry_run:
        console.print(f"[cyan]Dry run: {len(episodes)} episodes in {len(conv_groups)} conversations[/cyan]")
        console.print(f"  {len(completed_convs)} done, {len(remaining)} remaining ({remaining_episodes} episodes)")
        for cid, eps in list(remaining.items())[:5]:
            title = eps[0].conversation_title[:50]
            console.print(f"  {title} — {len(eps)} episodes — {eps[0].timestamp[:10]}")
        if len(remaining) > 5:
            console.print(f"  ... and {len(remaining) - 5} more conversations")
        return {"total": len(episodes), "ingested": 0, "skipped": len(episodes) - remaining_episodes, "errors": 0, "dry_run": True}

    client = await get_client(config)
    delay = config.get("episode_delay_seconds", 0.5)

    stats = {
        "total": len(episodes),
        "ingested": len(episodes) - remaining_episodes,
        "skipped": len(episodes) - remaining_episodes,
        "errors": 0,
        "conversations_done": len(completed_convs),
        "conversations_total": len(conv_groups),
    }
    failed_conversations = []

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            console=console,
        ) as progress:
            conv_task = progress.add_task("Conversations", total=len(remaining))

            for conv_id, eps in remaining.items():
                title = eps[0].conversation_title[:50]
                progress.update(conv_task, description=f"[cyan]{title}[/cyan] ({len(eps)} turns)")

                conv_errors = 0
                for i, ep in enumerate(eps):
                    try:
                        await client.add_episode(
                            name=f"turn_{conv_id}_{i}",
                            episode_body=ep.content,
                            reference_time=datetime.fromisoformat(
                                ep.timestamp.replace("Z", "+00:00")
                            ),
                            source_description=f"Claude.ai conversation: {ep.conversation_title}",
                            source=EpisodeType.message,
                            group_id=conv_id,
                        )
                        stats["ingested"] += 1
                    except Exception as exc:
                        log.warning("Failed episode %d in %s: %s", i, title, exc)
                        stats["errors"] += 1
                        conv_errors += 1

                    if delay > 0:
                        await asyncio.sleep(delay)

                if conv_errors == len(eps):
                    # Entire conversation failed — log it
                    failed_conversations.append({
                        "conversation_id": conv_id,
                        "title": eps[0].conversation_title,
                        "episode_count": len(eps),
                    })
                else:
                    # At least some episodes succeeded — mark conversation done
                    completed_convs.add(conv_id)
                    stats["conversations_done"] += 1

                progress.advance(conv_task)
                _save_checkpoint(export_path, completed_convs, stats)

        _save_checkpoint(export_path, completed_convs, stats)

    finally:
        await client.close()

    if failed_conversations:
        fail_path = CHECKPOINT_DIR / f"{Path(export_path).stem}_failed.json"
        fail_path.write_text(json.dumps(failed_conversations, indent=2))
        console.print(f"[yellow]{len(failed_conversations)} failed conversations saved to {fail_path}[/yellow]")

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
    console.print(
        f"[green]Done.[/green] {stats['ingested']} ingested, {stats['errors']} errors, "
        f"{stats['skipped']} skipped — "
        f"{stats.get('conversations_done', '?')}/{stats.get('conversations_total', '?')} conversations"
    )


if __name__ == "__main__":
    main()
