# LLM Interface

A multi-provider LLM web interface with streaming chat, tool use, conversation management, and an N-model "backrooms" conversation mode.

Supports Anthropic Claude, OpenAI GPT, Google Gemini, DeepSeek, Qwen, Kimi, and any model via OpenRouter.

## Setup

```bash
pip install -e .
cp .env.example .env        # add your API keys
llm-interface               # starts the server at http://localhost:8000
```

## Features

- **Chat** — streaming conversations with any supported LLM, stored in a local SQLite database
- **Backrooms** — N-model (2-5) chatroom with round-robin turns, role-flipping, and AI self-modification commands
- **Tasks** — urgency-scored task list with brain-dump interview workflow, LLM can create/manage tasks via tool calls
- **Briefing** — daily briefing assembled from RSS feeds, reading lists, and calendar
- **Settings & Prompts** — switch models and edit system prompts from the UI
- **Tool Use** — register custom tools that models can call during a conversation

## Adding Custom Tools

See `example_tools.py` for a working example. Define tools with the `@registry.tool` decorator:

```python
from llm_interface.tools import ToolRegistry

registry = ToolRegistry()

@registry.tool(description="Get the current time.")
def get_current_time() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
```

Drop your tools file in the project root and it will be loaded automatically on startup.
