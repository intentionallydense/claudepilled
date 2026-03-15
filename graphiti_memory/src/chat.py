"""CLI chat client with Graphiti memory retrieval.

Queries the knowledge graph for relevant context before each turn,
injects it into the system prompt, and ingests new turns into the
graph after each exchange.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime

import anthropic
import click
from dotenv import load_dotenv
from rich.console import Console
from rich.markdown import Markdown

from .graph import get_client, load_config
from .retrieve import retrieve_context

log = logging.getLogger(__name__)
console = Console()


def _build_system_prompt(context: str, user_prefs: str) -> str:
    """Assemble the system prompt with retrieved context and user preferences."""
    parts = [
        "You are Claude, an AI assistant. You have access to memories from "
        "past conversations, provided below. Use this context naturally — don't "
        "announce that you're remembering things unless it's relevant, and don't "
        "force connections. If the context isn't relevant to what's being discussed, "
        "ignore it."
    ]
    if context:
        parts.append(context)
    if user_prefs:
        parts.append(user_prefs)
    return "\n\n".join(parts)


async def _ingest_turn(config: dict, human_text: str, assistant_text: str) -> None:
    """Add the current turn to the graph as a new episode."""
    try:
        client = await get_client(config)
        try:
            await client.add_episode(
                name=f"live_{datetime.utcnow().isoformat()}",
                episode_body=f"Human: {human_text}\n\nAssistant: {assistant_text}",
                reference_time=datetime.utcnow(),
                source_description="Live conversation via silicon CLI",
                source="live_chat",
            )
        finally:
            await client.close()
    except Exception as exc:
        log.debug("Failed to ingest live turn: %s", exc)


async def _chat_loop(
    model: str,
    no_memory: bool,
    show_context: bool,
    config: dict,
) -> None:
    """Main chat loop."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        console.print("[red]ANTHROPIC_API_KEY not set.[/red]")
        return

    client = anthropic.Anthropic(api_key=api_key)
    user_prefs = config.get("user_preferences", "")
    messages = []

    console.print(f"[dim]Model: {model} | Memory: {'off' if no_memory else 'on'}[/dim]")
    console.print("[dim]Type 'quit' or Ctrl-C to exit.[/dim]\n")

    while True:
        try:
            user_input = console.input("[bold]> [/bold]").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]Goodbye.[/dim]")
            break

        if not user_input or user_input.lower() in ("quit", "exit"):
            break

        # Retrieve context
        context = ""
        if not no_memory:
            try:
                context = await retrieve_context(user_input, config=config)
            except Exception as exc:
                log.debug("Memory retrieval failed: %s", exc)

        if show_context and context:
            console.print("[dim]--- Retrieved context ---[/dim]")
            console.print(f"[dim]{context}[/dim]")
            console.print("[dim]--- End context ---[/dim]\n")

        system = _build_system_prompt(context, user_prefs)
        messages.append({"role": "user", "content": user_input})

        # Stream response
        assistant_text = ""
        with client.messages.stream(
            model=model,
            system=system,
            messages=messages,
            max_tokens=4096,
        ) as stream:
            for text in stream.text_stream:
                console.print(text, end="")
                assistant_text += text

        console.print()  # newline after streaming
        messages.append({"role": "assistant", "content": assistant_text})

        # Ingest the turn into the graph (fire and forget)
        if not no_memory:
            asyncio.create_task(_ingest_turn(config, user_input, assistant_text))


@click.command()
@click.option("--model", default=None, help="Claude model to use")
@click.option("--no-memory", is_flag=True, help="Disable memory retrieval")
@click.option("--show-context", is_flag=True, help="Show retrieved context for debugging")
@click.option("--config", "config_path", default="config.yaml", help="Path to config file")
def main(model: str | None, no_memory: bool, show_context: bool, config_path: str):
    """Chat with Claude, enriched by your personal knowledge graph."""
    load_dotenv()
    logging.basicConfig(level=logging.WARNING)

    config = load_config(config_path)
    if model is None:
        model = config.get("chat_model", "claude-sonnet-4-20250514")

    asyncio.run(_chat_loop(model, no_memory, show_context, config))


if __name__ == "__main__":
    main()
