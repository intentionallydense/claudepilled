# Architecture

LLM Interface is a personal web UI supporting multiple LLM providers — Anthropic Claude, OpenAI GPT, Google Gemini, DeepSeek, Qwen, and Kimi. It provides streaming chat with tool use (Anthropic), an N-model "backrooms" conversation mode (2-5 participants, cross-provider, with AI self-modification commands), conversation branching, file context injection via tags, and a task management system — all backed by SQLite and served via FastAPI.

## File Map

### Python Package (`llm_interface/`)

| File | Purpose |
|------|---------|
| `__init__.py` | Package exports: `ClaudeClient`, `ToolRegistry`, `ConversationManager`, `BackroomsOrchestrator` |
| `client.py` | Core Anthropic API client (`ClaudeClient`) — sync `send()` and async `stream()`, retry logic, request building. Also exports `get_client_for_model()` factory that routes to the right client based on model ID |
| `providers.py` | `OpenAICompatibleClient` — handles GPT, Gemini, DeepSeek, Qwen, Kimi via the `openai` SDK. Translates OpenAI streaming chunks to `StreamEvent` types. DeepSeek R1 `reasoning_content` maps to `THINKING_DELTA` |
| `models.py` | Pydantic data models: `Message`, `Conversation`, `ContentBlock`, `StreamEvent`, `ToolDefinition`. Provider catalog (`PROVIDERS` dict), multi-provider model catalog (`AVAILABLE_MODELS` with provider/api_model_id fields), pricing, and helpers (`get_provider_for_model`, `get_api_model_id`, `get_available_models`) |
| `tools.py` | `ToolRegistry` — decorator-based tool registration, JSON schema generation from type hints, tool execution. Supports schema refreshers for dynamic descriptions |
| `conversation.py` | `ConversationManager` — orchestrates chat turns, tool loops, streaming, message branching, auto-titling, model-speaks-first (`stream_init()`). Shared streaming helpers (`_collect_stream_events`, `_finalize_turn`, `_make_usage_event`) eliminate duplication across `stream_chat`, `stream_init`, and `edit_message`. `_TurnState` dataclass accumulates streaming state |
| `backrooms.py` | `BackroomsOrchestrator` — N-model (2-5) chatroom with iteration-based pacing, round-robin turns, role-flipping, command parsing, speed control, extended thinking support, stats tracking. Pacing: curator sets `iterations` (how many full rounds auto-run, default 1), `step_mode` (one turn at a time), `next_speaker` (one-shot override). `thinking_budget` enables extended thinking for all participants (stored in session metadata, toggled via toolbar). `_pick_next_seat()` is the extension point for custom orchestration. Metadata v2 uses `participants` array; `_normalize_metadata()` converts legacy v1 format on read. New sessions are always v2. `_resolve_prompt()` uses seat indices with `{self_label}/{other_label}/{all_labels}/{seat_number}` substitution. Integrates with `backrooms_commands.py` for AI self-modification |
| `backrooms_commands.py` | Command parser and executor for backrooms AI self-modification. Regex-based extraction of `!prompt`, `!temperature`, `!whisper`, `!mute_self`, `!vote`, `!search`, `!image`, `!add_ai`, `!remove_ai`, `!list_models` from model output. `SessionState` holds mutable per-session state. Commands stripped from visible text; results appear as system notifications. `!add_ai`/`!remove_ai` return `side_effects` for dynamic participant management |
| `db.py` | SQLite persistence — conversations, messages (tree-structured), settings, prompts library. Includes idempotent migrations for couch→backrooms rename |
| `server.py` | FastAPI app — REST endpoints, WebSocket streaming, static file serving, plugin loading, startup wiring |
| `plugin_protocol.py` | `WrapperPlugin` base class, `PluginContext`, `ContextSource`, `NavEntry`, `Column4Panel`, `FrontendManifest` — defines the plugin interface |
| `plugin_loader.py` | Plugin discovery from `plugins/` directory, dependency-ordered loading, route mounting, tool registration |
| `service_registry.py` | `ServiceRegistry` — named callable/object registry for inter-plugin communication |
| `task_db.py` | Backward-compat shim → `plugins/tasks/db.py` |
| `task_urgency.py` | Backward-compat shim → `plugins/tasks/urgency.py` |
| `task_routes.py` | Backward-compat shim → `plugins/tasks/routes.py` |
| `task_tools.py` | Backward-compat shim → `plugins/tasks/tools.py` |
| `pin_db.py` | Backward-compat shim → `plugins/pins/db.py` |
| `pin_routes.py` | Backward-compat shim → `plugins/pins/routes.py` |
| `pin_tools.py` | Backward-compat shim → `plugins/pins/tools.py` |
| `file_db.py` | Backward-compat shim → `plugins/files/db.py` |
| `file_routes.py` | Backward-compat shim → `plugins/files/routes.py` |
| `briefing_db.py` | Backward-compat shim → `plugins/briefing/db.py` |
| `briefing_feeds.py` | Backward-compat shim → `plugins/briefing/feeds.py` |
| `briefing_sequential.py` | Backward-compat shim → `plugins/briefing/sequential.py` |
| `briefing_anki.py` | Backward-compat shim → `plugins/briefing/anki.py` |
| `briefing_assembly.py` | Backward-compat shim → `plugins/briefing/assembly.py` |
| `briefing_routes.py` | Backward-compat shim → `plugins/briefing/routes.py` |
| `calendar_db.py` | Backward-compat shim → `plugins/calendar/db.py` |
| `calendar_routes.py` | Backward-compat shim → `plugins/calendar/routes.py` |
| `calendar_tools.py` | Backward-compat shim → `plugins/calendar/tools.py` |
| `email_db.py` | Backward-compat shim → `plugins/email/db.py` |
| `email_ingestion.py` | Backward-compat shim → `plugins/email/ingestion.py` |
| `email_routes.py` | Backward-compat shim → `plugins/email/routes.py` |

### Plugins (`llm_interface/plugins/`)

| Plugin | Purpose |
|--------|---------|
| `tasks/` | Task management — urgency-scored CRUD, LLM tools, brain-dump workflow. Provides `task_db` service |
| `files/` | File upload/management — PDF/MD storage, tag-based context injection |
| `pins/` | Moodboard pins — text, links, images; tag-based context injection |
| `calendar/` | Google Calendar integration — OAuth2 flow, event cache, CRUD, LLM tools. Contains `db.py` (CalendarDatabase cache layer), `routes.py` (REST API — OAuth, events, create), `tools.py` (LLM tool definitions). Provides `calendar_db` service |
| `briefing/` | Daily briefing assembly — RSS feeds, reading lists, Anki stats, task triage. Consumes `task_db`, provides `briefing_db`. Contains `db.py` (BriefingDatabase — briefings, reading_progress, shown_posts tables), `feeds.py` (RSS fetching + Wikipedia API), `sequential.py` (reading list pointer management), `anki.py` (AnkiConnect proxy), `assembly.py` (orchestrates data gathering + LLM prompt + DB storage, CLI entry point), `routes.py` (3 sub-routers: briefing, reading-progress, anki). Combined router mounted at `/api` |
| `email/` | Email ingestion — IMAP fetch, LLM parsing (GLM5/Haiku), task creation. Consumes `task_db`, provides `email_db`. Contains `db.py` (EmailDatabase CRUD), `routes.py` (REST API), `ingestion.py` (IMAP + LLM pipeline + CLI entry point) |

### Frontend (`static/`)

| File | Purpose |
|------|---------|
| `index.html` | Main page — 4-column layout: sidebar, chat, tree, moodboard. Hosts both chat and backrooms sessions (unified). Includes PWA manifest, hamburger button for mobile, backrooms toolbar ribbon (model names, status, pacing controls above messages), backrooms modals (new session, prompts) |
| `chat-core.js` | Shared chat module — `createChatCore(config)` factory encapsulating WebSocket streaming, message rendering, tree nav, edit UX, cost display. Configurable hooks: `wsUrlPrefix`, `costUrlPrefix`, `onStreamEvent` (pre-processor), `buildSendPayload`, `createMessageActions`. Used by `app.js` (chat + backrooms), `briefing.js`. Also exports `buildTreeLayout()` for tree rendering. Assistant message labels show the actual model name from the `availableModels` array |
| `backrooms-adapter.js` | Adapter for N-model backrooms sessions — handles backrooms-specific streaming events (`backrooms_turn_start/end`, `backrooms_paused`, `backrooms_status`, `backrooms_command`, `backrooms_stats`, `thinking_delta/done`), speaker-labeled message rendering (model_0 through model_4, plus `command` speaker for styled notifications on reload), edit/regenerate for curator messages, dynamic per-seat prompts modal, pacing controls rendered in a toolbar ribbon (speed 0.5x-5x, iteration count 1-10, step mode toggle, thinking toggle, next-speaker override), stats display, whisper rendering, collapsible thinking blocks (own `createBackroomsThinkingBlock()` since chat-core's is private). Provides `getChatCoreConfig()` overrides for chat-core. Used by `app.js` when a backrooms session is opened |
| `column4.js` | `Column4Manager` — manages pluggable panels in column 4. Fetches panel declarations from `/api/plugins/panels`, renders tab bar when multiple panels exist, lazy-loads panel JS modules via dynamic `import()`, calls `render(container, ctx)` / `destroy()` lifecycle hooks. Caches loaded modules |
| `nav-loader.js` | Dynamic nav loader — fetches plugin nav entries from `/api/plugins/nav` and inserts them into the `#plugin-nav` placeholder in each page's sidebar. Core links (chat, backrooms, settings) are static; plugin links (tasks, briefing) are dynamic |
| `plugins/moodboard/panel.js` | Moodboard panel (ES module) — unified board showing pins and files sorted by date. Renders pin/file cards, handles drag-drop, paste, retag UI, input with `#tag` extraction. Communicates with host page via CustomEvents (`board:pin-message`, `column4:refresh`). Loaded by Column4Manager |
| `app.js` | Main page logic — sidebar (unified: both chat and backrooms sessions), Column4Manager init, tag autocomplete, context bar, mobile sidebar toggle. Supports mode switching: destroys/recreates chatCore with appropriate config when switching between chat and backrooms sessions. "backrooms" link opens new-session modal |
| `agenda.js` | Agenda view — fetches Google Calendar events and tasks, renders chronological day-by-day timeline with now marker, interleaved events and tasks. Nav controls for day/3-day/week range |
| `style.css` | Shared layout styles — 4-column grid (`.app` default), 2-column variant (`.app-simple` for settings), 3-column variant (`.app-tasks` for tasks+agenda), sidebar, messages, input area, tree panel, board panel, backrooms-specific styles, shared form components (`.form-label`, `.form-select`, `.form-textarea`, `.form-input`, `.form-actions`, `.btn-dark`). Includes `@media (max-width: 768px)` responsive block for mobile |
| `manifest.json` | PWA manifest — enables "Add to Home Screen" on mobile browsers |
| `sw.js` | No-op service worker — pass-through fetch, no caching. Exists solely for PWA installability |
| `icon-192.png`, `icon-512.png` | PWA icons (white background, dark "C" monospace letter) |
| `settings.html/js/css` | Settings page — model defaults, universal prompt, prompt library (chat + backrooms categories), per-seat backrooms suffixes. Uses `app-simple` sidebar layout; CSS is overrides-only on top of style.css |
| `tasks.html/js/css` | Task list page — urgency-sorted list, inline CRUD, brain-dump launcher, email ingestion feed. Uses `app-simple` sidebar layout; CSS is overrides-only on top of style.css |
| `briefing.html/js/css` | Daily briefing page — same 4-column layout as chat. Sidebar lists briefing dates, chat in center, tree adjacent, briefing content + reading progress in right panel |
| `latex-rendering.js` | KaTeX integration for rendering LaTeX in chat messages |

### Data (`data/`)

| File | Purpose |
|------|---------|
| `sequences_order.json` | LessWrong Rationality: A-Z reading order (~338 posts) |
| `gwern_essays.json` | Curated Gwern.net essays sorted by importance (~80 essays) |
| `acx_best_of.json` | SSC + ACX best-of compilation (~126 posts) |
| `album_list.json` | /mu/ essential albums (~500 albums) |

### Docs (`docs/`)

| File | Purpose |
|------|---------|
| `apple-watch-shortcut.md` | Setup guide for Apple Watch voice chat via Shortcuts app |

### Root

| File | Purpose |
|------|---------|
| `pyproject.toml` | Package config, dependencies, entry points (`llm-interface`, `llm-interface-briefing`, `llm-interface-email`) |
| `example_tools.py` | Sample tool definitions (get_current_time, calculate) |
| `.env` / `.env.example` | API key configuration |

## Key Decisions

- **Plugin-based architecture** — everything outside core chat/backrooms infra is a plugin conforming to `WrapperPlugin` protocol. Plugins are auto-discovered from `llm_interface/plugins/` and loaded in dependency order (topological sort on `provides()`/`consumes()`). Each plugin can provide: DB table init, FastAPI routes (mounted at `/api/{name}`), LLM tool definitions, service registry entries, frontend manifest (nav entries, column 4 panels), CLI commands, and cron jobs. Inter-plugin communication via `ServiceRegistry` (named callables, not an event bus). `PluginContext` injects `db_path`, settings accessors, service registry, LLM client, and core DB reference. Backward-compat shims at old import paths (`task_db.py`, etc.) re-export from plugin locations so existing code works during transition. Current plugins: tasks, pins, files, calendar, email, briefing.
- **Multi-provider via OpenAI-compatible SDK** — all non-Anthropic providers (OpenAI, DeepSeek, Qwen, Kimi, Gemini, OpenRouter) expose OpenAI-compatible APIs. One `openai` SDK client handles all of them by varying `base_url` and `api_key`. `ClaudeClient` stays untouched for Anthropic; `OpenAICompatibleClient` in `providers.py` handles the rest. `get_client_for_model()` in `client.py` routes to the right one based on the model's provider field. Per-provider client instances are cached. Features that degrade gracefully: thinking (Anthropic-only except DeepSeek R1 `reasoning_content`), web search (Anthropic native + OpenRouter `:online` variant, enabled in both chat and backrooms; non-OpenRouter providers fall back to `!search` command proxy), prompt caching (Anthropic-only). Tool use works for both Anthropic (native format) and OpenAI-compatible providers (function-calling format via `ToolDefinition.to_openai_format()`). `_build_messages()` in `providers.py` translates tool_use/tool_result content blocks to OpenAI's `tool_calls`/`role:"tool"` format. `/api/models` only returns models whose provider has an API key configured.
- **Flat package layout** (not src-layout) — simpler for a personal project. Required explicit `packages = ["llm_interface"]` in pyproject.toml because setuptools auto-discovery picks up `static/`.
- **SQLite with WAL mode** — single-file DB at `~/.llm-interface/data.db`. Good enough for single-user, easy to back up.
- **Tree-structured messages** — each message has a `parent_id`, enabling conversation branching and branch switching. The `current_leaf_id` on a conversation tracks which branch is active.
- **Idempotent migrations** — schema changes are applied via `ALTER TABLE ... ADD COLUMN` wrapped in try/except. No migration framework.
- **Tool auto-discovery** — `example_tools.py` is loaded by filename from the project root at startup. Any file exporting a `ToolRegistry` named `registry` works.
- **Streaming via WebSocket** — the chat and backrooms pages use persistent WebSocket connections. Events are typed (`StreamEvent`) and serialized as JSON. A synchronous `POST /api/chat/{id}/message` endpoint also exists for HTTP-only clients (e.g. Apple Watch Shortcuts) — it consumes `stream_chat()` internally and returns the final text.
- **Backrooms N-participant system** — supports 2-5 models in round-robin turns with role-flipping. Pacing is iteration-based: curator sets how many full rounds auto-run (default 1), with step mode for one-turn-at-a-time advancement and next-speaker override for breaking round-robin order. No AI-side signaling needed. `_pick_next_seat()` is the extension point for custom orchestration (subclass to implement agent-based turn selection). Metadata v2 stores a `participants` array (`[{seat, id, label, speaker}, ...]`). New sessions always use v2; `_normalize_metadata()` converts legacy v1 (model_a/model_b) on read. Server normalizes metadata before sending to frontend, so frontend code only handles v2. Speaker IDs are `model_0` through `model_4`. Each model sees others' messages as "user" role with label prefix. Messages are merged to ensure strict role alternation. The backrooms WebSocket supports `edit`, `regenerate`, `inject_tags`, `set_speed`, `set_iterations`, `set_step_mode`, `set_thinking`, and `set_next_speaker`. Prompts resolved by seat index: `prompt_ids[seat]` → saved "default" backrooms prompt → hardcoded template. Variables: `{self_label}`, `{other_label}` (comma-joined others), `{all_labels}`, `{seat_number}`. Per-seat suffixes (`backrooms_seat_N_suffix`, N=1-5).
- **Backrooms command system** — after each model response, `parse_commands()` extracts `!command` patterns via regex. Commands: `!prompt "text"` (append to own prompt), `!temperature X` (0.0-2.0), `!whisper "target" "msg"` (private, only visible to source/target during message building), `!mute_self` (skip next turn), `!vote "q" [opts]` (informational poll), `!search "query"` (Anthropic web search via Haiku one-shot), `!image "desc"` (DALL-E 3), `!add_ai "model_id"` (invite new participant), `!remove_ai "label"` (remove participant, min 2), `!list_models` (show available models). `!add_ai`/`!remove_ai` return `side_effects` dicts that the orchestrator processes to dynamically modify the participants array mid-session. Commands stripped from visible text; results saved with `speaker="command"` (not `"system"`) so they render identically on reload as during live streaming. Notifications are saved AFTER the model's response message so they appear in the correct order on reload. `SessionState` holds per-stream-call mutable state (prompt appendices, temperatures, mute counters, speed). Search and image fail gracefully without API keys.
- **Backrooms pacing controls** — curator can set: turn delay multiplier (0.5x/1x/2x/5x), iteration count (1-10 full rounds per send), step mode (one turn per click), and next-speaker override (break round-robin order, one-shot). All stored in session metadata except next-speaker (cleared after use). Controls rendered in a toolbar ribbon above the messages area (not crammed into the input-actions bar). The turn loop uses a `while` loop with `turns_completed`/`total_attempts` counters — muted turns don't consume output slots, and `target_turns` is re-checked each iteration so add/remove participant adjustments take effect mid-loop.
- **Backrooms stats** — tracks per-model turns, tokens (input/output), response times (`time.monotonic()`), and commands used. Emitted as `BACKROOMS_STATS` event at end of each turn loop. Saved to session metadata (`last_stats`). Available via `GET /api/backrooms/sessions/{id}/stats`. Frontend renders a collapsible stats display.
- **Unified chat page with mode switching** — backrooms sessions share the main chat page rather than having a separate page. The sidebar shows both chat and backrooms conversations (backrooms sessions labeled "br"). Opening a backrooms session destroys the chatCore instance and recreates it with backrooms-specific config from `BackroomsAdapter.getChatCoreConfig()` (different WS/cost URL prefixes, custom streaming event handler, speaker-aware message rendering). Switching back to a chat session reverses the process. This eliminated ~1500 lines of duplicate code in the old standalone couch page.
- **Task urgency scores** — computed at query time, not stored. Formula combines priority, due-date proximity, age, active status, blocked/waiting penalties. Coefficients are tunable in `task_urgency.py`.
- **Three-layer prompt system** — "universal prompt" (selected from saved chat prompts via `universal_prompt_id` setting, always prepended) + per-conversation "saved prompt" (selected via dropdown, stored as `prompt_id`) + injected files block (from active file context). Composed at call time in `_get_effective_system_prompt()`. The settings page universal prompt dropdown is populated from chat prompts and stays in sync when prompts are added/edited/deleted. Falls back to legacy raw-text `universal_prompt` setting for backwards compatibility. Legacy conversations with a baked-in `system_prompt` but no `prompt_id` fall back to that field. Prompts have a `category` column (`chat` or `backrooms`) — the settings page shows two separate sections, chat prompt selectors only show chat prompts, and backrooms seat selectors only show backrooms prompts.
- **Task tools as LLM functions** — task CRUD is exposed as tool calls so the LLM can manage tasks during conversations. The brain-dump flow creates a conversation with the seeded "Brain dump" saved prompt selected and uses "model speaks first" (`stream_init()` in `ConversationManager`): the model reads the system prompt and initiates the conversation with no prior user message. Always uses Opus 4.6 with no thinking budget. The tasks page brain dump button creates the conversation, then redirects to `/?c={id}&init=1`, which triggers auto-init on the chat page. Tool schemas for `task_create`/`task_update`/`task_list` are enriched at call time with current project and tag lists via a registry refresher, so the LLM sees existing values in the schema without needing an extra `task_list` round-trip. Tags accept both comma-separated strings and JSON arrays.
- **Soft deletes for tasks** — tasks are never removed from the DB, only set to `status = 'deleted'`. History is preserved.
- **Daily briefing assembly** — data gathered from RSS feeds, sequential reading lists, AnkiConnect, and task DB, then sent to the LLM as a single structured prompt. Result stored in SQLite keyed by date. Idempotent: won't re-assemble if today's briefing exists (unless forced). Can run via cron CLI (`llm-interface-briefing`) or the web UI's "assemble" button.
- **Sequential reading pointers** — each series (Sequences, Gwern, ACX, albums) has a pointer that advances once per day (idempotent via `last_advanced` date check). Supports pause/skip. Gwern/ACX alternate by day-of-year parity, with ACX RSS overriding when a new post appears.
- **Briefing feeds fail gracefully** — all feed fetchers return empty lists on error. AnkiConnect returns `{available: false}` when Anki isn't running. The briefing assembles with whatever data is available.
- **Unified tag injection (files + pins)** — users upload PDF/MD files tagged with keywords, and pins can also have tags. Typing `#tag` in chat or backrooms activates all files AND tagged pins matching that tag into the conversation's context. Files are injected into the system prompt as `<injected_files>` XML blocks; pins as `<injected_pins>` XML blocks (image pins excluded — data URIs too large). Both persist across turns until manually removed via context bar. Tag-only messages (no user text) activate context without sending a chat turn. Active state tracked separately: `active_file_ids` and `active_pin_ids` on conversations. Tag resolution logic extracted to `_handle_tag_injection()` in server.py (shared by chat and backrooms WS handlers). Backrooms sessions share the same context mechanism — `BackroomsOrchestrator._build_injected_context_block()` appends active files/pins to all models' system prompts.
- **Vision / image paste** — users can paste images from clipboard in any chat interface (main chat, backrooms, briefing). Images are sent as base64 `ContentBlock`s with `type: "image"` and a `source` dict. The backend passes them through to the API as content block lists. In backrooms mode, image blocks are preserved through the role-flipping message builder and merge logic. Images round-trip through SQLite via `model_dump(exclude_none=True)` on ContentBlock.
- **Prompt caching** — Anthropic prompt caching with up to 3 breakpoints: (1) stable system prompt layer (universal + conversation prompt) cached independently, (2) dynamic layer (injected files/pins) cached separately so adding/removing `#tags` doesn't invalidate the stable prefix, (3) second-to-last user message cached so the conversation prefix is reused across turns. `_get_system_prompt_parts()` splits the system prompt into layers; `_build_cached_system_blocks()` wraps each with `cache_control: {"type": "ephemeral"}`; `_add_message_cache_breakpoints()` marks the conversation turn. Non-Anthropic providers receive a plain string (layers joined). Cache token counts tracked per-message; cost formula accounts for 1.25x writes and 0.1x reads. Cache breakdown visible in the cost tooltip.
- **File storage in SQLite** — file content stored directly in the `files` table (not on disk). 5MB upload limit, 1M character content extraction limit. PDF text extracted via PyMuPDF.
- **Bidirectional tree layout** — conversation tree branches grow both left and right from the trunk. At branch points, 1st child continues straight, subsequent siblings alternate right/left. Depth indicator lines appear every 10 exchanges.
- **Arrow key tree navigation** — when the tree panel is visible, arrow keys navigate the conversation tree. Up/Down walk along on-path nodes and scroll the corresponding message into view. Left/Right jump between nodes at the same tree depth (sorted by x position), triggering a branch switch if the target is off-path. Scroll↔tree sync is suppressed for 600ms during arrow nav to prevent the smooth-scroll feedback loop from fighting the highlight. Module-level `treeChildrenMap`, `treeParentMap`, and `arrowNavActive` support this.
- **Unified board** — column 4 is a unified content board showing both pins and uploaded files in a single masonry layout, merged by date (newest first). Pins support text, links, images (stored as data URIs), and pinned chat messages. Files render as document cards (filename, type label, tags, token count). Both pins and files can have tags, editable inline via retag UI. Typing `some note #tag` in the board input pins "some note" with tag "tag" (zero friction). Dropping PDF/MD files on the board uploads them via the file API. The separate file management modal has been removed — the board is the single interface for all content. The LLM has `moodboard_pin` (with optional tags) and `moodboard_remove` tools.
- **Shared chat module (`chat-core.js`)** — `createChatCore(config)` factory function that encapsulates all chat state and logic: WebSocket streaming, message rendering (marked + DOMPurify + KaTeX), tree navigation, edit UX, cost tracking, image handling. Both `app.js` and `briefing.js` create instances with page-specific config: DOM element refs, a normalized `apiFetch(method, path, body)` adapter, and optional callbacks (`onTitleUpdate`, `createMessageActions`, `buildSendPayload`, etc.). Configurable hooks (`wsUrlPrefix`, `costUrlPrefix`, `onStreamEvent`) allow the backrooms adapter to intercept and handle two-model streaming events without modifying chat-core itself. Pure utilities (`escapeHtml`, `renderMarkdown`, etc.) are top-level exports. `buildTreeLayout(treeData, nodeMapEl, layoutConfig, onNodeClick)` is also a top-level export — it handles the full tree rendering (skip logic, DFS layout, SVG bezier connections, node dots) and is used by `createChatCore` internally. No build system — loaded via `<script>` tag before page-specific scripts.
- **Shared layout system** — all pages load `style.css` for shared layout classes and form components; page-specific CSS files add only overrides. Chat, briefing, and backrooms use the 4-column grid: `sidebar (200px) | chat (max 700px) | tree (200px) | content (1fr)`. Settings uses `.app-simple` 2-column variant: `sidebar (200px) | scrollable content (1fr, max 700px)`. Tasks uses `.app-tasks` 3-column variant: `sidebar (200px) | tasks (1fr) | agenda (1fr)`. All variants share the same sidebar component and mobile responsive behavior. `.btn-dark` is scoped: base is compact (for page buttons), `.modal-body .btn-dark` gets full-width (for modal actions).
- **Google Calendar integration** — read+write integration via Google Calendar API v3. OAuth2 flow: `/api/calendar/auth` redirects to Google consent screen, `/api/calendar/callback` stores refresh token in SQLite settings table. Events cached locally in `calendar_events` table, refreshed on page load + every 5 minutes. Agenda view rendered on the right side of the tasks page as a chronological timeline with day separators, current-time marker, and interleaved tasks. The LLM has `calendar_today`, `calendar_week`, and `calendar_create` tools for natural language scheduling. Event creation goes straight to Google (one-way write, no sync). Env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Mobile PWA** — CSS-only responsive layout via `@media (max-width: 768px)` at the end of `style.css` and `tasks.css`. On mobile: 4-column grid collapses to single column, sidebar becomes a fixed overlay toggled by a hamburger button, tree/board panels hidden. Desktop layout is completely untouched. Minimal PWA setup (`manifest.json` + no-op `sw.js`) enables "Add to Home Screen" — no offline support. Touch events use `onpointerdown` instead of `onmousedown` for compatibility.
- **Model name labels** — assistant message labels show the actual model name (e.g. "Claude 4.6 Opus", "DeepSeek V3.2") instead of hardcoded "claude". Looked up from the `availableModels` array using the current model select value. Falls back to model ID, then "assistant".
- **Conversation search** — sidebar search input does a debounced (300ms) `LIKE '%query%'` search against the raw JSON `content` column in the messages table. No FTS5 — overkill for single-user. Results are grouped by conversation and returned with text previews (snippet centered on the match). The search endpoint (`GET /api/conversations/search?q=...`) is defined before the `/{conversation_id}` catch-all to avoid FastAPI treating "search" as an ID. In the UI, search results replace the conversation list; clearing the input restores it.
- **Conversation compaction** — manual "compact" button in the input actions bar. Summarizes older messages using GLM5 via OpenRouter (cheap/fast, falls back to Haiku), storing compaction records in the `conversations.metadata` JSON column. Compacted messages stay visible in the UI but dimmed (opacity 0.5), with a dashed divider showing where compaction occurred. The divider label is clickable to reveal/hide the summary. API calls replace compacted messages with a user/assistant summary pair to save tokens. Multiple compactions stack — each new one includes the previous summary as context. Compactions are branch-aware: if the current path doesn't contain the cutoff message, the compaction is ignored and full messages are sent. Minimum 10 messages required; last 6 messages always kept live.
- **System model routing** — cheap system tasks (title generation, compaction summaries, briefing assembly, email parsing) use GLM5 via OpenRouter (`z-ai/glm-5`) with reasoning/thinking enabled for richer output, falling back to Anthropic Haiku if no OpenRouter key is configured. Brain dump (model-speaks-first) uses GLM5 via OpenRouter (has tool use for task creation). Briefing chat conversations use the user's selected model (defaults to Opus 4.6 via settings).
- **Email ingestion** — forward emails to a dedicated Gmail address, process via cron or manual API trigger. IMAP4_SSL fetches UNSEEN messages, marks them SEEN after processing. Each email is parsed by GLM5 (Haiku fallback) to extract tasks and pins. Results logged to `email_log` table with dedup via IMAP Message-ID. The tasks page shows a "recently ingested" feed section with archive controls. CLI entry point: `llm-interface-email`. Env vars: `EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASSWORD`.

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
                ├── #tag in message ──→ server resolves tags ──→ active_file_ids + active_pin_ids
                │                      (both files & pins)              │
                │                                                       ▼
                │                                          ConversationManager injects
                │                                          files as <injected_files> +
                │                                          pins as <injected_pins> into
                │                                          system prompt
                │
                ├── REST ──→ email_routes ──→ EmailDatabase
                │            (list/archive/     (email_log table)
                │             ingest)
                │
                └── REST ──→ calendar_routes ──→ CalendarDatabase ──→ Google Calendar API v3
                             (OAuth, events,      (calendar_events     (fetch + create events)
                              create)              table — cache)

Cron/CLI ──→ email_ingestion.cli_main() ──→ IMAP fetch ──→ GLM5/Haiku parse ──→ TaskDatabase + PinDatabase
                                                                                        │
                                                                                        ▼
                                                                                  EmailDatabase (log)
```

Settings and prompts flow through REST endpoints → Database.
Backrooms uses the same Database and ClaudeClient but bypasses ConversationManager, using its own turn orchestration via BackroomsOrchestrator.
