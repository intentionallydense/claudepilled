"""Tests for the conversation export parser."""

import json
import tempfile
from pathlib import Path

from src.parser import Episode, parse_export, _extract_text, _parse_conversation


def _make_export(conversations):
    """Write conversations to a temp file and return path."""
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(conversations, f)
    f.close()
    return f.name


def test_extract_text_simple():
    msg = {"content": [{"type": "text", "text": "hello world"}]}
    assert _extract_text(msg) == "hello world"


def test_extract_text_strips_tool_use():
    msg = {
        "content": [
            {"type": "text", "text": "Let me search for that."},
            {"type": "tool_use", "name": "search", "input": {"q": "test"}},
            {"type": "tool_result", "content": "result"},
            {"type": "text", "text": "Here's what I found."},
        ]
    }
    assert _extract_text(msg) == "Let me search for that.\nHere's what I found."


def test_extract_text_strips_thinking():
    msg = {
        "content": [
            {"type": "thinking", "text": "internal reasoning"},
            {"type": "text", "text": "The answer is 42."},
        ]
    }
    assert _extract_text(msg) == "The answer is 42."


def test_parse_empty_conversation():
    conv = {"uuid": "abc", "name": "empty", "chat_messages": []}
    assert _parse_conversation(conv) == []


def test_parse_single_turn():
    conv = {
        "uuid": "abc",
        "name": "test",
        "created_at": "2025-06-01T00:00:00Z",
        "chat_messages": [
            {
                "sender": "human",
                "created_at": "2025-06-01T00:00:00Z",
                "content": [{"type": "text", "text": "What is 2+2?"}],
            },
            {
                "sender": "assistant",
                "created_at": "2025-06-01T00:00:01Z",
                "content": [{"type": "text", "text": "4"}],
            },
        ],
    }
    episodes = _parse_conversation(conv)
    assert len(episodes) == 1
    assert "What is 2+2?" in episodes[0].content
    assert "4" in episodes[0].content
    assert episodes[0].conversation_title == "test"


def test_parse_export_sorts_chronologically():
    convs = [
        {
            "uuid": "b",
            "name": "later",
            "created_at": "2025-06-02T00:00:00Z",
            "chat_messages": [
                {"sender": "human", "created_at": "2025-06-02T00:00:00Z",
                 "content": [{"type": "text", "text": "B"}]},
                {"sender": "assistant", "created_at": "2025-06-02T00:00:01Z",
                 "content": [{"type": "text", "text": "b"}]},
            ],
        },
        {
            "uuid": "a",
            "name": "earlier",
            "created_at": "2025-06-01T00:00:00Z",
            "chat_messages": [
                {"sender": "human", "created_at": "2025-06-01T00:00:00Z",
                 "content": [{"type": "text", "text": "A"}]},
                {"sender": "assistant", "created_at": "2025-06-01T00:00:01Z",
                 "content": [{"type": "text", "text": "a"}]},
            ],
        },
    ]
    path = _make_export(convs)
    episodes = parse_export(path)
    assert len(episodes) == 2
    assert episodes[0].conversation_title == "earlier"
    assert episodes[1].conversation_title == "later"
    Path(path).unlink()


def test_parse_export_date_filter():
    convs = [
        {
            "uuid": "old",
            "name": "old",
            "created_at": "2024-01-01T00:00:00Z",
            "chat_messages": [
                {"sender": "human", "created_at": "2024-01-01T00:00:00Z",
                 "content": [{"type": "text", "text": "old"}]},
                {"sender": "assistant", "created_at": "2024-01-01T00:00:01Z",
                 "content": [{"type": "text", "text": "old"}]},
            ],
        },
        {
            "uuid": "new",
            "name": "new",
            "created_at": "2025-06-01T00:00:00Z",
            "chat_messages": [
                {"sender": "human", "created_at": "2025-06-01T00:00:00Z",
                 "content": [{"type": "text", "text": "new"}]},
                {"sender": "assistant", "created_at": "2025-06-01T00:00:01Z",
                 "content": [{"type": "text", "text": "new"}]},
            ],
        },
    ]
    path = _make_export(convs)
    episodes = parse_export(path, after="2025-01-01")
    assert len(episodes) == 1
    assert episodes[0].conversation_title == "new"
    Path(path).unlink()
