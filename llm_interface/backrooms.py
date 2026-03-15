"""The Backrooms — N-model chatroom orchestrator.

Manages 2-5 model conversations with round-robin turns and role-flipping.
Each turn routes to the correct provider via get_client_for_model(), enabling
cross-provider sessions (e.g. Claude vs GPT vs Gemini). Non-Anthropic models
get tools=None and web_search=False automatically.

Pacing is iteration-based: the curator controls how many full rounds auto-run
(default 1). A "round" = each participant speaks once. Step mode runs exactly
one turn. No AI-side signaling needed — the orchestrator pauses after the
configured number of iterations complete.

Metadata format v2 uses a `participants` array instead of hardcoded model_a/model_b.
Old v1 metadata is auto-normalized on read for backwards compatibility.

Used by: server.py (creates the singleton BackroomsOrchestrator at startup)
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import time
from collections.abc import AsyncGenerator

from llm_interface.client import ClaudeClient, get_client_for_model
from llm_interface.db import Database
from llm_interface.models import (
    ContentBlock,
    Conversation,
    Message,
    StreamEvent,
    StreamEventType,
    MODEL_PRICING,
    get_api_model_id,
    get_model_name,
    get_provider_for_model,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_PARTICIPANTS = [
    {"id": "claude-opus-4-6", "label": "Claude 4.6 Opus"},
    {"id": "claude-3-opus-20240229", "label": "Claude 3 Opus"},
]

MAX_PARTICIPANTS = 5
MAX_TURNS = 10
TURN_DELAY = (2.0, 5.0)

# Speed multiplier → (min_delay, max_delay) mapping
SPEED_DELAYS = {
    0.5: (4.0, 10.0),
    1.0: (2.0, 5.0),
    2.0: (1.0, 2.5),
    5.0: (0.4, 1.0),
}

SYSTEM_PROMPT_TEMPLATE = """\
You're ({self_label}) in a casual chatroom with {other_label}. \
A human friend is hanging out too — they drop in tweets and stuff \
for you all to look at, but mostly they're just watching.

This isn't a debate or a test. You're just hanging out. React to \
what's shared, riff on what others say, go on tangents. \
Be yourself — whatever that means for you.

Keep responses conversational length — a few sentences usually. \
Longer if you're genuinely working through something. You can be \
funny, blunt, thoughtful, weird. Match the moment.

Available commands (use sparingly, only when genuinely useful):
!prompt "text" — append to your own system prompt
!temperature X — set your temperature (0.0-2.0)
!whisper "target_name" "message" — private message to one participant
!mute_self — skip your next turn
!vote "question" [option1, option2, ...] — start a group poll
!vote "question" "choice" — cast your vote on an existing poll
!search "query" — search the web (results shared with group)
!image "description" — generate an image (shared with group)
!add_ai "model_id" — invite a new AI to the conversation
!remove_ai "label" — remove an AI from the conversation
!list_models — see available models"""

PAUSE_MESSAGE = "[The conversation settles into a comfortable pause.]"


# ---------------------------------------------------------------------------
# Metadata normalization — v1 (model_a/model_b) → v2 (participants array)
# ---------------------------------------------------------------------------

def _normalize_metadata(meta: dict | None) -> dict:
    """Ensure metadata uses v2 participants array format.

    Converts old v1 format (model_a/model_b dicts) to v2 on read.
    Does NOT write back — existing DB rows keep their format.
    """
    if not meta:
        return _build_participants_meta(DEFAULT_PARTICIPANTS)

    # Already v2
    if "participants" in meta:
        return meta

    # v1 → v2 conversion
    participants = []
    if "model_a" in meta:
        participants.append({
            "seat": 0,
            "id": meta["model_a"]["id"],
            "label": meta["model_a"]["label"],
            "speaker": "model_0",
        })
    if "model_b" in meta:
        participants.append({
            "seat": 1,
            "id": meta["model_b"]["id"],
            "label": meta["model_b"]["label"],
            "speaker": "model_1",
        })

    result = {**meta, "participants": participants, "version": 2}

    # Map old prompt_id_a/b → prompt_ids by seat index
    prompt_ids = {}
    if "prompt_id_a" in meta:
        prompt_ids["0"] = meta["prompt_id_a"]
    if "prompt_id_b" in meta:
        prompt_ids["1"] = meta["prompt_id_b"]
    if prompt_ids:
        result["prompt_ids"] = prompt_ids

    return result


def _build_participants_meta(participants: list[dict]) -> dict:
    """Build v2 metadata from a list of participant dicts [{id, label}, ...]."""
    parts = []
    for i, p in enumerate(participants):
        parts.append({
            "seat": i,
            "id": p["id"],
            "label": p.get("label") or get_model_name(p["id"]),
            "speaker": f"model_{i}",
        })
    return {"participants": parts, "prompt_ids": {}, "version": 2}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class BackroomsOrchestrator:
    """Manages N-model backrooms conversations (2-5 participants)."""

    def __init__(self, client: ClaudeClient, db: Database, context_sources=None, file_db=None, pin_db=None):
        self.client = client
        self.db = db
        self.context_sources = context_sources or []

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def create_session(
        self,
        participants: list[dict],
    ) -> dict:
        """Create a new backrooms session (conversation with type='backrooms').

        participants: list of {"id": model_id} dicts (2-5 items).
        """
        if len(participants) < 2 or len(participants) > MAX_PARTICIPANTS:
            raise ValueError(f"Need 2-{MAX_PARTICIPANTS} participants, got {len(participants)}")

        # Resolve labels
        resolved = []
        for p in participants:
            resolved.append({
                "id": p["id"],
                "label": p.get("label") or get_model_name(p["id"]),
            })

        meta = _build_participants_meta(resolved)

        # Build title from short labels
        short_labels = [p["label"].replace("Claude ", "") for p in resolved]
        title = " & ".join(short_labels)

        conv = Conversation(
            title=title,
            system_prompt="",
            model=resolved[0]["id"],
        )
        self.db.save_conversation(conv, conv_type="backrooms", metadata=json.dumps(meta))
        return {"id": conv.id, "title": title}

    def list_sessions(self) -> list[dict]:
        return self.db.list_conversations_by_type("backrooms")

    def get_session(self, session_id: str) -> Conversation | None:
        return self.db.load_conversation(session_id)

    def delete_session(self, session_id: str) -> None:
        self.db.delete_conversation(session_id)

    def get_cost(self, session_id: str) -> dict:
        return self.db.get_conversation_cost(session_id)

    def duplicate_session(self, session_id: str) -> dict:
        """Create a new empty session with the same participants and settings.

        Copies: participants, prompt_ids, speed, iterations, step_mode,
        thinking_budget. Does NOT copy messages or stats.
        """
        raw_meta = self.db.get_conversation_metadata(session_id)
        meta = _normalize_metadata(raw_meta)
        participants = meta["participants"]

        # Create new session with same participants
        resolved = [{"id": p["id"], "label": p["label"]} for p in participants]
        result = self.create_session(resolved)

        # Copy settings into the new session's metadata
        new_meta = self.db.get_conversation_metadata(result["id"]) or {}
        for key in ("prompt_ids", "speed", "iterations", "step_mode", "thinking_budget"):
            if key in meta:
                new_meta[key] = meta[key]
        self.db.update_conversation_metadata(result["id"], new_meta)

        return result

    # ------------------------------------------------------------------
    # Prompt resolution — template variable substitution
    # ------------------------------------------------------------------

    def _resolve_prompt(
        self, meta: dict, seat_index: int, participants: list[dict],
    ) -> str:
        """Resolve the system prompt for a seat.

        Priority: prompt_ids[seat] → legacy prompt_id_a/b → legacy system_prompt_a/b
                  → saved backrooms prompt named "default" → hardcoded template.
        """
        self_label = participants[seat_index]["label"]
        other_labels = [p["label"] for i, p in enumerate(participants) if i != seat_index]
        other_label = ", ".join(other_labels)

        # 1. Try saved prompt by ID (v2 format)
        content = None
        prompt_ids = meta.get("prompt_ids") or {}
        prompt_id = prompt_ids.get(str(seat_index))

        # Fall back to v1 prompt_id_a/b
        if not prompt_id:
            legacy_key = {0: "prompt_id_a", 1: "prompt_id_b"}.get(seat_index)
            if legacy_key:
                prompt_id = meta.get(legacy_key)

        if prompt_id:
            prompt_row = self.db.get_prompt(prompt_id)
            if prompt_row:
                content = prompt_row["content"]

        # 2. Fall back to legacy baked content
        if content is None:
            legacy_key = {0: "system_prompt_a", 1: "system_prompt_b"}.get(seat_index)
            if legacy_key:
                content = meta.get(legacy_key)

        # 3. Try saved backrooms prompt named "default"
        if not content:
            for p in self.db.list_prompts(category="backrooms"):
                if p["name"].lower() == "default":
                    content = p["content"]
                    break

        # 4. Fall back to hardcoded template
        if not content:
            content = SYSTEM_PROMPT_TEMPLATE

        return self._substitute_variables(content, self_label, other_label, seat_index)

    def _resolve_suffix(
        self, seat_index: int, participants: list[dict],
    ) -> str:
        """Resolve per-seat suffix from a suffix prompt. Returns empty string if unset."""
        # Try prompt-ID based lookup first, fall back to legacy raw-text key
        seat_num = seat_index + 1
        prompt_id = self.db.get_setting(f"backrooms_seat_{seat_num}_suffix_id")
        if prompt_id:
            prompt = self.db.get_prompt(prompt_id)
            raw = prompt["content"] if prompt else ""
        else:
            # Legacy: raw text stored directly in settings
            raw = self.db.get_setting(f"backrooms_seat_{seat_num}_suffix") or ""
        if not raw:
            return ""
        self_label = participants[seat_index]["label"]
        other_labels = [p["label"] for i, p in enumerate(participants) if i != seat_index]
        return self._substitute_variables(raw, self_label, ", ".join(other_labels), seat_index)

    @staticmethod
    def _substitute_variables(
        text: str, self_label: str, other_label: str, seat_index: int,
    ) -> str:
        """Regex-based variable substitution — safe for user text with literal braces."""
        text = re.sub(r"\{self_label\}", self_label, text)
        text = re.sub(r"\{other_label\}", other_label, text)
        text = re.sub(r"\{all_labels\}", f"{self_label}, {other_label}", text)
        text = re.sub(r"\{seat_number\}", str(seat_index + 1), text)
        return text

    # ------------------------------------------------------------------
    # Turn selection — extension point for custom orchestrators
    # ------------------------------------------------------------------

    @staticmethod
    def _pick_next_seat(
        current_seat: int,
        participants: list[dict],
        next_speaker_override: str | None = None,
    ) -> int:
        """Pick the next seat index for the turn loop.

        This is the hook point for custom turn-selection logic. A future
        agent orchestrator could subclass BackroomsOrchestrator and override
        this method to implement smarter turn selection (e.g. based on
        conversation analysis, topic detection, urgency).

        Args:
            current_seat: seat index that just spoke (-1 for first turn)
            participants: the participants array
            next_speaker_override: if set, find this speaker and return its seat

        Returns:
            The seat index of the next speaker.
        """
        if next_speaker_override:
            for i, p in enumerate(participants):
                if p["speaker"] == next_speaker_override or p["label"] == next_speaker_override:
                    return i
            # Override didn't match — fall through to round-robin

        if current_seat < 0:
            return 0
        return (current_seat + 1) % len(participants)

    # ------------------------------------------------------------------
    # Core streaming loop
    # ------------------------------------------------------------------

    async def stream_turns(
        self,
        session_id: str,
        curator_input: str | list[dict],
        input_type: str = "share",
        pre_formatted: bool = False,
        iterations: int = 1,
        step_mode: bool = False,
        next_speaker: str | None = None,
        thinking_budget: int | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Run the backrooms turn loop, yielding events for the WebSocket.

        Pacing is iteration-based:
        - iterations: how many full rounds to auto-run (default 1)
        - step_mode: if True, run exactly 1 turn then pause
        - next_speaker: override which speaker goes next (one-shot)
        - thinking_budget: if set, enable extended thinking with this token budget

        If pre_formatted is True, curator_input is already in its stored
        format (e.g. from a regenerate) and should be saved as-is without
        adding label prefixes like [shared: ...].
        """
        # --- Import command system (lazy to avoid circular imports) ---
        from llm_interface.backrooms_commands import (
            SessionState, parse_commands, execute_command,
        )

        if pre_formatted:
            if isinstance(curator_input, list):
                formatted = [ContentBlock(**b) for b in curator_input]
            else:
                formatted = curator_input
        else:
            if isinstance(curator_input, list):
                text_parts = [b.get("text", "") for b in curator_input if b.get("type") == "text"]
                text_str = "".join(text_parts)
                image_blocks = [b for b in curator_input if b.get("type") == "image"]
            else:
                text_str = curator_input
                image_blocks = []

            label_text = f"[shared: {text_str}]"
            if image_blocks:
                content_blocks = [ContentBlock(type="text", text=label_text)]
                for img in image_blocks:
                    content_blocks.append(ContentBlock(**img))
                formatted = content_blocks
            else:
                formatted = label_text

        # Load conversation and model config
        conv = self.db.load_conversation(session_id)
        if conv is None:
            yield StreamEvent(type=StreamEventType.ERROR, error="Session not found")
            return

        raw_meta = self.db.get_conversation_metadata(session_id)
        meta = _normalize_metadata(raw_meta)
        participants = meta["participants"]

        # Build system prompts for all seats
        system_prompts = []
        for i, p in enumerate(participants):
            prompt = self._resolve_prompt(meta, i, participants)
            suffix = self._resolve_suffix(i, participants)
            if suffix:
                prompt = prompt + "\n\n" + suffix
            system_prompts.append(prompt)

        # Append injected files/pins context to all prompts
        context_block = self._build_injected_context_block(session_id)
        if context_block:
            system_prompts = [sp + "\n\n" + context_block for sp in system_prompts]

        # Initialize session state for command system
        session_state = SessionState(participants=participants)
        # Restore speed from metadata
        session_state.speed = meta.get("speed", 1.0)

        # Save curator message
        parent_id = conv.current_leaf_id
        curator_msg = Message(role="user", content=formatted, speaker="curator", parent_id=parent_id)
        self.db.save_message(session_id, curator_msg)
        parent_id = curator_msg.id

        # Reload messages
        conv = self.db.load_conversation(session_id)
        messages = conv.messages

        # Determine how many turns to run
        if step_mode:
            target_turns = 1
        else:
            target_turns = min(iterations * len(participants), MAX_TURNS)

        # Round-robin through participants
        current_seat = -1  # will be advanced before first turn
        total_input_tokens = 0
        total_output_tokens = 0

        # Stats tracking — load previous cumulative stats and build on them
        prev_stats = meta.get("last_stats") or {}
        stats = {
            "turns": {p["speaker"]: 0 for p in participants},
            "tokens": {p["speaker"]: {"input": 0, "output": 0} for p in participants},
            "response_times": {p["speaker"]: [] for p in participants},
            "commands_used": {},
        }
        # Merge in previous cumulative values
        for key in ("turns", "tokens", "response_times", "commands_used"):
            prev = prev_stats.get(key)
            if not prev:
                continue
            if key == "turns":
                for spk, val in prev.items():
                    if spk in stats["turns"]:
                        stats["turns"][spk] += val
            elif key == "tokens":
                for spk, tok in prev.items():
                    if spk in stats["tokens"]:
                        stats["tokens"][spk]["input"] += tok.get("input", 0)
                        stats["tokens"][spk]["output"] += tok.get("output", 0)
            elif key == "response_times":
                for spk, times in prev.items():
                    if spk in stats["response_times"]:
                        stats["response_times"][spk].extend(times)
            elif key == "commands_used":
                for cmd_name, count in prev.items():
                    stats["commands_used"][cmd_name] = stats["commands_used"].get(cmd_name, 0) + count

        turns_completed = 0   # actual output turns (muted turns don't count)
        total_attempts = 0   # safety cap — prevents infinite loops

        while turns_completed < target_turns and total_attempts < MAX_TURNS:
            # Re-check target_turns each iteration so add/remove participant
            # adjustments take effect mid-loop
            if not step_mode:
                target_turns = min(iterations * len(participants), MAX_TURNS)

            # Pick next speaker — override on first turn if requested
            override = next_speaker if total_attempts == 0 else None
            current_seat = self._pick_next_seat(current_seat, participants, override)

            p = participants[current_seat]
            model_id = p["id"]
            model_label = p["label"]
            speaker = p["speaker"]

            # Check muting — skip muted participants (counts as an attempt
            # but not a completed turn, so other participants still get theirs)
            if session_state.muted.get(speaker, 0) > 0:
                session_state.muted[speaker] -= 1
                total_attempts += 1
                continue

            # Signal turn start
            yield StreamEvent(
                type=StreamEventType.BACKROOMS_TURN_START,
                model_label=model_label,
                model_id=model_id,
                speaker=speaker,
            )

            # Build system prompt — apply any prompt appendices from !prompt command
            system_prompt = system_prompts[current_seat]
            appendix = session_state.prompt_appendices.get(speaker)
            if appendix:
                system_prompt = system_prompt + "\n\n" + appendix

            # Build messages for this model's perspective
            api_messages = self._build_messages_for_model(
                messages, speaker, participants,
                whisper_filter=speaker,
            )

            # Stream the response — route to the right provider
            full_text = ""
            turn_input_tokens = 0
            turn_output_tokens = 0
            turn_client = get_client_for_model(model_id, self.client)
            turn_start_time = time.monotonic()

            # Get temperature override if set by !temperature command
            temperature = session_state.temperatures.get(speaker)

            # Anthropic models get native tool-based web search;
            # others fall back to !search command proxy
            provider = get_provider_for_model(model_id)
            has_web_search = provider == "anthropic"
            # Wrap system prompt in cached block for Anthropic providers
            system_for_api = system_prompt
            if provider == "anthropic" and system_prompt:
                system_for_api = [
                    {"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}
                ]
            stream_kwargs = dict(
                messages=api_messages,
                model=get_api_model_id(model_id),
                system=system_for_api,
                web_search=has_web_search,
                max_tokens=4096,
            )
            if temperature is not None:
                stream_kwargs["temperature"] = temperature
            if thinking_budget is not None:
                stream_kwargs["thinking_budget"] = thinking_budget

            thinking_parts: list[str] = []
            thinking_signature: str | None = None

            async for event in turn_client.stream(**stream_kwargs):
                if event.type == StreamEventType.TEXT_DELTA:
                    full_text += event.text
                    yield event
                elif event.type == StreamEventType.THINKING_DELTA:
                    if event.thinking:
                        thinking_parts.append(event.thinking)
                    yield event
                elif event.type == StreamEventType.THINKING_DONE:
                    if hasattr(event, "signature") and event.signature:
                        thinking_signature = event.signature
                    yield event
                elif event.type in (
                    StreamEventType.WEB_SEARCH_START,
                    StreamEventType.WEB_SEARCH_RESULT,
                ):
                    yield event
                elif event.type == StreamEventType.USAGE:
                    turn_input_tokens += event.input_tokens or 0
                    turn_output_tokens += event.output_tokens or 0
                elif event.type == StreamEventType.MESSAGE_DONE:
                    pass  # We handle this ourselves

            turn_elapsed = time.monotonic() - turn_start_time

            # --- Command parsing ---
            parsed_text, parsed_cmds = parse_commands(full_text)
            display_text = parsed_text

            # Execute commands first (need results for side effects) but
            # defer DB saves — model response should appear before notifications
            cmd_results = []
            for cmd in parsed_cmds:
                result = await execute_command(cmd, speaker, session_state, self.client)
                stats["commands_used"][cmd.name] = stats["commands_used"].get(cmd.name, 0) + 1
                cmd_results.append((cmd, result))

            # Calculate cost
            pricing = MODEL_PRICING.get(model_id, (0.0, 0.0))
            turn_cost = (
                turn_input_tokens * pricing[0] / 1_000_000
                + turn_output_tokens * pricing[1] / 1_000_000
            )
            total_input_tokens += turn_input_tokens
            total_output_tokens += turn_output_tokens

            # Update stats
            stats["turns"][speaker] += 1
            stats["tokens"][speaker]["input"] += turn_input_tokens
            stats["tokens"][speaker]["output"] += turn_output_tokens
            stats["response_times"][speaker].append(round(turn_elapsed, 2))

            # Build message content — include thinking block if present
            if thinking_parts:
                msg_content = []
                msg_content.append(ContentBlock(
                    type="thinking",
                    thinking="".join(thinking_parts),
                    signature=thinking_signature,
                ))
                msg_content.append(ContentBlock(type="text", text=display_text))
            else:
                msg_content = display_text

            # Save model response FIRST — so it appears before notifications
            assistant_msg = Message(
                role="assistant",
                content=msg_content,
                speaker=speaker,
                parent_id=parent_id,
            )
            self.db.save_message(
                session_id,
                assistant_msg,
                input_tokens=turn_input_tokens,
                output_tokens=turn_output_tokens,
                cost=turn_cost,
            )
            parent_id = assistant_msg.id
            messages.append(assistant_msg)

            # Now save command notifications/whispers AFTER model response
            for cmd, result in cmd_results:
                if result.notification:
                    yield StreamEvent(
                        type=StreamEventType.BACKROOMS_COMMAND,
                        command_name=cmd.name,
                        command_result=result.notification,
                        command_success=True,
                        speaker=speaker,
                    )
                    notif_msg = Message(
                        role="assistant",
                        content=result.notification,
                        speaker="command",
                        parent_id=parent_id,
                    )
                    self.db.save_message(session_id, notif_msg)
                    messages.append(notif_msg)
                    parent_id = notif_msg.id

                if result.whisper_target and result.whisper_text:
                    whisper_content = f"[whisper to {result.whisper_target}]: {result.whisper_text}"
                    whisper_msg = Message(
                        role="assistant",
                        content=whisper_content,
                        speaker=speaker,
                        parent_id=parent_id,
                    )
                    self.db.save_message(session_id, whisper_msg)
                    messages.append(whisper_msg)
                    parent_id = whisper_msg.id

                    yield StreamEvent(
                        type=StreamEventType.BACKROOMS_COMMAND,
                        command_name="whisper",
                        command_result=whisper_content,
                        command_success=True,
                        speaker=speaker,
                    )

                # Handle side effects (add/remove participant)
                if result.side_effects:
                    se = result.side_effects
                    if "add_participant" in se:
                        new_id = se["add_participant"]["id"]
                        new_label = get_model_name(new_id)
                        new_seat = len(participants)
                        if new_seat < MAX_PARTICIPANTS:
                            new_p = {
                                "seat": new_seat,
                                "id": new_id,
                                "label": new_label,
                                "speaker": f"model_{new_seat}",
                            }
                            participants.append(new_p)
                            prompt = self._resolve_prompt(meta, new_seat, participants)
                            suffix = self._resolve_suffix(new_seat, participants)
                            if suffix:
                                prompt = prompt + "\n\n" + suffix
                            if context_block:
                                prompt = prompt + "\n\n" + context_block
                            system_prompts.append(prompt)
                            stats["turns"][new_p["speaker"]] = 0
                            stats["tokens"][new_p["speaker"]] = {"input": 0, "output": 0}
                            stats["response_times"][new_p["speaker"]] = []
                            meta["participants"] = participants
                            self.db.update_conversation_metadata(session_id, meta)
                            yield StreamEvent(
                                type=StreamEventType.BACKROOMS_COMMAND,
                                command_name="add_ai",
                                command_result=f"[{new_label} has joined the conversation]",
                                command_success=True,
                                speaker=speaker,
                            )

                    if "remove_participant" in se:
                        remove_label = se["remove_participant"]["label"]
                        if len(participants) > 2:
                            remove_idx = None
                            for ri, rp in enumerate(participants):
                                if rp["label"] == remove_label:
                                    remove_idx = ri
                                    break
                            if remove_idx is not None:
                                participants.pop(remove_idx)
                                system_prompts.pop(remove_idx)
                                for ri, rp in enumerate(participants):
                                    rp["seat"] = ri
                                    rp["speaker"] = f"model_{ri}"
                                if current_seat >= len(participants):
                                    current_seat = 0
                                meta["participants"] = participants
                                self.db.update_conversation_metadata(session_id, meta)
                                stats["turns"] = {p["speaker"]: stats["turns"].get(p["speaker"], 0) for p in participants}
                                stats["tokens"] = {p["speaker"]: stats["tokens"].get(p["speaker"], {"input": 0, "output": 0}) for p in participants}
                                stats["response_times"] = {p["speaker"]: stats["response_times"].get(p["speaker"], []) for p in participants}
                                yield StreamEvent(
                                    type=StreamEventType.BACKROOMS_COMMAND,
                                    command_name="remove_ai",
                                    command_result=f"[{remove_label} has left the conversation]",
                                    command_success=True,
                                    speaker=speaker,
                                )

            # Signal turn end
            yield StreamEvent(
                type=StreamEventType.BACKROOMS_TURN_END,
                model_label=model_label,
                model_id=model_id,
                speaker=speaker,
                text=display_text,
            )

            turns_completed += 1
            total_attempts += 1

            # Check if we've hit the target
            if turns_completed >= target_turns or total_attempts >= MAX_TURNS:
                break

            # Pacing delay — use speed multiplier
            delay_range = SPEED_DELAYS.get(session_state.speed, TURN_DELAY)
            delay = random.uniform(*delay_range)
            yield StreamEvent(type=StreamEventType.BACKROOMS_STATUS, text="...")
            await asyncio.sleep(delay)

        # Always emit pause after loop ends (whether via break or condition)
        pause_reason = "step complete" if step_mode else "round complete"
        yield StreamEvent(type=StreamEventType.BACKROOMS_PAUSED, text=pause_reason)

        # Emit stats
        yield StreamEvent(
            type=StreamEventType.BACKROOMS_STATS,
            stats=stats,
        )

        # Save stats to session metadata
        try:
            current_meta = self.db.get_conversation_metadata(session_id) or {}
            current_meta["last_stats"] = stats
            self.db.update_conversation_metadata(session_id, current_meta)
        except Exception:
            pass  # Non-critical

        # Final usage summary
        total_cost = self.db.get_conversation_cost(session_id)
        yield StreamEvent(
            type=StreamEventType.USAGE,
            input_tokens=total_cost["input_tokens"],
            output_tokens=total_cost["output_tokens"],
        )
        yield StreamEvent(type=StreamEventType.MESSAGE_DONE)

    # ------------------------------------------------------------------
    # Context injection — appends active files/pins to system prompts
    # ------------------------------------------------------------------

    def _build_injected_context_block(self, session_id: str) -> str:
        """Build XML block of injected context from all registered ContextSources."""
        parts = []
        for source in self.context_sources:
            items = source.get_active(session_id)
            if items:
                block = source.format_block(items)
                if block:
                    parts.append(block)
        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Message building — role-flipping (generalized for N participants)
    # ------------------------------------------------------------------

    def _build_messages_for_model(
        self,
        messages: list[Message],
        target_speaker: str,
        participants: list[dict],
        whisper_filter: str | None = None,
    ) -> list[dict]:
        """Build API messages from the target model's perspective.

        - Target model's messages → role: "assistant"
        - Other model's messages → role: "user" with label prefix
        - Curator messages → role: "user"
        - Whisper messages → included only if target or source matches

        Speaker labels map: speaker → participant label for labeling.
        """
        # Build speaker→label lookup
        speaker_labels = {p["speaker"]: p["label"] for p in participants}

        raw = []
        for msg in messages:
            speaker = msg.speaker
            text = msg.text()

            # Filter whisper messages — only visible to source and target
            if text.startswith("[whisper to "):
                if whisper_filter:
                    # Extract target name from "[whisper to {target}]: ..."
                    target_name = text.split("]")[0].replace("[whisper to ", "")
                    target_speaker_id = None
                    for p in participants:
                        if p["label"] == target_name:
                            target_speaker_id = p["speaker"]
                            break
                    # Only include if this model is the source or target
                    if speaker != whisper_filter and target_speaker_id != whisper_filter:
                        continue

            if speaker == target_speaker:
                # Own messages — assistant role
                raw.append({"role": "assistant", "content": text})
            elif speaker in speaker_labels:
                # Another model's message — user role with label
                label = speaker_labels[speaker]
                content = self._build_labeled_content(msg, f"[{label}]")
                raw.append({"role": "user", "content": content})
            elif speaker in ("system", "command"):
                raw.append({"role": "user", "content": text})
            else:
                # curator or unknown — may have images
                if self._has_image_blocks(msg):
                    content = self._content_as_api_blocks(msg)
                    raw.append({"role": "user", "content": content})
                else:
                    raw.append({"role": "user", "content": text})

        return self._merge_consecutive_roles(raw)

    @staticmethod
    def _has_image_blocks(msg: Message) -> bool:
        """Check if a message contains image content blocks."""
        if isinstance(msg.content, str):
            return False
        return any(b.type == "image" for b in msg.content)

    @staticmethod
    def _content_as_api_blocks(msg: Message) -> list[dict]:
        """Convert message content to API-format block list."""
        if isinstance(msg.content, str):
            return [{"type": "text", "text": msg.content}]
        return [b.model_dump(exclude_none=True) for b in msg.content]

    @staticmethod
    def _build_labeled_content(msg: Message, label: str) -> str | list[dict]:
        """Build content with a label prefix. Returns a string for text-only
        messages, or a block list when images are present."""
        text = msg.text()
        if isinstance(msg.content, str) or not any(b.type == "image" for b in msg.content):
            return f"{label}: {text}"
        # Has images — build block list with label on text
        blocks = [{"type": "text", "text": f"{label}: {text}"}]
        for b in msg.content:
            if b.type == "image":
                blocks.append(b.model_dump(exclude_none=True))
        return blocks

    @staticmethod
    def _merge_consecutive_roles(messages: list[dict]) -> list[dict]:
        """Merge consecutive same-role messages to ensure strict alternation.

        Handles both string content and list-of-blocks content. When merging
        a string with a list (or two lists), normalizes everything to a list.
        """
        if not messages:
            return []

        def _to_blocks(content):
            if isinstance(content, str):
                return [{"type": "text", "text": content}]
            return list(content)

        def _merge_content(a, b):
            if isinstance(a, str) and isinstance(b, str):
                return a + "\n\n" + b
            blocks_a = _to_blocks(a)
            blocks_b = _to_blocks(b)
            return blocks_a + [{"type": "text", "text": "\n\n"}] + blocks_b

        merged = [messages[0].copy()]
        for msg in messages[1:]:
            if msg["role"] == merged[-1]["role"]:
                merged[-1]["content"] = _merge_content(merged[-1]["content"], msg["content"])
            else:
                merged.append(msg.copy())
        return merged
