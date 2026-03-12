"""Email ingestion: fetch unread emails via IMAP, parse with LLM, create tasks.

Called by the cron CLI (cli_main) or POST /api/emails/ingest endpoint.
Follows briefing_assembly.py pattern: standalone module with cli_main() entry point.

Flow:
  1. Connect to IMAP inbox, fetch UNSEEN messages (without marking SEEN)
  2. For each email: dedup check → LLM parse → create tasks → log to DB
  3. Mark email as SEEN in IMAP only after successful processing
  4. If processing fails, email stays UNSEEN for retry on next run

Model status is tracked in `ingestion_status` so the tasks page can show
a banner when GLM5 is down (Haiku fallback) or both models are unavailable.
"""

from __future__ import annotations

import email
import email.header
import email.utils
import hashlib
import html
import imaplib
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

from claude_wrapper.models import PROVIDERS

log = logging.getLogger(__name__)

# GLM5 via OpenRouter — reasoning enabled for better parsing
_SYSTEM_MODEL = "z-ai/glm-5"

_DEFAULT_PARSE_PROMPT = """\
You are parsing a forwarded email to extract actionable tasks.

Given the email below, determine what tasks to create:
- If it contains a task, to-do item, deadline, or action required, extract it as a task
- An email can produce multiple tasks, or none if it's not actionable
- Always include "email-ingested" in the tags list
- Set priority to "H", "M", or "L" if you can infer it, otherwise null
- Set due to an ISO date string if there's a deadline mentioned, otherwise null

Return JSON only, no other text:
{
  "actions": [
    {"type": "task", "title": "...", "description": "...", "priority": null, "due": null, "project": null, "tags": ["email-ingested"]}
  ],
  "summary": "One-line summary of the email"
}

If the email is not actionable (spam, newsletter, automated notification, etc.), return:
{"actions": [], "summary": "Not actionable — ...reason..."}
"""

# ---------------------------------------------------------------------------
# Ingestion status — tracks which model is active so the UI can show warnings
# ---------------------------------------------------------------------------
# Possible states:
#   "ok"       — GLM5 working normally
#   "fallback" — GLM5 down, using Haiku
#   "down"     — both models failed
ingestion_status: dict[str, Any] = {
    "state": "ok",
    "detail": None,
    "last_updated": None,
}


def _update_status(state: str, detail: str | None = None) -> None:
    ingestion_status["state"] = state
    ingestion_status["detail"] = detail
    ingestion_status["last_updated"] = datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# IMAP fetching — returns emails WITHOUT marking them as SEEN
# ---------------------------------------------------------------------------

def _connect_imap(host: str, user: str, password: str) -> imaplib.IMAP4_SSL | None:
    """Connect and authenticate to IMAP. Returns connection or None."""
    try:
        mail = imaplib.IMAP4_SSL(host)
        mail.login(user, password)
        mail.select("INBOX")
        return mail
    except Exception as e:
        log.error("IMAP connection failed: %s", e)
        return None


def fetch_unread_emails(
    mail: imaplib.IMAP4_SSL, max_fetch: int = 100
) -> list[dict]:
    """Fetch UNSEEN messages without marking them as SEEN.

    Each returned dict includes an '_imap_uid' field so the caller can
    mark individual emails as SEEN after successful processing.
    """
    results = []
    try:
        status, data = mail.search(None, "UNSEEN")
        if status != "OK" or not data[0]:
            return results

        msg_ids = data[0].split()[:max_fetch]
        for msg_id in msg_ids:
            try:
                status, msg_data = mail.fetch(msg_id, "(RFC822)")
                if status != "OK":
                    continue
                raw = msg_data[0][1]
                parsed = _parse_email(raw)
                if parsed:
                    parsed["_imap_uid"] = msg_id
                    results.append(parsed)
            except Exception as e:
                log.warning("Failed to parse email %s: %s", msg_id, e)
    except Exception as e:
        log.error("IMAP fetch failed: %s", e)

    return results


def mark_seen(mail: imaplib.IMAP4_SSL, imap_uid: bytes) -> None:
    """Mark a single email as SEEN in IMAP."""
    try:
        mail.store(imap_uid, "+FLAGS", "\\Seen")
    except Exception as e:
        log.warning("Failed to mark email %s as SEEN: %s", imap_uid, e)


def _make_dedup_id(em: dict) -> str:
    """Generate a dedup key: Message-ID if present, else a content hash."""
    if em.get("message_id"):
        return em["message_id"]
    # Fallback: hash of sender + subject + date
    raw = f"{em.get('sender', '')}|{em.get('subject', '')}|{em.get('received_at', '')}"
    return f"hash:{hashlib.sha256(raw.encode()).hexdigest()[:24]}"


def _parse_email(raw: bytes) -> dict | None:
    """Parse a raw email into a structured dict."""
    msg = email.message_from_bytes(raw)

    # Decode subject
    subject_parts = email.header.decode_header(msg["Subject"] or "")
    subject = ""
    for part, charset in subject_parts:
        if isinstance(part, bytes):
            subject += part.decode(charset or "utf-8", errors="replace")
        else:
            subject += part

    sender = msg["From"] or ""
    message_id = msg["Message-ID"] or ""

    # Parse date
    date_str = msg["Date"]
    received_at = None
    if date_str:
        parsed_date = email.utils.parsedate_to_datetime(date_str)
        if parsed_date:
            received_at = parsed_date.isoformat()
    if not received_at:
        received_at = datetime.now(timezone.utc).isoformat()

    # Extract body — prefer text/plain, fall back to stripped text/html
    body = _extract_body(msg)
    if not body:
        return None

    return {
        "message_id": message_id,
        "sender": sender,
        "subject": subject,
        "body": body,
        "received_at": received_at,
    }


def _extract_body(msg: email.message.Message) -> str:
    """Extract plain text body from an email message."""
    if msg.is_multipart():
        text_parts = []
        html_parts = []
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    text_parts.append(payload.decode(charset, errors="replace"))
            elif ctype == "text/html":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    html_parts.append(payload.decode(charset, errors="replace"))

        if text_parts:
            return "\n".join(text_parts)[:5000]
        if html_parts:
            return _strip_html("\n".join(html_parts))[:5000]
        return ""
    else:
        payload = msg.get_payload(decode=True)
        if not payload:
            return ""
        charset = msg.get_content_charset() or "utf-8"
        text = payload.decode(charset, errors="replace")
        if msg.get_content_type() == "text/html":
            text = _strip_html(text)
        return text[:5000]


def _strip_html(html_text: str) -> str:
    """Rough HTML-to-text conversion — strips tags and decodes entities."""
    text = re.sub(r"<br\s*/?>", "\n", html_text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    # Collapse whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------------------
# LLM parsing
# ---------------------------------------------------------------------------

def parse_email_with_llm(
    sender: str, subject: str, body: str, parse_prompt: str | None = None,
) -> dict:
    """Call GLM5 (or Haiku fallback) to extract actions from an email.

    Returns {"actions": [...], "summary": "...", "model_used": "..."}.
    parse_prompt overrides the default prompt if provided (e.g. from saved prompts).
    Also updates ingestion_status so the tasks page can show model health.
    """
    prompt = parse_prompt or _DEFAULT_PARSE_PROMPT
    user_content = f"{prompt}\n\nEmail from: {sender}\nSubject: {subject}\n\n{body[:3000]}"

    # Try GLM5 via OpenRouter
    result = _call_glm5(user_content)
    if result is not None:
        _update_status("ok")
        return {**result, "model_used": "GLM-5"}

    # Fallback to Haiku
    log.info("GLM5 unavailable, falling back to Haiku for email parsing")
    result = _call_haiku(user_content)
    if result is not None:
        _update_status("fallback", "GLM-5 unavailable — using Haiku")
        return {**result, "model_used": "Haiku 4.5"}

    # Both failed
    _update_status("down", "Both GLM-5 and Haiku are unavailable")
    return {"actions": [], "summary": "Parsing failed", "model_used": None}


def _call_glm5(user_content: str) -> dict | None:
    """Call GLM5 via OpenRouter synchronously. Returns parsed JSON or None."""
    api_key = os.environ.get(PROVIDERS["openrouter"]["env_key"], "")
    if not api_key:
        return None

    try:
        from openai import OpenAI

        client = OpenAI(
            api_key=api_key,
            base_url=PROVIDERS["openrouter"]["base_url"],
        )
        response = client.chat.completions.create(
            model=_SYSTEM_MODEL,
            messages=[{"role": "user", "content": user_content}],
        )
        content = response.choices[0].message.content
        if not content:
            return None
        return _parse_json_response(content)
    except Exception as e:
        log.warning("GLM5 email parsing failed: %s", e)
        return None


def _call_haiku(user_content: str) -> dict | None:
    """Call Haiku via Anthropic as fallback. Returns parsed JSON or None."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": user_content}],
        )
        content = response.content[0].text if response.content else None
        if not content:
            return None
        return _parse_json_response(content)
    except Exception as e:
        log.warning("Haiku email parsing failed: %s", e)
        return None


def _parse_json_response(text: str) -> dict | None:
    """Extract JSON from model response — handles markdown code blocks."""
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "actions" in parsed:
            return parsed
    except json.JSONDecodeError:
        log.warning("Failed to parse JSON from model response")

    return None


# ---------------------------------------------------------------------------
# Processing pipeline
# ---------------------------------------------------------------------------

def process_inbox(
    email_db: Any,
    task_db: Any,
    pin_db: Any = None,
    host: str | None = None,
    user: str | None = None,
    password: str | None = None,
    parse_prompt: str | None = None,
) -> list[dict]:
    """Fetch unread emails, parse with LLM, create tasks, log results.

    Each email is fully processed (LLM → tasks → DB log) before being
    marked as SEEN in IMAP. If processing fails, the email stays UNSEEN
    and will be retried on the next run.

    parse_prompt: custom prompt to use for LLM parsing (from saved prompts).
    Returns list of email log entries for all processed emails.
    """
    host = host or os.environ.get("EMAIL_IMAP_HOST", "imap.gmail.com")
    user = user or os.environ.get("EMAIL_IMAP_USER", "")
    password = password or os.environ.get("EMAIL_IMAP_PASSWORD", "")

    if not user or not password:
        log.error("EMAIL_IMAP_USER and EMAIL_IMAP_PASSWORD must be set")
        return []

    mail = _connect_imap(host, user, password)
    if not mail:
        return []

    try:
        emails = fetch_unread_emails(mail)
        if not emails:
            log.info("No unread emails to process")
            return []

        results = []
        for em in emails:
            imap_uid = em.pop("_imap_uid", None)

            # Dedup check — uses Message-ID or content hash fallback
            dedup_id = _make_dedup_id(em)
            if email_db.get_by_message_id(dedup_id):
                log.info("Skipping duplicate email: %s", em["subject"])
                # Still mark as seen so we don't re-fetch it
                if imap_uid:
                    mark_seen(mail, imap_uid)
                continue

            # Store the dedup_id as message_id for DB logging
            em["message_id"] = dedup_id

            # Parse with LLM
            parse_result = parse_email_with_llm(
                em["sender"], em["subject"], em["body"], parse_prompt=parse_prompt,
            )

            # If both models are down, leave email UNSEEN for retry
            if parse_result.get("model_used") is None:
                log.warning("Skipping email (no model available): %s", em["subject"])
                continue

            classification = parse_result.get("classification")

            # Only create tasks from actionable emails
            created_actions = []
            if classification != "trash" and classification != "informational":
                for action in parse_result.get("actions", []):
                    if action.get("type") != "task":
                        continue
                    try:
                        task = task_db.create(
                            title=action.get("title", em["subject"]),
                            description=action.get("description", ""),
                            priority=action.get("priority"),
                            due=action.get("due"),
                            project=action.get("project"),
                            tags=action.get("tags", ["email-ingested"]),
                        )
                        created_actions.append({"type": "task", "id": task["id"]})
                        log.info("Created task: %s", task["title"])
                    except Exception as e:
                        log.warning("Failed to create task from email: %s", e)

            # Log to email_log
            entry = email_db.create(
                message_id=em["message_id"],
                sender=em["sender"],
                subject=em["subject"],
                body_preview=em["body"][:500],
                received_at=em["received_at"],
                actions=created_actions,
                model_used=parse_result.get("model_used"),
                parse_result=json.dumps(parse_result),
                classification=classification,
            )
            results.append(entry)

            # Only mark SEEN after successful processing + logging
            if imap_uid:
                mark_seen(mail, imap_uid)

        return results
    finally:
        try:
            mail.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _resolve_parse_prompt(db: Any) -> str | None:
    """Look up the email ingestion prompt from the saved prompts library.

    Uses the 'email_ingestion_prompt_id' setting to find the prompt.
    Returns the prompt content, or None to use the default.
    """
    prompt_id = db.get_setting("email_ingestion_prompt_id")
    if not prompt_id:
        return None
    prompt = db.get_prompt(prompt_id)
    if prompt and prompt.get("content"):
        return prompt["content"]
    return None


def cli_main() -> None:
    """CLI entry point for cron: fetch and process inbox emails."""
    from dotenv import load_dotenv

    from claude_wrapper.db import Database
    from claude_wrapper.email_db import EmailDatabase
    from claude_wrapper.task_db import TaskDatabase

    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    db = Database()
    email_db = EmailDatabase(db)
    task_db = TaskDatabase(db)
    parse_prompt = _resolve_parse_prompt(db)

    results = process_inbox(email_db, task_db, parse_prompt=parse_prompt)
    if results:
        print(f"Processed {len(results)} email(s):")
        for r in results:
            actions_str = ", ".join(
                f"{a['type']}:{a['id']}" for a in r.get("actions", [])
            ) or "no actions"
            print(f"  - {r['subject']}: {actions_str}")
    else:
        print("No new emails to process.")
