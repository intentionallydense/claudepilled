# Claude Wrapper

A lightweight web UI and API wrapper around the Anthropic Claude API with tool use, conversation management, and a "couch" therapy-style mode.

## Setup

```bash
pip install -e .
cp .env.example .env        # add your ANTHROPIC_API_KEY
claude-wrapper               # starts the server at http://localhost:8000
```

## Features

- **Chat** — streaming conversations with Claude, stored in a local SQLite database
- **Tasks** — urgency-scored task list with brain-dump interview workflow, Claude can create/manage tasks via tool calls
- **The Couch** — a two-model chatroom conversation mode
- **Settings & Prompts** — switch models and edit system prompts from the UI
- **Tool Use** — register custom tools that Claude can call during a conversation

## Adding Custom Tools

See `example_tools.py` for a working example. Define tools with the `@registry.tool` decorator:

```python
from claude_wrapper.tools import ToolRegistry

registry = ToolRegistry()

@registry.tool(description="Get the current time.")
def get_current_time() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
```

Drop your tools file in the project root and it will be loaded automatically on startup.
