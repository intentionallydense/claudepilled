# Architecture

Claude Wrapper is a personal web UI and API wrapper around the Anthropic Claude API. It provides streaming chat with tool use, a two-model "couch" conversation mode, conversation branching, file context injection via tags, and a task management system — all backed by SQLite and served via FastAPI.

## File Map

### Python Package (`claude_wrapper/`)

| File | Purpose |
|------|---------|
| `__init__.py` | Package exports: `ClaudeClient`, `ToolRegistry`, `ConversationManager`, `CouchOrchestrator` |
| `client.py` | Core Anthropic API client — sync `send()` and async `stream()`, retry logic, request building |
| `models.py` | Pydantic data models: `Message`, `Conversation`, `ContentBlock`, `StreamEvent`, `ToolDefinition`, model catalog/pricing |
| `tools.py` | `ToolRegistry` — decorator-based tool registration, JSON schema generation from type hints, tool execution. Supports schema refreshers for dynamic descriptions |
| `conversation.py` | `ConversationManager` — orchestrates chat turns, tool loops, streaming, message branching, auto-titling |
| `couch.py` | `CouchOrchestrator` — two-model chatroom with role-flipping, turn pacing, [ready] signaling |
| `db.py` | SQLite persistence — conversations, messages (tree-structured), settings, prompts library |
| `server.py` | FastAPI app — REST endpoints, WebSocket streaming, static file serving, startup wiring |
| `task_db.py` | `TaskDatabase` — CRUD for the `tasks` table, recurrence handling, annotations |
| `task_urgency.py` | Urgency scoring — computes dynamic scores at render time using priority, due date, age, status |
| `task_routes.py` | FastAPI `APIRouter` for `/api/tasks/*` endpoints, mounted by server.py |
| `task_tools.py` | Claude tool definitions for task management (task_create, task_complete, etc.) + brain-dump prompt. Registers a schema refresher that injects current projects/tags into tool descriptions |
| `briefing_db.py` | `BriefingDatabase` — 3 tables: briefings, reading_progress, shown_posts |
| `briefing_feeds.py` | RSS fetching (FT, C&EN, Nature Chem, Nature Physics, ACX) + Wikipedia featured article API. Nature Chem/Physics deduped via shown_posts |
| `briefing_sequential.py` | Reading list pointer management — advances one item/day per series |
| `briefing_anki.py` | AnkiConnect proxy — pulls review stats, graceful fallback when Anki offline |
| `briefing_assembly.py` | Orchestrates data gathering + Claude prompt + DB storage. CLI entry point for cron |
| `briefing_routes.py` | FastAPI routers for `/api/briefing/*` (list, get, assemble, chat), `/api/reading-progress/*`, `/api/anki/*` |
| `file_db.py` | `FileDatabase` — CRUD for uploaded files, per-conversation active file context, tag normalization |
| `file_routes.py` | FastAPI `APIRouter` for `/api/files/*` endpoints — upload (PDF/MD), tag management, context activation |
| `pin_db.py` | `PinDatabase` — CRUD for the `pins` table (moodboard). Images stored as data URIs |
| `pin_routes.py` | FastAPI `APIRouter` for `/api/pins/*` endpoints — list, create, upload image, delete |
| `pin_tools.py` | Claude tool definitions for moodboard (moodboard_pin, moodboard_remove) |

### Frontend (`static/`)

| File | Purpose |
|------|---------|
| `index.html` | Main chat page — 4-column layout: sidebar, chat, tree, moodboard |
| `chat-core.js` | Shared chat module — `createChatCore(config)` factory encapsulating WebSocket streaming, message rendering, tree nav, edit UX, cost display. Used by both `app.js` and `briefing.js` |
| `app.js` | Chat page logic — sidebar/conversations, moodboard, file modal, tag autocomplete, context bar. Delegates all chat behavior to `chat-core.js` |
| `style.css` | Shared layout styles — 4-column grid (`sidebar | chat | tree | content`), sidebar, messages, input area, tree panel, board panel. Loaded by both chat and briefing pages |
| `settings.html/js/css` | Settings page — model defaults, system prompt, prompt library |
| `couch.html/js/css` | Couch page — two-model conversation UI with markdown rendering, streaming debounce, smart scroll |
| `tasks.html/js/css` | Task list page — urgency-sorted list, inline CRUD, brain-dump launcher |
| `briefing.html/js/css` | Daily briefing page — same 4-column layout as chat. Sidebar lists briefing dates, chat in center, tree adjacent, briefing content + reading progress in right panel. `briefing.css` has only briefing-specific styles (content formatting, progress panel, assemble button) |
| `latex-rendering.js` | KaTeX integration for rendering LaTeX in chat messages |

### Data (`data/`)

| File | Purpose |
|------|---------|
| `sequences_order.json` | LessWrong Rationality: A-Z reading order (~338 posts) |
| `gwern_essays.json` | Curated Gwern.net essays sorted by importance (~80 essays) |
| `acx_best_of.json` | SSC + ACX best-of compilation (~126 posts) |
| `album_list.json` | /mu/ essential albums (~500 albums) |

### Root

| File | Purpose |
|------|---------|
| `pyproject.toml` | Package config, dependencies, entry points (`claude-wrapper`, `claude-wrapper-briefing`) |
| `example_tools.py` | Sample tool definitions (get_current_time, calculate) |
| `.env` / `.env.example` | API key configuration |
| `tag-injection-spec.md` | Design spec for the file/tag injection system |

## Key Decisions

- **Flat package layout** (not src-layout) — simpler for a personal project. Required explicit `packages = ["claude_wrapper"]` in pyproject.toml because setuptools auto-discovery picks up `static/`.
- **SQLite with WAL mode** — single-file DB at `~/.claude-wrapper/data.db`. Good enough for single-user, easy to back up.
- **Tree-structured messages** — each message has a `parent_id`, enabling conversation branching and branch switching. The `current_leaf_id` on a conversation tracks which branch is active.
- **Idempotent migrations** — schema changes are applied via `ALTER TABLE ... ADD COLUMN` wrapped in try/except. No migration framework.
- **Tool auto-discovery** — `example_tools.py` is loaded by filename from the project root at startup. Any file exporting a `ToolRegistry` named `registry` works.
- **Streaming via WebSocket** — the chat and couch pages use persistent WebSocket connections. Events are typed (`StreamEvent`) and serialized as JSON.
- **Couch role-flipping** — each model sees the other's messages as "user" role with a label prefix. Messages are merged to ensure strict role alternation per API requirements.
- **Task urgency scores** — computed at query time, not stored. Formula combines priority, due-date proximity, age, active status, blocked/waiting penalties. Coefficients are tunable in `task_urgency.py`.
- **Three-layer prompt system** — "universal prompt" (global setting, always prepended) + per-conversation "saved prompt" (selected via dropdown, stored as `prompt_id`) + injected files block (from active file context). Composed at call time in `_get_effective_system_prompt()`. Legacy conversations with a baked-in `system_prompt` but no `prompt_id` fall back to that field.
- **Task tools as Claude functions** — task CRUD is exposed as tool calls so Claude can manage tasks during conversations. The brain-dump flow creates a conversation with the seeded "Brain dump" saved prompt selected, which guides Claude to interview the user and call `task_create`. Tool schemas for `task_create`/`task_update`/`task_list` are enriched at call time with current project and tag lists via a registry refresher, so the LLM sees existing values in the schema without needing an extra `task_list` round-trip. Tags accept both comma-separated strings and JSON arrays.
- **Soft deletes for tasks** — tasks are never removed from the DB, only set to `status = 'deleted'`. History is preserved.
- **Daily briefing assembly** — data gathered from RSS feeds, sequential reading lists, AnkiConnect, and task DB, then sent to Claude as a single structured prompt. Result stored in SQLite keyed by date. Idempotent: won't re-assemble if today's briefing exists (unless forced). Can run via cron CLI (`claude-wrapper-briefing`) or the web UI's "assemble" button.
- **Sequential reading pointers** — each series (Sequences, Gwern, ACX, albums) has a pointer that advances once per day (idempotent via `last_advanced` date check). Supports pause/skip. Gwern/ACX alternate by day-of-year parity, with ACX RSS overriding when a new post appears.
- **Briefing feeds fail gracefully** — all feed fetchers return empty lists on error. AnkiConnect returns `{available: false}` when Anki isn't running. The briefing assembles with whatever data is available.
- **File context via tag injection** — users upload PDF/MD files tagged with keywords. Typing `#tag` in chat activates all files with that tag into the conversation's context. Files are injected into the system prompt as `<injected_files>` XML blocks. Context persists across turns until manually removed. Tag-only messages (no user text) activate context without sending a chat turn.
- **Vision / image paste** — users can paste images from clipboard in any chat interface (main, couch, briefing). Images are sent as base64 `ContentBlock`s with `type: "image"` and a `source` dict. The backend passes them through to the API as content block lists. In couch mode, image blocks are preserved through the role-flipping message builder and merge logic. Images round-trip through SQLite via `model_dump(exclude_none=True)` on ContentBlock.
- **File storage in SQLite** — file content stored directly in the `files` table (not on disk). 5MB upload limit, 1M character content extraction limit. PDF text extracted via PyMuPDF.
- **Bidirectional tree layout** — conversation tree branches grow both left and right from the trunk. At branch points, 1st child continues straight, subsequent siblings alternate right/left. Depth indicator lines appear every 10 exchanges.
- **Arrow key tree navigation** — when the tree panel is visible, arrow keys navigate the conversation tree. Up/Down walk along on-path nodes and scroll the corresponding message into view. Left/Right jump between nodes at the same tree depth (sorted by x position), triggering a branch switch if the target is off-path. Scroll↔tree sync is suppressed for 600ms during arrow nav to prevent the smooth-scroll feedback loop from fighting the highlight. Module-level `treeChildrenMap`, `treeParentMap`, and `arrowNavActive` support this.
- **Moodboard** — a persistent visual pinning space in column 4 (far right). Chat column is capped at ~700px (message width + padding) so the moodboard sits adjacent to the text content rather than being separated by empty space. Supports text, links, images (stored as data URIs), and pinned chat messages. Zero-friction: no tags, categories, or positioning. Images can be dragged/dropped or pasted. Claude has `moodboard_pin`/`moodboard_remove` tools to interact with the board. Pins show source (sylvia/claude) and timestamp, with delete-on-hover. CSS columns masonry layout, newest first.
- **Shared chat module (`chat-core.js`)** — `createChatCore(config)` factory function that encapsulates all chat state and logic: WebSocket streaming, message rendering (marked + DOMPurify + KaTeX), tree navigation, edit UX, cost tracking, image handling. Both `app.js` and `briefing.js` create instances with page-specific config: DOM element refs, a normalized `apiFetch(method, path, body)` adapter, and optional callbacks (`onTitleUpdate`, `createMessageActions`, `buildSendPayload`, etc.). Pure utilities (`escapeHtml`, `renderMarkdown`, etc.) are top-level exports. No build system — loaded via `<script>` tag before page-specific scripts.
- **Unified 4-column layout** — both chat and briefing pages share the same CSS grid: `sidebar (200px) | chat (max 700px) | tree (200px) | content (1fr)`. Tree is adjacent to chat for quick branch navigation. On the chat page, column 4 is the moodboard; on the briefing page, it's the briefing content + reading progress. Both pages load `style.css` for shared layout classes; `briefing.css` adds only briefing-specific styles.

## Data Flow

```
Browser ─── WebSocket ──→ server.py ──→ ConversationManager ──→ ClaudeClient ──→ Anthropic API
                │                             │                        │
                │                             ▼                        ▼
                │                         ToolRegistry            streaming events
                │                             │                        │
                │                             ▼                        ▼
                │                          Database ◄──────── messages saved
                │                         (SQLite)
                │                             ▲
                ├── REST ──→ file_routes ──→ FileDatabase
                │            (upload/tag)     (files table)
                │                                │
                └── #tag in message ──→ server resolves tags ──→ active_file_ids on conversation
                                                                       │
                                                                       ▼
                                                          ConversationManager injects
                                                          file content into system prompt
```

Settings and prompts flow through REST endpoints → Database.
The couch uses the same Database and ClaudeClient but bypasses ConversationManager, using its own turn orchestration.
