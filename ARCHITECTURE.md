# Architecture

Claude Wrapper is a personal web UI and API wrapper around the Anthropic Claude API. It provides streaming chat with tool use, a two-model "couch" conversation mode, conversation branching, and a task management system — all backed by SQLite and served via FastAPI.

## File Map

### Python Package (`claude_wrapper/`)

| File | Purpose |
|------|---------|
| `__init__.py` | Package exports: `ClaudeClient`, `ToolRegistry`, `ConversationManager`, `CouchOrchestrator` |
| `client.py` | Core Anthropic API client — sync `send()` and async `stream()`, retry logic, request building |
| `models.py` | Pydantic data models: `Message`, `Conversation`, `ContentBlock`, `StreamEvent`, `ToolDefinition`, model catalog/pricing |
| `tools.py` | `ToolRegistry` — decorator-based tool registration, JSON schema generation from type hints, tool execution |
| `conversation.py` | `ConversationManager` — orchestrates chat turns, tool loops, streaming, message branching, auto-titling |
| `couch.py` | `CouchOrchestrator` — two-model chatroom with role-flipping, turn pacing, [ready] signaling |
| `db.py` | SQLite persistence — conversations, messages (tree-structured), settings, prompts library |
| `server.py` | FastAPI app — REST endpoints, WebSocket streaming, static file serving, startup wiring |
| `task_db.py` | `TaskDatabase` — CRUD for the `tasks` table, recurrence handling, annotations |
| `task_urgency.py` | Urgency scoring — computes dynamic scores at render time using priority, due date, age, status |
| `task_routes.py` | FastAPI `APIRouter` for `/api/tasks/*` endpoints, mounted by server.py |
| `task_tools.py` | Claude tool definitions for task management (task_create, task_complete, etc.) + brain-dump prompt |

### Frontend (`static/`)

| File | Purpose |
|------|---------|
| `index.html` | Main chat page — sidebar, message area, tree panel |
| `app.js` | Chat UI logic — WebSocket management, message rendering, branching |
| `style.css` | Chat page styles — monospace/minimal aesthetic |
| `settings.html/js/css` | Settings page — model defaults, system prompt, prompt library |
| `couch.html/js/css` | Couch page — two-model conversation UI |
| `tasks.html/js/css` | Task list page — urgency-sorted list, inline CRUD, brain-dump launcher |

### Root

| File | Purpose |
|------|---------|
| `pyproject.toml` | Package config, dependencies, entry point (`claude-wrapper` CLI) |
| `example_tools.py` | Sample tool definitions (get_current_time, calculate) |
| `.env` / `.env.example` | API key configuration |

## Key Decisions

- **Flat package layout** (not src-layout) — simpler for a personal project. Required explicit `packages = ["claude_wrapper"]` in pyproject.toml because setuptools auto-discovery picks up `static/`.
- **SQLite with WAL mode** — single-file DB at `~/.claude-wrapper/data.db`. Good enough for single-user, easy to back up.
- **Tree-structured messages** — each message has a `parent_id`, enabling conversation branching and branch switching. The `current_leaf_id` on a conversation tracks which branch is active.
- **Idempotent migrations** — schema changes are applied via `ALTER TABLE ... ADD COLUMN` wrapped in try/except. No migration framework.
- **Tool auto-discovery** — `example_tools.py` is loaded by filename from the project root at startup. Any file exporting a `ToolRegistry` named `registry` works.
- **Streaming via WebSocket** — the chat and couch pages use persistent WebSocket connections. Events are typed (`StreamEvent`) and serialized as JSON.
- **Couch role-flipping** — each model sees the other's messages as "user" role with a label prefix. Messages are merged to ensure strict role alternation per API requirements.
- **Task urgency scores** — computed at query time, not stored. Formula combines priority, due-date proximity, age, active status, blocked/waiting penalties. Coefficients are tunable in `task_urgency.py`.
- **Two-layer prompt system** — "universal prompt" (a global setting, always prepended) + per-conversation "saved prompt" (selected via dropdown, stored as `prompt_id` on the conversation). The effective system prompt is composed at call time: `universal_prompt + saved_prompt`. Legacy conversations with a baked-in `system_prompt` but no `prompt_id` fall back to that field.
- **Task tools as Claude functions** — task CRUD is exposed as tool calls so Claude can manage tasks during conversations. The brain-dump flow creates a conversation with the seeded "Brain dump" saved prompt selected, which guides Claude to interview the user and call `task_create`.
- **Soft deletes for tasks** — tasks are never removed from the DB, only set to `status = 'deleted'`. History is preserved.

## Data Flow

```
Browser ─── WebSocket ──→ server.py ──→ ConversationManager ──→ ClaudeClient ──→ Anthropic API
                                              │                        │
                                              ▼                        ▼
                                          ToolRegistry            streaming events
                                              │                        │
                                              ▼                        ▼
                                           Database ◄──────── messages saved
                                          (SQLite)
```

Settings and prompts flow through REST endpoints → Database.
The couch uses the same Database and ClaudeClient but bypasses ConversationManager, using its own turn orchestration.
