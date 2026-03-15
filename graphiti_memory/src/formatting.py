"""Context formatting for injection into Claude system prompts.

Takes raw Graphiti search results and formats them into a concise,
temporally-aware briefing that Claude can use naturally.
"""

from __future__ import annotations

from datetime import datetime


def format_context(
    nodes: list,
    edges: list,
    episodes: list,
    max_tokens: int = 1500,
) -> str:
    """Format graph search results into a <memory_context> block.

    Estimates ~4 chars per token. Prioritizes entity facts, then
    relationships, then episodic content. Truncates to max_tokens.
    """
    sections = []

    # Entity facts from nodes
    if nodes:
        facts = []
        for node in nodes:
            name = getattr(node, "name", str(node))
            summary = getattr(node, "summary", None)
            if summary:
                facts.append(f"- {name}: {summary}")
            else:
                facts.append(f"- {name}")
        if facts:
            sections.append("## Relevant entities\n" + "\n".join(facts))

    # Relationship facts from edges
    if edges:
        rels = []
        for edge in edges:
            fact = getattr(edge, "fact", None)
            created = getattr(edge, "created_at", None)
            date_str = ""
            if created:
                if isinstance(created, datetime):
                    date_str = f"[{created.strftime('%b %d')}] "
                elif isinstance(created, str):
                    try:
                        dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                        date_str = f"[{dt.strftime('%b %d')}] "
                    except ValueError:
                        pass
            if fact:
                rels.append(f"- {date_str}{fact}")
        if rels:
            sections.append("## Relevant past context\n" + "\n".join(rels))

    # Episodic content
    if episodes:
        eps = []
        for ep in episodes:
            content = getattr(ep, "content", getattr(ep, "episode_body", str(ep)))
            ref_time = getattr(ep, "valid_at", getattr(ep, "reference_time", None))
            date_str = ""
            if ref_time:
                if isinstance(ref_time, datetime):
                    date_str = f"[{ref_time.strftime('%b %d')}] "
                elif isinstance(ref_time, str):
                    try:
                        dt = datetime.fromisoformat(ref_time.replace("Z", "+00:00"))
                        date_str = f"[{dt.strftime('%b %d')}] "
                    except ValueError:
                        pass
            # Truncate long episode content
            if len(content) > 300:
                content = content[:300] + "..."
            eps.append(f"- {date_str}{content}")
        if eps:
            sections.append("## Related conversations\n" + "\n".join(eps))

    if not sections:
        return ""

    full = "<memory_context>\n" + "\n\n".join(sections) + "\n</memory_context>"

    # Rough token limit (4 chars per token)
    max_chars = max_tokens * 4
    if len(full) > max_chars:
        full = full[:max_chars] + "\n[context truncated]\n</memory_context>"

    return full
