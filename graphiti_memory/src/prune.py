"""Prune stale memories — remove old, low-connectivity episodes from the graph.

Targets episodes whose reference_time is older than a threshold and whose
entities have few connections (orphan facts). This keeps the graph focused
on recent and well-connected knowledge.

Doesn't touch entities/edges directly — removing an episode via Graphiti's
remove_episode() handles cleanup of orphaned nodes automatically.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta

import click
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, MofNCompleteColumn

from .graph import get_client, load_config

log = logging.getLogger(__name__)
console = Console()


async def _run_prune(
    max_age_days: int,
    min_entity_edges: int,
    dry_run: bool,
    config: dict,
) -> dict:
    """Remove old, low-connectivity episodes from the graph.

    An episode is pruned if:
      1. Its reference_time is older than max_age_days ago
      2. The entities it introduced have fewer than min_entity_edges connections

    The second check prevents pruning episodes that established important,
    well-connected entities — even if old, those are still load-bearing.
    """
    client = await get_client(config)

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    console.print(f"[cyan]Pruning episodes older than {cutoff.date()} "
                  f"with entities having < {min_entity_edges} edges[/cyan]")

    try:
        # Find old episodes via direct Neo4j query
        driver = client.driver

        # Step 1: find candidate episodes by age
        query = """
            MATCH (e:Episodic)
            WHERE e.valid_at < $cutoff
            RETURN e.uuid AS uuid,
                   e.name AS name,
                   e.valid_at AS valid_at,
                   e.source_description AS source_description,
                   left(e.content, 100) AS preview
            ORDER BY e.valid_at ASC
        """
        records, _, _ = driver.execute_query(
            query,
            parameters_={"cutoff": cutoff.isoformat()},
        )

        candidates = [dict(r) for r in records]
        console.print(f"  Found {len(candidates)} episodes older than {max_age_days} days")

        if not candidates:
            return {"checked": 0, "pruned": 0, "kept": 0}

        # Step 2: for each candidate, check if its entities are well-connected
        # An episode is "safe to prune" if none of its entities have many edges
        to_prune = []
        to_keep = []

        for ep in candidates:
            edge_count_query = """
                MATCH (e:Episodic {uuid: $uuid})-[:MENTIONS]->(entity:Entity)
                OPTIONAL MATCH (entity)-[r:RELATES_TO]-()
                WITH e, entity, count(r) AS edge_count
                RETURN max(edge_count) AS max_edges
            """
            result, _, _ = driver.execute_query(
                edge_count_query,
                parameters_={"uuid": ep["uuid"]},
            )

            max_edges = 0
            if result and result[0]["max_edges"] is not None:
                max_edges = result[0]["max_edges"]

            if max_edges < min_entity_edges:
                to_prune.append(ep)
            else:
                to_keep.append(ep)

        console.print(f"  {len(to_prune)} episodes are low-connectivity (will prune)")
        console.print(f"  {len(to_keep)} episodes have well-connected entities (keeping)")

        if dry_run:
            console.print("\n[cyan]Dry run — would prune:[/cyan]")
            for ep in to_prune[:10]:
                date = str(ep.get("valid_at", ""))[:10]
                preview = (ep.get("preview") or ep.get("name") or ep["uuid"])[:60]
                console.print(f"  {date} — {preview}")
            if len(to_prune) > 10:
                console.print(f"  ... and {len(to_prune) - 10} more")
            return {"checked": len(candidates), "pruned": 0, "kept": len(candidates), "dry_run": True}

        # Step 3: prune
        pruned = 0
        errors = 0
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            MofNCompleteColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("Pruning", total=len(to_prune))
            for ep in to_prune:
                try:
                    await client.remove_episode(ep["uuid"])
                    pruned += 1
                except Exception as exc:
                    log.warning("Failed to prune %s: %s", ep["uuid"], exc)
                    errors += 1
                progress.advance(task)

        return {"checked": len(candidates), "pruned": pruned, "kept": len(to_keep), "errors": errors}

    finally:
        await client.close()


@click.command()
@click.option("--max-age-days", default=180, help="Prune episodes older than this many days")
@click.option("--min-entity-edges", default=3, help="Keep episodes whose entities have at least this many edges")
@click.option("--dry-run", is_flag=True, help="Show what would be pruned without removing")
@click.option("--config", "config_path", default="config.yaml", help="Path to config file")
def main(max_age_days: int, min_entity_edges: int, dry_run: bool, config_path: str):
    """Prune old, low-connectivity memories from the knowledge graph."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    config = load_config(config_path)
    stats = asyncio.run(_run_prune(max_age_days, min_entity_edges, dry_run, config))

    console.print()
    if stats.get("dry_run"):
        console.print(f"[cyan]Dry run:[/cyan] would prune {stats['checked'] - stats['kept']} of {stats['checked']} old episodes")
    else:
        console.print(f"[green]Done.[/green] Pruned {stats['pruned']}, kept {stats['kept']} of {stats['checked']} old episodes")
        if stats.get("errors"):
            console.print(f"[yellow]{stats['errors']} errors during pruning[/yellow]")


if __name__ == "__main__":
    main()
