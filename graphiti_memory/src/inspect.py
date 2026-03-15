"""Graph inspection tools — utilities for understanding and debugging the knowledge graph.

CLI entry point with subcommands: stats, search, entity, timeline, hubs.
"""

from __future__ import annotations

import asyncio
import logging

import click
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

from .graph import get_client, load_config
from .formatting import format_context

log = logging.getLogger(__name__)
console = Console()


async def _get_stats(config: dict) -> None:
    """Show graph statistics."""
    client = await get_client(config)
    try:
        driver = client.driver
        records, _, _ = await driver.execute_query(
            "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt ORDER BY cnt DESC"
        )
        table = Table(title="Graph Statistics")
        table.add_column("Node Type", style="cyan")
        table.add_column("Count", style="green", justify="right")
        total = 0
        for rec in records:
            table.add_row(rec["label"], str(rec["cnt"]))
            total += rec["cnt"]
        table.add_row("TOTAL", str(total), style="bold")
        console.print(table)

        # Relationship count
        records2, _, _ = await driver.execute_query(
            "MATCH ()-[r]->() RETURN type(r) AS rtype, count(r) AS cnt ORDER BY cnt DESC"
        )
        if records2:
            table2 = Table(title="Relationships")
            table2.add_column("Type", style="cyan")
            table2.add_column("Count", style="green", justify="right")
            for rec in records2:
                table2.add_row(rec["rtype"], str(rec["cnt"]))
            console.print(table2)
    finally:
        await client.close()


async def _search_graph(query: str, config: dict) -> None:
    """Search the graph and display results."""
    client = await get_client(config)
    try:
        result = await client.search(query=query, num_results=10)
        edges = result if isinstance(result, list) else getattr(result, "edges", [])
        nodes = [] if isinstance(result, list) else getattr(result, "nodes", [])
        episodes = [] if isinstance(result, list) else getattr(result, "episodes", [])

        context = format_context(nodes, edges, episodes, max_tokens=3000)
        if context:
            console.print(context)
        else:
            console.print("[yellow]No results found.[/yellow]")
    finally:
        await client.close()


async def _show_entity(name: str, config: dict) -> None:
    """Show all information about a specific entity."""
    client = await get_client(config)
    try:
        driver = client.driver
        records, _, _ = await driver.execute_query(
            """
            MATCH (n) WHERE toLower(n.name) CONTAINS toLower($name)
            OPTIONAL MATCH (n)-[r]-(m)
            RETURN n, collect(DISTINCT {rel: type(r), fact: r.fact, target: m.name}) AS rels
            LIMIT 5
            """,
            name=name,
        )
        if not records:
            console.print(f"[yellow]No entity found matching '{name}'[/yellow]")
            return

        for rec in records:
            node = rec["n"]
            console.print(f"\n[bold cyan]{node.get('name', '?')}[/bold cyan]")
            if node.get("summary"):
                console.print(f"  {node['summary']}")

            rels = rec["rels"]
            if rels:
                console.print("\n  [bold]Relationships:[/bold]")
                for r in rels:
                    if r.get("fact"):
                        console.print(f"    - {r['fact']}")
                    elif r.get("target"):
                        console.print(f"    - [{r.get('rel', '?')}] → {r['target']}")
    finally:
        await client.close()


async def _show_hubs(top: int, config: dict) -> None:
    """Show the most connected entities."""
    client = await get_client(config)
    try:
        driver = client.driver
        records, _, _ = await driver.execute_query(
            """
            MATCH (n)-[r]-()
            WITH n, count(r) AS degree
            RETURN n.name AS name, labels(n)[0] AS label, degree
            ORDER BY degree DESC
            LIMIT $top
            """,
            top=top,
        )
        table = Table(title=f"Top {top} Most Connected Entities")
        table.add_column("Entity", style="cyan")
        table.add_column("Type", style="dim")
        table.add_column("Connections", style="green", justify="right")
        for rec in records:
            table.add_row(rec["name"] or "?", rec["label"] or "?", str(rec["degree"]))
        console.print(table)
    finally:
        await client.close()


async def _show_timeline(topic: str, config: dict) -> None:
    """Show temporal history of a topic."""
    client = await get_client(config)
    try:
        driver = client.driver
        records, _, _ = await driver.execute_query(
            """
            MATCH (n)-[r]->(m)
            WHERE toLower(r.fact) CONTAINS toLower($topic)
               OR toLower(n.name) CONTAINS toLower($topic)
               OR toLower(m.name) CONTAINS toLower($topic)
            RETURN r.fact AS fact, r.created_at AS created
            ORDER BY r.created_at
            LIMIT 30
            """,
            topic=topic,
        )
        if not records:
            console.print(f"[yellow]No timeline entries for '{topic}'[/yellow]")
            return

        console.print(f"\n[bold]Timeline: {topic}[/bold]\n")
        for rec in records:
            date = rec.get("created", "?")
            if isinstance(date, str) and len(date) > 10:
                date = date[:10]
            console.print(f"  [{date}] {rec.get('fact', '?')}")
    finally:
        await client.close()


@click.group()
def main():
    """Inspect the Graphiti knowledge graph."""
    load_dotenv()
    logging.basicConfig(level=logging.WARNING)


@main.command()
@click.option("--config", "config_path", default="config.yaml")
def stats(config_path: str):
    """Show graph statistics."""
    asyncio.run(_get_stats(load_config(config_path)))


@main.command()
@click.argument("query")
@click.option("--config", "config_path", default="config.yaml")
def search(query: str, config_path: str):
    """Search the graph."""
    asyncio.run(_search_graph(query, load_config(config_path)))


@main.command()
@click.argument("name")
@click.option("--config", "config_path", default="config.yaml")
def entity(name: str, config_path: str):
    """Show all information about an entity."""
    asyncio.run(_show_entity(name, load_config(config_path)))


@main.command()
@click.argument("topic")
@click.option("--config", "config_path", default="config.yaml")
def timeline(topic: str, config_path: str):
    """Show temporal history of a topic."""
    asyncio.run(_show_timeline(topic, load_config(config_path)))


@main.command()
@click.option("--top", default=20, help="Number of top entities to show")
@click.option("--config", "config_path", default="config.yaml")
def hubs(top: int, config_path: str):
    """Show the most connected entities (hubs)."""
    asyncio.run(_show_hubs(top, load_config(config_path)))


if __name__ == "__main__":
    main()
