"""Sync conversations from the live SQLite DB into the Neo4j knowledge graph.

Reads from ~/.llm-interface/data.db (the main app's database) and creates
Graphiti episodes for each human+assistant turn pair. Tracks sync state in
data/sync_state.json so only new/updated conversations are processed.

Unlike ingest.py which reads from a static JSON export, this reads directly
from the live database, making it suitable for periodic syncing (cron, etc).

Uses sequential add_episode (not bulk) to avoid OpenRouter rate limits,
with conversation-level checkpointing so syncing can be resumed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import click
from graphiti_core.nodes import EpisodeType
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
)

from .graph import get_client, load_config

log = logging.getLogger(__name__)
console = Console()

# Sync state tracks {conversation_id: message_count} so we can detect new messages
SYNC_STATE_PATH = Path(__file__).resolve().parent.parent / "data" / "sync_state.json"

# Default SQLite DB path (same as llm_interface.db)
DEFAULT_DB_PATH = Path.home() / ".llm-interface" / "data.db"


def _load_sync_state() -> dict[str, int]:
    """Load the sync state mapping conversation_id -> last synced message count."""
    if SYNC_STATE_PATH.exists():
        return json.loads(SYNC_STATE_PATH.read_text())
    return {}


def _save_sync_state(state: dict[str, int]) -> None:
    """Save the sync state to disk."""
    SYNC_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SYNC_STATE_PATH.write_text(json.dumps(state, indent=2))


def _connect_sqlite(db_path: str | Path) -> sqlite3.Connection:
    """Open a read-only connection to the app's SQLite DB."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _extract_text_from_content(content_json: str) -> str:
    """Extract plain text from a message's JSON content column.

    The content column stores either:
    - {"type": "text", "value": "..."} (simple text)
    - [{"type": "text", "text": "..."}, ...] (content blocks array)

    Only text blocks are extracted; tool_use/tool_result/thinking/image are stripped.
    Same logic as parser.py's _extract_text but adapted for SQLite storage format.
    """
    try:
        raw = json.loads(content_json)
    except (json.JSONDecodeError, TypeError):
        return str(content_json).strip()

    if isinstance(raw, dict) and raw.get("type") == "text":
        return raw.get("value", "").strip()

    if isinstance(raw, list):
        parts = []
        for block in raw:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts)

    return str(raw).strip()


def _get_conversations(
    conn: sqlite3.Connection, after: str | None = None
) -> list[dict]:
    """Fetch conversations from SQLite, optionally filtered by date."""
    query = """
        SELECT id, title, created_at, updated_at
        FROM conversations
        WHERE COALESCE(type, 'chat') IN ('chat', 'backrooms')
        ORDER BY created_at
    """
    rows = conn.execute(query).fetchall()
    conversations = [dict(r) for r in rows]

    if after:
        try:
            after_dt = datetime.fromisoformat(after.replace("Z", "+00:00"))
            if after_dt.tzinfo is None:
                after_dt = after_dt.replace(tzinfo=timezone.utc)
            filtered = []
            for conv in conversations:
                conv_date = conv.get("created_at", "")
                if conv_date:
                    try:
                        dt = datetime.fromisoformat(conv_date.replace("Z", "+00:00"))
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        if dt >= after_dt:
                            filtered.append(conv)
                    except ValueError:
                        filtered.append(conv)
                else:
                    filtered.append(conv)
            conversations = filtered
        except ValueError:
            log.warning("Invalid --after date: %s, ignoring filter", after)

    return conversations


def _get_messages(conn: sqlite3.Connection, conversation_id: str) -> list[dict]:
    """Fetch messages for a conversation, ordered chronologically."""
    rows = conn.execute(
        "SELECT id, role, content, created_at FROM messages "
        "WHERE conversation_id = ? ORDER BY created_at",
        (conversation_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _build_episodes(
    conversation_id: str,
    title: str,
    messages: list[dict],
) -> list[dict]:
    """Build episodes (human+assistant turn pairs) from message rows.

    Same pairing logic as parser.py's _parse_conversation: find a human message,
    then collect all following assistant messages until the next human message.
    """
    episodes = []
    i = 0

    while i < len(messages):
        msg = messages[i]

        if msg["role"] != "user":
            i += 1
            continue

        human_text = _extract_text_from_content(msg["content"])
        human_ts = msg["created_at"]

        # Collect following assistant messages
        assistant_parts = []
        j = i + 1
        while j < len(messages) and messages[j]["role"] != "user":
            if messages[j]["role"] == "assistant":
                text = _extract_text_from_content(messages[j]["content"])
                if text:
                    assistant_parts.append(text)
            j += 1

        assistant_text = "\n".join(assistant_parts)

        if human_text or assistant_text:
            combined = f"Human: {human_text}\n\nAssistant: {assistant_text}"
            # Truncate very long messages to keep entity extraction manageable
            if len(combined) > 15000:
                combined = combined[:15000] + "\n[truncated]"

            episodes.append({
                "content": combined,
                "timestamp": human_ts,
                "conversation_id": conversation_id,
                "conversation_title": title,
            })

        i = j

    return episodes


async def _run_sync(
    db_path: str,
    after: str | None = None,
    dry_run: bool = False,
    config: dict | None = None,
) -> dict:
    """Core sync logic — read from SQLite, write episodes to Graphiti."""
    if config is None:
        config = load_config()

    db_file = Path(db_path)
    if not db_file.exists():
        console.print(f"[red]Database not found: {db_file}[/red]")
        return {"total": 0, "ingested": 0, "skipped": 0, "errors": 0}

    conn = _connect_sqlite(db_file)
    conversations = _get_conversations(conn, after=after)

    if not conversations:
        conn.close()
        console.print("[yellow]No conversations found.[/yellow]")
        return {"total": 0, "ingested": 0, "skipped": 0, "errors": 0}

    sync_state = _load_sync_state()

    # Build episodes for conversations that have new messages
    to_sync: list[tuple[str, str, list[dict]]] = []  # (conv_id, title, episodes)
    total_episodes = 0
    skipped_up_to_date = 0

    for conv in conversations:
        conv_id = conv["id"]
        title = conv.get("title", "(untitled)") or "(untitled)"
        messages = _get_messages(conn, conv_id)
        msg_count = len(messages)

        # Skip if message count hasn't changed since last sync
        if conv_id in sync_state and sync_state[conv_id] >= msg_count:
            skipped_up_to_date += 1
            continue

        # Skip conversations with fewer than 2 messages (need at least one turn)
        if msg_count < 2:
            continue

        episodes = _build_episodes(conv_id, title, messages)
        if episodes:
            to_sync.append((conv_id, title, episodes))
            total_episodes += len(episodes)

    conn.close()

    if not to_sync:
        console.print(
            f"[green]All caught up.[/green] "
            f"{skipped_up_to_date} conversations already synced, 0 new."
        )
        return {
            "total": 0,
            "ingested": 0,
            "skipped": skipped_up_to_date,
            "errors": 0,
        }

    if dry_run:
        console.print(
            f"[cyan]Dry run:[/cyan] {total_episodes} episodes in "
            f"{len(to_sync)} conversations to sync"
        )
        console.print(
            f"  {skipped_up_to_date} already synced, "
            f"{len(to_sync)} new/updated"
        )
        for conv_id, title, eps in to_sync[:10]:
            console.print(f"  {title[:50]} — {len(eps)} episodes")
        if len(to_sync) > 10:
            console.print(f"  ... and {len(to_sync) - 10} more")
        return {
            "total": total_episodes,
            "ingested": 0,
            "skipped": skipped_up_to_date,
            "errors": 0,
            "dry_run": True,
        }

    client = await get_client(config)
    delay = config.get("episode_delay_seconds", 0.5)

    stats = {
        "total": total_episodes,
        "ingested": 0,
        "skipped": skipped_up_to_date,
        "errors": 0,
        "conversations_synced": 0,
        "conversations_total": len(to_sync),
    }

    try:
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            console=console,
        ) as progress:
            conv_task = progress.add_task("Syncing", total=len(to_sync))

            # Re-open SQLite to get message counts for state tracking
            conn = _connect_sqlite(db_path)

            for conv_id, title, episodes in to_sync:
                progress.update(
                    conv_task,
                    description=f"[cyan]{title[:50]}[/cyan] ({len(episodes)} turns)",
                )

                conv_errors = 0
                for i, ep in enumerate(episodes):
                    try:
                        await client.add_episode(
                            name=f"turn_{conv_id}_{i}",
                            episode_body=ep["content"],
                            reference_time=datetime.fromisoformat(
                                ep["timestamp"].replace("Z", "+00:00")
                            ),
                            source_description=f"Chat conversation: {ep['conversation_title']}",
                            source=EpisodeType.message,
                            group_id=conv_id,
                        )
                        stats["ingested"] += 1
                    except Exception as exc:
                        log.warning(
                            "Failed episode %d in %s: %s", i, title[:50], exc
                        )
                        stats["errors"] += 1
                        conv_errors += 1

                    if delay > 0:
                        await asyncio.sleep(delay)

                if conv_errors < len(episodes):
                    # At least some episodes succeeded — update sync state
                    msg_count = len(_get_messages(conn, conv_id))
                    sync_state[conv_id] = msg_count
                    stats["conversations_synced"] += 1

                progress.advance(conv_task)
                # Checkpoint after each conversation
                _save_sync_state(sync_state)

            conn.close()

        _save_sync_state(sync_state)

    finally:
        await client.close()

    return stats


@click.command()
@click.option(
    "--db-path",
    default=str(DEFAULT_DB_PATH),
    help="Path to the llm-interface SQLite database",
)
@click.option(
    "--after",
    default="2026-01-01",
    help="Only sync conversations created after this date (ISO format)",
)
@click.option("--dry-run", is_flag=True, help="Show what would be synced without writing")
@click.option(
    "--config",
    "config_path",
    default="config.yaml",
    help="Path to graphiti_memory config file",
)
def main(db_path: str, after: str | None, dry_run: bool, config_path: str):
    """Sync conversations from the live SQLite DB into the Graphiti knowledge graph."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    config = load_config(config_path)
    stats = asyncio.run(
        _run_sync(db_path, after=after, dry_run=dry_run, config=config)
    )

    console.print()
    console.print(
        f"[green]Done.[/green] {stats['ingested']} ingested, "
        f"{stats['errors']} errors, {stats['skipped']} skipped — "
        f"{stats.get('conversations_synced', '?')}/{stats.get('conversations_total', '?')} conversations"
    )


if __name__ == "__main__":
    main()
