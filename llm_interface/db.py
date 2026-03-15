"""SQLite persistence layer for conversations and messages."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from llm_interface.models import Conversation, ContentBlock, Message

_NEW_DB_DIR = os.path.join(str(Path.home()), ".llm-interface")
_OLD_DB_DIR = os.path.join(str(Path.home()), ".claude-wrapper")

# Auto-migrate: use existing data from old location if new location doesn't exist yet
if os.path.isdir(_OLD_DB_DIR) and not os.path.isdir(_NEW_DB_DIR):
    os.rename(_OLD_DB_DIR, _NEW_DB_DIR)

DEFAULT_DB_PATH = os.path.join(_NEW_DB_DIR, "data.db")


class Database:
    """Simple SQLite store for conversations and messages."""

    def __init__(self, db_path: str = DEFAULT_DB_PATH):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.db_path = db_path
        self._init_tables()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_tables(self) -> None:
        conn = self._connect()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New conversation',
                system_prompt TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv
                ON messages(conversation_id, created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prompts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                content TEXT NOT NULL,
                token_count INTEGER NOT NULL DEFAULT 0,
                uploaded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS email_log (
                id TEXT PRIMARY KEY,
                message_id TEXT UNIQUE,
                sender TEXT NOT NULL,
                subject TEXT NOT NULL,
                body_preview TEXT,
                received_at TEXT NOT NULL,
                processed_at TEXT NOT NULL,
                actions TEXT NOT NULL DEFAULT '[]',
                model_used TEXT,
                parse_result TEXT,
                archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_email_log_received
                ON email_log(received_at);
            CREATE INDEX IF NOT EXISTS idx_email_log_archived
                ON email_log(archived);
        """)
        conn.commit()

        # Migrations — idempotent column additions
        conv_migrations = [
            ("total_input_tokens", "INTEGER", "0"),
            ("total_output_tokens", "INTEGER", "0"),
            ("total_cost", "REAL", "0.0"),
            ("current_leaf_id", "TEXT", "NULL"),
            ("type", "TEXT", "'chat'"),
            ("metadata", "TEXT", "NULL"),
            ("prompt_id", "TEXT", "NULL"),
            ("active_file_ids", "TEXT", "'[]'"),
            ("active_pin_ids", "TEXT", "'[]'"),
            ("total_cache_creation_tokens", "INTEGER", "0"),
            ("total_cache_read_tokens", "INTEGER", "0"),
        ]
        for col, col_type, default in conv_migrations:
            try:
                conn.execute(f"ALTER TABLE conversations ADD COLUMN {col} {col_type} DEFAULT {default}")
            except sqlite3.OperationalError:
                pass

        # Prompts migrations
        try:
            conn.execute("ALTER TABLE prompts ADD COLUMN category TEXT DEFAULT 'chat'")
        except sqlite3.OperationalError:
            pass

        msg_migrations = [
            ("input_tokens", "INTEGER", "0"),
            ("output_tokens", "INTEGER", "0"),
            ("cost", "REAL", "0.0"),
            ("parent_id", "TEXT", "NULL"),
            ("speaker", "TEXT", "NULL"),
            ("cache_creation_input_tokens", "INTEGER", "0"),
            ("cache_read_input_tokens", "INTEGER", "0"),
        ]
        for col, col_type, default in msg_migrations:
            try:
                conn.execute(f"ALTER TABLE messages ADD COLUMN {col} {col_type} DEFAULT {default}")
            except sqlite3.OperationalError:
                pass

        conn.commit()

        # Data migrations — rename couch → backrooms
        conn.execute("UPDATE conversations SET type = 'backrooms' WHERE type = 'couch'")
        conn.execute("UPDATE prompts SET category = 'backrooms' WHERE category = 'couch'")
        conn.commit()

        # Migrate couch setting keys → backrooms (one-time, idempotent)
        for seat in ("1", "2"):
            old_key = f"couch_seat_{seat}_suffix"
            new_key = f"backrooms_seat_{seat}_suffix"
            old_val = conn.execute("SELECT value FROM settings WHERE key = ?", (old_key,)).fetchone()
            new_val = conn.execute("SELECT value FROM settings WHERE key = ?", (new_key,)).fetchone()
            if old_val and not new_val:
                conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (new_key, old_val["value"]))
        conn.commit()

        # email_log migrations
        try:
            conn.execute("ALTER TABLE email_log ADD COLUMN classification TEXT DEFAULT NULL")
            conn.commit()
        except sqlite3.OperationalError:
            pass

        # Backfill parent_id for existing messages that lack them
        self._backfill_parent_ids(conn)

        conn.close()

    def _backfill_parent_ids(self, conn: sqlite3.Connection) -> None:
        """Set parent_id on existing messages based on creation order."""
        rows = conn.execute(
            "SELECT id, conversation_id FROM messages WHERE parent_id IS NULL ORDER BY conversation_id, created_at"
        ).fetchall()
        if not rows:
            return

        prev_by_conv: dict[str, str] = {}
        for row in rows:
            msg_id = row["id"]
            conv_id = row["conversation_id"]
            parent = prev_by_conv.get(conv_id)
            if parent:
                conn.execute("UPDATE messages SET parent_id = ? WHERE id = ?", (parent, msg_id))
            prev_by_conv[conv_id] = msg_id

        # Also backfill current_leaf_id for conversations that lack it
        conn.execute("""
            UPDATE conversations SET current_leaf_id = (
                SELECT id FROM messages
                WHERE conversation_id = conversations.id
                ORDER BY created_at DESC LIMIT 1
            ) WHERE current_leaf_id IS NULL
        """)
        conn.commit()

    # ------------------------------------------------------------------
    # Conversations
    # ------------------------------------------------------------------

    def save_conversation(self, conv: Conversation, conv_type: str = "chat", metadata: str | None = None) -> None:
        conn = self._connect()
        conn.execute(
            """INSERT OR REPLACE INTO conversations
               (id, title, system_prompt, model, created_at, updated_at,
                total_input_tokens, total_output_tokens, total_cost, current_leaf_id,
                type, metadata, prompt_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                conv.id,
                conv.title,
                conv.system_prompt,
                conv.model,
                conv.created_at.isoformat(),
                conv.updated_at.isoformat(),
                conv.total_input_tokens,
                conv.total_output_tokens,
                conv.total_cost,
                conv.current_leaf_id,
                conv_type,
                metadata,
                conv.prompt_id,
            ),
        )
        conn.commit()
        conn.close()

    def load_conversation(self, conversation_id: str) -> Conversation | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if row is None:
            conn.close()
            return None

        keys = row.keys()
        leaf_id = row["current_leaf_id"] if "current_leaf_id" in keys else None

        # Load messages along the current path (root to leaf)
        if leaf_id:
            messages = self._load_path(conn, conversation_id, leaf_id)
        else:
            messages = self._load_messages(conn, conversation_id)

        conn.close()
        return Conversation(
            id=row["id"],
            title=row["title"],
            system_prompt=row["system_prompt"],
            model=row["model"],
            messages=messages,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            current_leaf_id=leaf_id,
            total_input_tokens=row["total_input_tokens"] if "total_input_tokens" in keys else 0,
            total_output_tokens=row["total_output_tokens"] if "total_output_tokens" in keys else 0,
            total_cost=row["total_cost"] if "total_cost" in keys else 0.0,
            total_cache_creation_tokens=row["total_cache_creation_tokens"] if "total_cache_creation_tokens" in keys else 0,
            total_cache_read_tokens=row["total_cache_read_tokens"] if "total_cache_read_tokens" in keys else 0,
            prompt_id=row["prompt_id"] if "prompt_id" in keys else None,
        )

    def list_conversations(self) -> list[dict]:
        conn = self._connect()
        rows = conn.execute(
            """SELECT id, title, model, created_at, updated_at,
                      total_input_tokens, total_output_tokens, total_cost,
                      COALESCE(type, 'chat') as type, metadata
               FROM conversations
               ORDER BY updated_at DESC"""
        ).fetchall()
        conn.close()
        return [dict(row) for row in rows]

    def list_conversations_by_type(self, conv_type: str) -> list[dict]:
        conn = self._connect()
        rows = conn.execute(
            """SELECT id, title, model, created_at, updated_at,
                      total_input_tokens, total_output_tokens, total_cost,
                      metadata
               FROM conversations
               WHERE type = ?
               ORDER BY updated_at DESC""",
            (conv_type,),
        ).fetchall()
        conn.close()
        return [dict(row) for row in rows]

    def get_conversation_metadata(self, conversation_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT metadata FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        conn.close()
        if row is None or row["metadata"] is None:
            return None
        return json.loads(row["metadata"])

    def update_conversation_metadata(self, conversation_id: str, metadata: dict) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET metadata = ?, updated_at = ? WHERE id = ?",
            (json.dumps(metadata), now, conversation_id),
        )
        conn.commit()
        conn.close()

    def delete_conversation(self, conversation_id: str) -> None:
        conn = self._connect()
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        conn.commit()
        conn.close()

    def update_conversation_title(self, conversation_id: str, title: str) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (title, now, conversation_id),
        )
        conn.commit()
        conn.close()

    def update_conversation_model(self, conversation_id: str, model: str) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?",
            (model, now, conversation_id),
        )
        conn.commit()
        conn.close()

    def update_conversation_system_prompt(self, conversation_id: str, system_prompt: str) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET system_prompt = ?, updated_at = ? WHERE id = ?",
            (system_prompt, now, conversation_id),
        )
        conn.commit()
        conn.close()

    def update_conversation_prompt_id(self, conversation_id: str, prompt_id: str | None) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET prompt_id = ?, updated_at = ? WHERE id = ?",
            (prompt_id, now, conversation_id),
        )
        conn.commit()
        conn.close()

    def touch_conversation(self, conversation_id: str) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        conn.commit()
        conn.close()

    def get_conversation_cost(self, conversation_id: str) -> dict:
        conn = self._connect()
        row = conn.execute(
            """SELECT total_input_tokens, total_output_tokens, total_cost,
                      total_cache_creation_tokens, total_cache_read_tokens
               FROM conversations WHERE id = ?""",
            (conversation_id,),
        ).fetchone()
        conn.close()
        if row is None:
            return {"input_tokens": 0, "output_tokens": 0, "cost": 0.0,
                    "cache_creation_tokens": 0, "cache_read_tokens": 0}
        keys = row.keys()
        return {
            "input_tokens": row["total_input_tokens"],
            "output_tokens": row["total_output_tokens"],
            "cost": row["total_cost"],
            "cache_creation_tokens": row["total_cache_creation_tokens"] if "total_cache_creation_tokens" in keys else 0,
            "cache_read_tokens": row["total_cache_read_tokens"] if "total_cache_read_tokens" in keys else 0,
        }

    def get_message(self, message_id: str) -> Message | None:
        """Load a single message by ID."""
        conn = self._connect()
        row = conn.execute(
            "SELECT * FROM messages WHERE id = ?", (message_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        return self._row_to_message(row)

    def set_current_leaf(self, conversation_id: str, leaf_id: str) -> None:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE conversations SET current_leaf_id = ?, updated_at = ? WHERE id = ?",
            (leaf_id, now, conversation_id),
        )
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    def save_message(
        self,
        conversation_id: str,
        msg: Message,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost: float = 0.0,
        speaker: str | None = None,
        cache_creation_input_tokens: int = 0,
        cache_read_input_tokens: int = 0,
    ) -> None:
        content_json = self._serialize_content(msg.content)
        conn = self._connect()
        conn.execute(
            """INSERT OR REPLACE INTO messages
               (id, conversation_id, role, content, created_at, input_tokens, output_tokens, cost,
                parent_id, speaker, cache_creation_input_tokens, cache_read_input_tokens)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg.id,
                conversation_id,
                msg.role,
                content_json,
                msg.created_at.isoformat(),
                input_tokens,
                output_tokens,
                cost,
                msg.parent_id,
                speaker or msg.speaker,
                cache_creation_input_tokens,
                cache_read_input_tokens,
            ),
        )
        # Update current_leaf_id and accumulate totals
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """UPDATE conversations
               SET total_input_tokens = total_input_tokens + ?,
                   total_output_tokens = total_output_tokens + ?,
                   total_cost = total_cost + ?,
                   total_cache_creation_tokens = total_cache_creation_tokens + ?,
                   total_cache_read_tokens = total_cache_read_tokens + ?,
                   current_leaf_id = ?,
                   updated_at = ?
               WHERE id = ?""",
            (input_tokens, output_tokens, cost, cache_creation_input_tokens, cache_read_input_tokens,
             msg.id, now, conversation_id),
        )
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Tree operations
    # ------------------------------------------------------------------

    def get_tree(self, conversation_id: str) -> dict:
        """Return all messages as a tree structure with the current path."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT id, role, content, parent_id, created_at, speaker FROM messages WHERE conversation_id = ? ORDER BY created_at",
            (conversation_id,),
        ).fetchall()

        conv_row = conn.execute(
            "SELECT current_leaf_id FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        conn.close()

        leaf_id = conv_row["current_leaf_id"] if conv_row else None
        current_path = self._compute_path_ids(rows, leaf_id) if leaf_id else []

        nodes = []
        for row in rows:
            raw = json.loads(row["content"])
            if isinstance(raw, dict) and raw.get("type") == "text":
                preview = raw["value"][:80]
            elif isinstance(raw, list):
                text_parts = [b.get("text", "") for b in raw if b.get("type") == "text" and b.get("text")]
                preview = "".join(text_parts)[:80]
                # If no text but has image blocks, show a placeholder so the
                # tree doesn't confuse this with a tool_result (which also
                # has an empty preview).
                if not preview and any(b.get("type") == "image" for b in raw):
                    preview = "[image]"
            else:
                preview = str(raw)[:80]
            node = {
                "id": row["id"],
                "role": row["role"],
                "parent_id": row["parent_id"],
                "preview": preview,
            }
            # Include speaker for backrooms sessions (null for regular chat)
            if row["speaker"]:
                node["speaker"] = row["speaker"]
            nodes.append(node)

        return {"nodes": nodes, "current_path": current_path}

    def get_path(self, conversation_id: str, leaf_id: str) -> list[str]:
        """Return ordered message IDs from root to the given leaf."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT id, parent_id FROM messages WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchall()
        conn.close()
        return self._compute_path_ids(rows, leaf_id)

    def _load_path(self, conn: sqlite3.Connection, conversation_id: str, leaf_id: str) -> list[Message]:
        """Load messages along the path from root to leaf."""
        rows = conn.execute(
            "SELECT id, parent_id FROM messages WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchall()
        path_ids = self._compute_path_ids(rows, leaf_id)
        if not path_ids:
            return self._load_messages(conn, conversation_id)

        # Load messages in path order
        placeholders = ",".join("?" * len(path_ids))
        msg_rows = conn.execute(
            f"SELECT * FROM messages WHERE id IN ({placeholders})",
            path_ids,
        ).fetchall()
        msg_map = {r["id"]: r for r in msg_rows}
        return [self._row_to_message(msg_map[mid]) for mid in path_ids if mid in msg_map]

    @staticmethod
    def _compute_path_ids(rows, leaf_id: str) -> list[str]:
        """Walk parent pointers from leaf to root, return root-to-leaf order."""
        parent_map = {r["id"]: r["parent_id"] for r in rows}
        path = []
        current = leaf_id
        seen = set()
        while current and current in parent_map and current not in seen:
            seen.add(current)
            path.append(current)
            current = parent_map[current]
        path.reverse()
        return path

    def find_leaf(self, conversation_id: str, node_id: str) -> str:
        """Find the deepest descendant of a node (following first children)."""
        conn = self._connect()
        rows = conn.execute(
            "SELECT id, parent_id FROM messages WHERE conversation_id = ? ORDER BY created_at",
            (conversation_id,),
        ).fetchall()
        conn.close()

        # Build children map
        children: dict[str, list[str]] = {}
        for row in rows:
            pid = row["parent_id"]
            if pid:
                children.setdefault(pid, []).append(row["id"])

        # Walk down following first child
        current = node_id
        while current in children and children[current]:
            current = children[current][0]
        return current

    def _load_messages(self, conn: sqlite3.Connection, conversation_id: str) -> list[Message]:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at",
            (conversation_id,),
        ).fetchall()
        return [self._row_to_message(row) for row in rows]

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    def get_setting(self, key: str) -> str | None:
        conn = self._connect()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        conn.close()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        conn = self._connect()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
        conn.close()

    def get_all_settings(self) -> dict[str, str]:
        conn = self._connect()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()
        return {row["key"]: row["value"] for row in rows}

    # ------------------------------------------------------------------
    # Prompts library
    # ------------------------------------------------------------------

    def list_prompts(self, category: str | None = None) -> list[dict]:
        conn = self._connect()
        if category:
            rows = conn.execute(
                "SELECT id, name, content, category, created_at FROM prompts WHERE category = ? ORDER BY name",
                (category,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name, content, category, created_at FROM prompts ORDER BY name"
            ).fetchall()
        conn.close()
        return [dict(row) for row in rows]

    def get_prompt(self, prompt_id: str) -> dict | None:
        conn = self._connect()
        row = conn.execute(
            "SELECT id, name, content, category, created_at FROM prompts WHERE id = ?",
            (prompt_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def save_prompt(self, prompt_id: str, name: str, content: str, category: str = "chat") -> dict:
        conn = self._connect()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT OR REPLACE INTO prompts (id, name, content, category, created_at) VALUES (?, ?, ?, ?, ?)",
            (prompt_id, name, content, category, now),
        )
        conn.commit()
        conn.close()
        return {"id": prompt_id, "name": name, "content": content, "category": category, "created_at": now}

    def delete_prompt(self, prompt_id: str) -> None:
        conn = self._connect()
        conn.execute("DELETE FROM prompts WHERE id = ?", (prompt_id,))
        conn.commit()
        conn.close()

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search_messages(self, query: str, limit: int = 20) -> list[dict]:
        """Search message content with LIKE, return results grouped by conversation.

        The content column stores JSON (either {"type":"text","value":"..."} or a list
        of content blocks). LIKE '%query%' matches against the raw JSON which naturally
        contains the text strings. Results are grouped by conversation — each entry has
        the conversation metadata plus a list of matching message previews.
        """
        if not query or not query.strip():
            return []
        pattern = f"%{query}%"
        conn = self._connect()
        rows = conn.execute(
            """SELECT m.id AS message_id, m.conversation_id, m.role, m.content, m.created_at,
                      c.title
               FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE COALESCE(c.type, 'chat') IN ('chat', 'backrooms')
                 AND m.content LIKE ?
               ORDER BY m.created_at DESC
               LIMIT ?""",
            (pattern, limit * 5),  # fetch extra rows since we group by conversation
        ).fetchall()
        conn.close()

        # Group by conversation, keeping only the first few matches per conversation
        grouped: dict[str, dict] = {}
        for row in rows:
            conv_id = row["conversation_id"]
            if conv_id not in grouped:
                grouped[conv_id] = {
                    "conversation_id": conv_id,
                    "title": row["title"],
                    "matches": [],
                }
            if len(grouped[conv_id]["matches"]) >= 3:
                continue
            # Extract a text preview from the JSON content
            preview = self._extract_preview(row["content"], query)
            grouped[conv_id]["matches"].append({
                "message_id": row["message_id"],
                "role": row["role"],
                "preview": preview,
                "created_at": row["created_at"],
            })

        results = list(grouped.values())[:limit]
        return results

    @staticmethod
    def _extract_preview(content_json: str, query: str) -> str:
        """Pull a readable text snippet from the JSON content column, centered on the query."""
        try:
            raw = json.loads(content_json)
        except (json.JSONDecodeError, TypeError):
            raw = content_json

        if isinstance(raw, dict) and raw.get("type") == "text":
            text = raw.get("value", "")
        elif isinstance(raw, list):
            text = " ".join(
                b.get("text", "") for b in raw if isinstance(b, dict) and b.get("type") == "text"
            )
        else:
            text = str(raw)

        # Find query position and extract surrounding context
        lower_text = text.lower()
        idx = lower_text.find(query.lower())
        if idx == -1:
            return text[:120]
        start = max(0, idx - 40)
        end = min(len(text), idx + len(query) + 80)
        snippet = text[start:end].strip()
        if start > 0:
            snippet = "..." + snippet
        if end < len(text):
            snippet = snippet + "..."
        return snippet

    # ------------------------------------------------------------------
    # Serialization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _serialize_content(content: str | list[ContentBlock]) -> str:
        if isinstance(content, str):
            return json.dumps({"type": "text", "value": content})
        return json.dumps([block.model_dump(exclude_none=True) for block in content])

    @staticmethod
    def _row_to_message(row) -> Message:
        raw = json.loads(row["content"])
        if isinstance(raw, dict) and raw.get("type") == "text":
            content = raw["value"]
        elif isinstance(raw, list):
            content = [ContentBlock(**block) for block in raw]
        else:
            content = str(raw)
        keys = row.keys()
        return Message(
            id=row["id"],
            role=row["role"],
            content=content,
            parent_id=row["parent_id"] if "parent_id" in keys else None,
            speaker=row["speaker"] if "speaker" in keys else None,
            created_at=datetime.fromisoformat(row["created_at"]),
        )
