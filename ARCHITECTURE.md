# Architecture

Claude Wrapper is a personal web UI and API wrapper supporting multiple LLM providers — Anthropic Claude, OpenAI GPT, Google Gemini, DeepSeek, Qwen, and Kimi. It provides streaming chat with tool use (Anthropic), a two-model "couch" conversation mode (cross-provider), conversation branching, file context injection via tags, and a task management system — all backed by SQLite and served via FastAPI.

## File Map

### Python Package (`claude_wrapper/`)

| File | Purpose |
|------|---------|
| `__init__.py` | Package exports: `ClaudeClient`, `ToolRegistry`, `ConversationManager`, `CouchOrchestrator` |
| `client.py` | Core Anthropic API client (`ClaudeClient`) — sync `send()` and async `stream()`, retry logic, request building. Also exports `get_client_for_model()` factory that routes to the right client based on model ID |
| `providers.py` | `OpenAICompatibleClient` — handles GPT, Gemini, DeepSeek, Qwen, Kimi via the `openai` SDK. Translates OpenAI streaming chunks to `StreamEvent` types. DeepSeek R1 `reasoning_content` maps to `THINKING_DELTA` |
| `models.py` | Pydantic data models: `Message`, `Conversation`, `ContentBlock`, `StreamEvent`, `ToolDefinition`. Provider catalog (`PROVIDERS` dict), multi-provider model catalog (`AVAILABLE_MODELS` with provider/api_model_id fields), pricing, and helpers (`get_provider_for_model`, `get_api_model_id`, `get_available_models`) |
| `tools.py` | `ToolRegistry` — decorator-based tool registration, JSON schema generation from type hints, tool execution. Supports schema refreshers for dynamic descriptions |
| `conversation.py` | `ConversationManager` — orchestrates chat turns, tool loops, streaming, message branching, auto-titling, model-speaks-first (`stream_init()`) |
| `couch.py` | `CouchOrchestrator` — two-model chatroom with role-flipping, turn pacing, [ready] signaling. `_resolve_prompt()` resolves prompt by ID → legacy → default template with `{self_label}/{other_label}/{seat_number}` variable substitution. `_resolve_suffix()` appends per-seat suffixes from settings |
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
| `pin_db.py` | `PinDatabase` — CRUD for the `pins` table (moodboard). Images stored as data URIs. Supports tags and per-conversation active pin context |
| `pin_routes.py` | FastAPI `APIRouter` for `/api/pins/*` endpoints — list, create, upload image, retag (PATCH), delete, list tags |
| `pin_tools.py` | Claude tool definitions for moodboard (moodboard_pin with optional tags, moodboard_remove) |

### Frontend (`static/`)

| File | Purpose |
|------|---------|
| `index.html` | Main chat page — 4-column layout: sidebar, chat, tree, moodboard |
| `chat-core.js` | Shared chat module — `createChatCore(config)` factory encapsulating WebSocket streaming, message rendering, tree nav, edit UX, cost display. Used by both `app.js` and `briefing.js`. Also exports `buildTreeLayout()` as a top-level function used by couch.js for tree rendering |
| `app.js` | Chat page logic — sidebar/conversations, unified board (pins + file cards), tag autocomplete, context bar. Delegates all chat behavior to `chat-core.js` |
| `style.css` | Shared layout styles — 4-column grid (`sidebar | chat | tree | content`), sidebar, messages, input area, tree panel, board panel. Loaded by both chat and briefing pages |
| `settings.html/js/css` | Settings page — model defaults, universal prompt (dropdown from saved chat prompts), prompt library, per-seat couch suffixes |
| `couch.html/js/css` | Couch page — two-model conversation UI, same 4-column layout as chat (sidebar, feed, tree, board). Messages use base chat styles (model messages get `assistant` class); `couch.css` only overrides curator/system dimming, prompt modal. Tree panel uses shared `buildTreeLayout()` with click-to-scroll, scroll sync, and search. Board panel shows unified pins + files merged by date. Supports `#tag` injection (context bar + autocomplete). Prompts modal has dropdown selects per seat (from saved couch prompts); prompts resolved at stream time with template variable substitution |
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

- **Multi-provider via OpenAI-compatible SDK** — all non-Anthropic providers (OpenAI, DeepSeek, Qwen, Kimi, Gemini) expose OpenAI-compatible APIs. One `openai` SDK client handles all of them by varying `base_url` and `api_key`. `ClaudeClient` stays untouched for Anthropic; `OpenAICompatibleClient` in `providers.py` handles the rest. `get_client_for_model()` in `client.py` routes to the right one based on the model's provider field. Per-provider client instances are cached. Features that degrade gracefully: thinking (Anthropic-only except DeepSeek R1 `reasoning_content`), web search (Anthropic-only), prompt caching (Anthropic-only), tool use (Anthropic-only for now). `/api/models` only returns models whose provider has an API key configured.
- **Flat package layout** (not src-layout) — simpler for a personal project. Required explicit `packages = ["claude_wrapper"]` in pyproject.toml because setuptools auto-discovery picks up `static/`.
- **SQLite with WAL mode** — single-file DB at `~/.claude-wrapper/data.db`. Good enough for single-user, easy to back up.
- **Tree-structured messages** — each message has a `parent_id`, enabling conversation branching and branch switching. The `current_leaf_id` on a conversation tracks which branch is active.
- **Idempotent migrations** — schema changes are applied via `ALTER TABLE ... ADD COLUMN` wrapped in try/except. No migration framework.
- **Tool auto-discovery** — `example_tools.py` is loaded by filename from the project root at startup. Any file exporting a `ToolRegistry` named `registry` works.
- **Streaming via WebSocket** — the chat and couch pages use persistent WebSocket connections. Events are typed (`StreamEvent`) and serialized as JSON.
- **Couch role-flipping** — each model sees the other's messages as "user" role with a label prefix. Messages are merged to ensure strict role alternation per API requirements. The couch WebSocket supports `edit` (branch from a parent, re-send curator input), `regenerate` (re-run from a curator message's starting point), and `inject_tags` (tag-based context activation, same as chat). Regenerate uses `pre_formatted=True` to skip label-wrapping since the stored content already has it. Curator input always uses "share" format (`[shared: ...]`). Prompts are resolved at stream time via `_resolve_prompt()`: looks up `prompt_id_{seat}` from metadata → loads content from prompts DB → falls back to legacy `system_prompt_{seat}` → falls back to default template. All prompt text gets regex-based variable substitution (`{self_label}`, `{other_label}`, `{seat_number}`). Per-seat suffixes (from global settings `couch_seat_1_suffix`/`couch_seat_2_suffix`) are appended after the resolved prompt but before context injection. Final prompt order: resolved prompt + seat suffix + injected files/pins.
- **Task urgency scores** — computed at query time, not stored. Formula combines priority, due-date proximity, age, active status, blocked/waiting penalties. Coefficients are tunable in `task_urgency.py`.
- **Three-layer prompt system** — "universal prompt" (selected from saved chat prompts via `universal_prompt_id` setting, always prepended) + per-conversation "saved prompt" (selected via dropdown, stored as `prompt_id`) + injected files block (from active file context). Composed at call time in `_get_effective_system_prompt()`. The settings page universal prompt dropdown is populated from chat prompts and stays in sync when prompts are added/edited/deleted. Falls back to legacy raw-text `universal_prompt` setting for backwards compatibility. Legacy conversations with a baked-in `system_prompt` but no `prompt_id` fall back to that field. Prompts have a `category` column (`chat` or `couch`) — the settings page shows two separate sections, chat prompt selectors only show chat prompts, and couch seat selectors only show couch prompts.
- **Task tools as Claude functions** — task CRUD is exposed as tool calls so Claude can manage tasks during conversations. The brain-dump flow creates a conversation with the seeded "Brain dump" saved prompt selected and uses "model speaks first" (`stream_init()` in `ConversationManager`): the model reads the system prompt and initiates the conversation with no prior user message. Always uses Opus 4.6 with no thinking budget. The tasks page brain dump button creates the conversation, then redirects to `/?c={id}&init=1`, which triggers auto-init on the chat page. Tool schemas for `task_create`/`task_update`/`task_list` are enriched at call time with current project and tag lists via a registry refresher, so the LLM sees existing values in the schema without needing an extra `task_list` round-trip. Tags accept both comma-separated strings and JSON arrays.
- **Soft deletes for tasks** — tasks are never removed from the DB, only set to `status = 'deleted'`. History is preserved.
- **Daily briefing assembly** — data gathered from RSS feeds, sequential reading lists, AnkiConnect, and task DB, then sent to Claude as a single structured prompt. Result stored in SQLite keyed by date. Idempotent: won't re-assemble if today's briefing exists (unless forced). Can run via cron CLI (`claude-wrapper-briefing`) or the web UI's "assemble" button.
- **Sequential reading pointers** — each series (Sequences, Gwern, ACX, albums) has a pointer that advances once per day (idempotent via `last_advanced` date check). Supports pause/skip. Gwern/ACX alternate by day-of-year parity, with ACX RSS overriding when a new post appears.
- **Briefing feeds fail gracefully** — all feed fetchers return empty lists on error. AnkiConnect returns `{available: false}` when Anki isn't running. The briefing assembles with whatever data is available.
- **Unified tag injection (files + pins)** — users upload PDF/MD files tagged with keywords, and pins can also have tags. Typing `#tag` in chat or couch activates all files AND tagged pins matching that tag into the conversation's context. Files are injected into the system prompt as `<injected_files>` XML blocks; pins as `<injected_pins>` XML blocks (image pins excluded — data URIs too large). Both persist across turns until manually removed via context bar. Tag-only messages (no user text) activate context without sending a chat turn. Active state tracked separately: `active_file_ids` and `active_pin_ids` on conversations. Couch sessions share the same context mechanism — `CouchOrchestrator._build_injected_context_block()` appends active files/pins to both models' system prompts.
- **Vision / image paste** — users can paste images from clipboard in any chat interface (main, couch, briefing). Images are sent as base64 `ContentBlock`s with `type: "image"` and a `source` dict. The backend passes them through to the API as content block lists. In couch mode, image blocks are preserved through the role-flipping message builder and merge logic. Images round-trip through SQLite via `model_dump(exclude_none=True)` on ContentBlock.
- **Prompt caching** — the system prompt is sent as a structured content block with `cache_control: {"type": "ephemeral"}`, enabling Anthropic's prompt caching. First request writes the cache (1.25x input cost), subsequent requests read from cache (0.1x input cost). Cache token counts are tracked per-message and accumulated on the conversation. Cost formula accounts for cache writes/reads separately. Cache breakdown visible in the cost tooltip.
- **File storage in SQLite** — file content stored directly in the `files` table (not on disk). 5MB upload limit, 1M character content extraction limit. PDF text extracted via PyMuPDF.
- **Bidirectional tree layout** — conversation tree branches grow both left and right from the trunk. At branch points, 1st child continues straight, subsequent siblings alternate right/left. Depth indicator lines appear every 10 exchanges.
- **Arrow key tree navigation** — when the tree panel is visible, arrow keys navigate the conversation tree. Up/Down walk along on-path nodes and scroll the corresponding message into view. Left/Right jump between nodes at the same tree depth (sorted by x position), triggering a branch switch if the target is off-path. Scroll↔tree sync is suppressed for 600ms during arrow nav to prevent the smooth-scroll feedback loop from fighting the highlight. Module-level `treeChildrenMap`, `treeParentMap`, and `arrowNavActive` support this.
- **Unified board** — column 4 is a unified content board showing both pins and uploaded files in a single masonry layout, merged by date (newest first). Pins support text, links, images (stored as data URIs), and pinned chat messages. Files render as document cards (filename, type label, tags, token count). Both pins and files can have tags, editable inline via retag UI. Typing `some note #tag` in the board input pins "some note" with tag "tag" (zero friction). Dropping PDF/MD files on the board uploads them via the file API. The separate file management modal has been removed — the board is the single interface for all content. Claude has `moodboard_pin` (with optional tags) and `moodboard_remove` tools.
- **Shared chat module (`chat-core.js`)** — `createChatCore(config)` factory function that encapsulates all chat state and logic: WebSocket streaming, message rendering (marked + DOMPurify + KaTeX), tree navigation, edit UX, cost tracking, image handling. Both `app.js` and `briefing.js` create instances with page-specific config: DOM element refs, a normalized `apiFetch(method, path, body)` adapter, and optional callbacks (`onTitleUpdate`, `createMessageActions`, `buildSendPayload`, etc.). Pure utilities (`escapeHtml`, `renderMarkdown`, etc.) are top-level exports. `buildTreeLayout(treeData, nodeMapEl, layoutConfig, onNodeClick)` is also a top-level export — it handles the full tree rendering (skip logic, DFS layout, SVG bezier connections, node dots) and is used by both `createChatCore` internally and `couch.js` directly. No build system — loaded via `<script>` tag before page-specific scripts.
- **Unified 4-column layout** — chat, briefing, and couch pages share the same CSS grid: `sidebar (200px) | chat (max 700px) | tree (200px) | content (1fr)`. Tree is adjacent to chat for quick branch navigation. On the chat page, column 4 is the moodboard; on the briefing page, it's the briefing content + reading progress; on the couch page, it's the shared pin board. All pages load `style.css` for shared layout classes; page-specific CSS files add only overrides.

## Data Flow

```
Browser ─── WebSocket ──→ server.py ──→ ConversationManager ──→ get_client_for_model()
                │                             │                        │
                │                             │              ┌─────────┴─────────┐
                │                             │              ▼                   ▼
                │                             │         ClaudeClient    OpenAICompatibleClient
                │                             │         (Anthropic)    (GPT/Gemini/DeepSeek/
                │                             │              │          Qwen/Kimi)
                │                             ▼              ▼                   ▼
                │                         ToolRegistry  streaming events (same StreamEvent types)
                │                         (Anthropic        │
                │                          only)            ▼
                │                          Database ◄──────── messages saved
                │                         (SQLite)
                │                             ▲
                ├── REST ──→ file_routes ──→ FileDatabase
                │            (upload/tag)     (files table)
                │
                ├── REST ──→ pin_routes ───→ PinDatabase
                │            (create/tag)     (pins table)
                │
                └── #tag in message ──→ server resolves tags ──→ active_file_ids + active_pin_ids
                                       (both files & pins)              │
                                                                        ▼
                                                           ConversationManager injects
                                                           files as <injected_files> +
                                                           pins as <injected_pins> into
                                                           system prompt
```

Settings and prompts flow through REST endpoints → Database.
The couch uses the same Database and ClaudeClient but bypasses ConversationManager, using its own turn orchestration.
