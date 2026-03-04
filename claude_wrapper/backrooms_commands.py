"""Command parser and executor for backrooms AI self-modification.

Models can embed !commands in their responses. After each turn, the orchestrator
calls parse_commands() to extract them, then execute_command() for each.
Commands are stripped from the visible text; results appear as system notifications.

Supported commands:
  !prompt "text"           — append to own system prompt
  !temperature X           — set own temperature (0.0-2.0)
  !whisper "target" "msg"  — private message to one participant
  !mute_self               — skip next turn
  !vote "question" [opts]  — informational poll (no enforcement)
  !search "query"          — web search via Anthropic API
  !image "description"     — generate image via DALL-E 3
  !add_ai "model_id"       — invite a new AI participant
  !remove_ai "label"       — remove a participant (min 2)
  !list_models             — list available models

Used by: backrooms.py (called after each model response)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class ParsedCommand:
    """A command extracted from model output."""
    name: str
    raw_text: str  # the full matched string (to strip from output)
    args: list[str] = field(default_factory=list)


@dataclass
class CommandResult:
    """Result of executing a command."""
    strip_from_text: bool = True
    notification: str | None = None
    whisper_target: str | None = None
    whisper_text: str | None = None
    side_effects: dict | None = None


class SessionState:
    """Mutable per-session state shared across turns within one stream_turns() call.

    NOT persisted — created fresh each time the curator sends a message.
    Long-lived state (like accumulated prompt appendices) should be stored
    in session metadata if persistence is needed.
    """

    def __init__(self, participants: list[dict] | None = None):
        self.participants = participants or []
        # speaker → appended text
        self.prompt_appendices: dict[str, str] = {}
        # speaker → temperature override
        self.temperatures: dict[str, float] = {}
        # speaker → turns to skip (decremented each time)
        self.muted: dict[str, int] = {}
        # Speed multiplier (0.5, 1.0, 2.0, 5.0)
        self.speed: float = 1.0
        # Stats (populated by orchestrator)
        self.stats: dict = {}


# ---------------------------------------------------------------------------
# Command parsing — regex-based extraction
# ---------------------------------------------------------------------------

# Patterns for each command. Order matters — longer matches first.
_COMMAND_PATTERNS = [
    # !whisper "target" "message"
    (
        "whisper",
        re.compile(
            r'!whisper\s+"([^"]+)"\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !prompt "text"
    (
        "prompt",
        re.compile(
            r'!prompt\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !temperature X
    (
        "temperature",
        re.compile(
            r'!temperature\s+([\d.]+)',
            re.IGNORECASE,
        ),
    ),
    # !vote "question" [opt1, opt2, ...]
    (
        "vote",
        re.compile(
            r'!vote\s+"([^"]+)"\s*\[([^\]]+)\]',
            re.IGNORECASE,
        ),
    ),
    # !search "query"
    (
        "search",
        re.compile(
            r'!search\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !image "description"
    (
        "image",
        re.compile(
            r'!image\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !add_ai "model_id"
    (
        "add_ai",
        re.compile(
            r'!add_ai\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !remove_ai "label"
    (
        "remove_ai",
        re.compile(
            r'!remove_ai\s+"([^"]+)"',
            re.IGNORECASE,
        ),
    ),
    # !list_models (no args)
    (
        "list_models",
        re.compile(
            r'!list_models\b',
            re.IGNORECASE,
        ),
    ),
    # !mute_self (no args)
    (
        "mute_self",
        re.compile(
            r'!mute_self\b',
            re.IGNORECASE,
        ),
    ),
]


def parse_commands(text: str) -> tuple[str, list[ParsedCommand]]:
    """Extract all !commands from text. Returns (cleaned_text, commands).

    The cleaned text has all command patterns removed. Commands are returned
    in the order they appeared.
    """
    commands = []

    for name, pattern in _COMMAND_PATTERNS:
        for match in pattern.finditer(text):
            cmd = ParsedCommand(
                name=name,
                raw_text=match.group(0),
                args=list(match.groups()),
            )
            commands.append(cmd)

    # Sort by position in original text (finditer returns in order, but
    # we iterate multiple patterns)
    if commands:
        # Strip all matched command text from the output
        cleaned = text
        for cmd in commands:
            cleaned = cleaned.replace(cmd.raw_text, "")
        # Clean up extra whitespace left by stripping
        cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip()
    else:
        cleaned = text

    return cleaned, commands


# ---------------------------------------------------------------------------
# Command execution
# ---------------------------------------------------------------------------

async def execute_command(
    cmd: ParsedCommand,
    speaker: str,
    session_state: SessionState,
    anthropic_client=None,
) -> CommandResult:
    """Execute a parsed command. Returns a CommandResult."""
    handler = _COMMAND_HANDLERS.get(cmd.name)
    if not handler:
        return CommandResult(notification=f"[unknown command: {cmd.name}]")
    return await handler(cmd, speaker, session_state, anthropic_client)


# --- Individual command handlers ---

async def _handle_prompt(cmd, speaker, state, client):
    """!prompt "text" — append to speaker's system prompt."""
    new_text = cmd.args[0] if cmd.args else ""
    if not new_text:
        return CommandResult(notification=f"[{_speaker_label(speaker, state)} tried to update prompt but gave no text]")
    existing = state.prompt_appendices.get(speaker, "")
    state.prompt_appendices[speaker] = (existing + "\n" + new_text).strip()
    label = _speaker_label(speaker, state)
    return CommandResult(notification=f"[{label} updated their prompt]")


async def _handle_temperature(cmd, speaker, state, client):
    """!temperature X — set speaker's temperature."""
    try:
        temp = float(cmd.args[0])
    except (ValueError, IndexError):
        return CommandResult(notification=f"[invalid temperature value]")
    temp = max(0.0, min(2.0, temp))
    state.temperatures[speaker] = temp
    label = _speaker_label(speaker, state)
    return CommandResult(notification=f"[{label} set temperature to {temp}]")


async def _handle_whisper(cmd, speaker, state, client):
    """!whisper "target" "message" — private message."""
    target_name = cmd.args[0] if len(cmd.args) > 0 else ""
    message = cmd.args[1] if len(cmd.args) > 1 else ""
    if not target_name or not message:
        return CommandResult(notification="[whisper failed: missing target or message]")
    # Verify target exists
    target_found = any(p["label"] == target_name for p in state.participants)
    if not target_found:
        return CommandResult(notification=f"[whisper failed: unknown participant '{target_name}']")
    return CommandResult(
        strip_from_text=True,
        whisper_target=target_name,
        whisper_text=message,
    )


async def _handle_mute_self(cmd, speaker, state, client):
    """!mute_self — skip next turn."""
    state.muted[speaker] = 1
    label = _speaker_label(speaker, state)
    return CommandResult(notification=f"[{label} is sitting this one out]")


async def _handle_vote(cmd, speaker, state, client):
    """!vote "question" [opt1, opt2, ...] — informational poll."""
    question = cmd.args[0] if len(cmd.args) > 0 else ""
    options_str = cmd.args[1] if len(cmd.args) > 1 else ""
    options = [o.strip() for o in options_str.split(",") if o.strip()]
    label = _speaker_label(speaker, state)
    opts_formatted = ", ".join(options) if options else "open discussion"
    return CommandResult(
        notification=f'[VOTE by {label}: "{question}" — options: {opts_formatted}]'
    )


async def _handle_search(cmd, speaker, state, client):
    """!search "query" — web search via Anthropic API one-shot call."""
    query = cmd.args[0] if cmd.args else ""
    if not query:
        return CommandResult(notification="[search failed: no query]")

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return CommandResult(notification="[search unavailable: no API key configured]")

    try:
        # Use the passed-in Anthropic client for a one-shot web search
        if client is None:
            return CommandResult(notification="[search unavailable: no client]")

        response = client.send(
            messages=[{"role": "user", "content": f"Search the web for: {query}\n\nReturn a concise summary of the top results (3-5 key findings)."}],
            model="claude-haiku-4-5-20251001",
            web_search=True,
            max_tokens=1024,
        )
        result_text = response.text() if hasattr(response, 'text') else str(response.content)
        label = _speaker_label(speaker, state)
        return CommandResult(
            notification=f'[search results for "{query}" by {label}]:\n{result_text}'
        )
    except Exception as e:
        return CommandResult(notification=f'[search failed: {str(e)[:100]}]')


async def _handle_image(cmd, speaker, state, client):
    """!image "description" — generate image via DALL-E 3."""
    description = cmd.args[0] if cmd.args else ""
    if not description:
        return CommandResult(notification="[image generation failed: no description]")

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return CommandResult(notification="[image generation unavailable: no OPENAI_API_KEY configured]")

    try:
        from openai import OpenAI
        openai_client = OpenAI(api_key=api_key)
        response = openai_client.images.generate(
            model="dall-e-3",
            prompt=description,
            size="1024x1024",
            n=1,
        )
        image_url = response.data[0].url
        label = _speaker_label(speaker, state)
        return CommandResult(
            notification=f'[{label} generated an image: "{description}"]\n{image_url}'
        )
    except Exception as e:
        return CommandResult(notification=f'[image generation failed: {str(e)[:100]}]')


async def _handle_add_ai(cmd, speaker, state, client):
    """!add_ai "model_id" — invite a new AI to the conversation."""
    model_id = cmd.args[0] if cmd.args else ""
    if not model_id:
        return CommandResult(notification="[add_ai failed: no model specified]")
    from claude_wrapper.models import AVAILABLE_MODELS, get_model_name
    # Validate model exists
    valid = any(m["id"] == model_id for m in AVAILABLE_MODELS)
    if not valid:
        return CommandResult(notification=f"[add_ai failed: unknown model '{model_id}']")
    if len(state.participants) >= 5:
        return CommandResult(notification="[add_ai failed: maximum 5 participants]")
    label = _speaker_label(speaker, state)
    new_label = get_model_name(model_id)
    return CommandResult(
        notification=f"[{label} invited {new_label} to the conversation]",
        side_effects={"add_participant": {"id": model_id}},
    )


async def _handle_remove_ai(cmd, speaker, state, client):
    """!remove_ai "label" — remove a participant from the conversation."""
    target_label = cmd.args[0] if cmd.args else ""
    if not target_label:
        return CommandResult(notification="[remove_ai failed: no participant specified]")
    if len(state.participants) <= 2:
        return CommandResult(notification="[remove_ai failed: minimum 2 participants required]")
    target_found = any(p["label"] == target_label for p in state.participants)
    if not target_found:
        return CommandResult(notification=f"[remove_ai failed: unknown participant '{target_label}']")
    label = _speaker_label(speaker, state)
    return CommandResult(
        notification=f"[{label} removed {target_label} from the conversation]",
        side_effects={"remove_participant": {"label": target_label}},
    )


async def _handle_list_models(cmd, speaker, state, client):
    """!list_models — list all available models."""
    from claude_wrapper.models import get_available_models
    models = get_available_models()
    lines = [f"  {m['id']} ({m.get('name', m['id'])})" for m in models[:20]]
    label = _speaker_label(speaker, state)
    return CommandResult(
        notification=f"[available models for {label}]:\n" + "\n".join(lines)
    )


def _speaker_label(speaker: str, state: SessionState) -> str:
    """Get display label for a speaker from session state."""
    for p in state.participants:
        if p["speaker"] == speaker:
            return p["label"]
    return speaker


_COMMAND_HANDLERS = {
    "prompt": _handle_prompt,
    "temperature": _handle_temperature,
    "whisper": _handle_whisper,
    "mute_self": _handle_mute_self,
    "vote": _handle_vote,
    "search": _handle_search,
    "image": _handle_image,
    "add_ai": _handle_add_ai,
    "remove_ai": _handle_remove_ai,
    "list_models": _handle_list_models,
}
