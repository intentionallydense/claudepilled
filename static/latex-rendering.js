/**
 * LaTeX rendering utilities — pre/post-process pattern for marked.js.
 *
 * Used by: app.js, backrooms-adapter.js, briefing.js (chat panel).
 *
 * Problem: marked.js interprets $, _, * inside LaTeX as markdown.
 * Solution: extract LaTeX before marked, replace with <span data-latex>
 * placeholders that survive DOMPurify, then restore with KaTeX output.
 */

let _latexStore = [];
let _codeStore = [];

/**
 * Extract LaTeX expressions from text, replacing them with placeholders.
 * Call BEFORE marked.parse(). Protects code fences/inline code first.
 * Supports: $$...$$, \[...\], $...$, \(...\)
 */
function extractLatex(text) {
    _latexStore = [];
    _codeStore = [];
    let result = text;

    // Step 0: protect code blocks and inline code from LaTeX extraction
    result = result.replace(/```[\s\S]*?```/g, (match) => {
        const idx = _codeStore.length;
        _codeStore.push(match);
        return `\x01CODE${idx}\x01`;
    });
    result = result.replace(/`[^`]+`/g, (match) => {
        const idx = _codeStore.length;
        _codeStore.push(match);
        return `\x01CODE${idx}\x01`;
    });

    // Block: $$...$$ (greedy across newlines)
    result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
        const idx = _latexStore.length;
        _latexStore.push({ expr: expr.trim(), displayMode: true });
        return `<span data-latex="${idx}"></span>`;
    });

    // Block: \[...\]
    result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr) => {
        const idx = _latexStore.length;
        _latexStore.push({ expr: expr.trim(), displayMode: true });
        return `<span data-latex="${idx}"></span>`;
    });

    // Inline: $...$ (not preceded/followed by $, skip currency like $5)
    result = result.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, expr) => {
        if (/^\d/.test(expr.trim())) return _match;
        const idx = _latexStore.length;
        _latexStore.push({ expr: expr.trim(), displayMode: false });
        return `<span data-latex="${idx}"></span>`;
    });

    // Inline: \(...\)
    result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expr) => {
        const idx = _latexStore.length;
        _latexStore.push({ expr: expr.trim(), displayMode: false });
        return `<span data-latex="${idx}"></span>`;
    });

    // Restore code blocks
    result = result.replace(/\x01CODE(\d+)\x01/g, (_match, idx) => _codeStore[parseInt(idx)]);

    return result;
}

/**
 * Restore LaTeX placeholders with KaTeX-rendered HTML.
 * Call AFTER DOMPurify.sanitize().
 */
function restoreLatex(html) {
    if (_latexStore.length === 0) return html;

    return html.replace(/<span data-latex="(\d+)"><\/span>/g, (_match, idxStr) => {
        const entry = _latexStore[parseInt(idxStr, 10)];
        if (!entry) return _match;
        try {
            return katex.renderToString(entry.expr, {
                displayMode: entry.displayMode,
                throwOnError: false,
                trust: false,
            });
        } catch (e) {
            return `<code>${entry.expr}</code>`;
        }
    });
}
