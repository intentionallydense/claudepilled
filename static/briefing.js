/**
 * Briefing page — fetch and render daily briefings, manage reading progress.
 *
 * Talks to /api/briefing/* and /api/reading-progress/* endpoints.
 * Renders assembled markdown text with lightweight parsing.
 */

// State
let currentDate = new Date().toISOString().slice(0, 10);

// API helper
async function api(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return { status: res.status, data: await res.json() };
}

// ------------------------------------------------------------------
// Briefing loading
// ------------------------------------------------------------------

async function loadBriefing(dateStr) {
    currentDate = dateStr;
    updateDateDisplay();

    const content = document.getElementById("briefing-content");
    const empty = document.getElementById("empty-state");
    const loading = document.getElementById("loading-state");
    const assembling = document.getElementById("assembling-state");

    content.style.display = "none";
    empty.style.display = "none";
    assembling.style.display = "none";
    loading.style.display = "block";

    const { status, data } = await api("GET", `/api/briefing/${dateStr}`);
    loading.style.display = "none";

    if (status === 404) {
        empty.style.display = "block";
        return;
    }

    content.innerHTML = renderMarkdown(data.assembled_text || "");
    content.style.display = "block";
}

// ------------------------------------------------------------------
// Markdown rendering — lightweight, handles ## headers, bullets, links
// ------------------------------------------------------------------

function renderMarkdown(text) {
    if (!text) return "<p>empty briefing</p>";

    const lines = text.split("\n");
    let html = "";
    let inList = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Empty line — close list if open, add spacing
        if (!trimmed) {
            if (inList) { html += "</ul>"; inList = false; }
            continue;
        }

        // ## Header
        if (trimmed.startsWith("## ")) {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<h2>${esc(trimmed.slice(3))}</h2>`;
            continue;
        }

        // Bullet point (- or *)
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatInline(trimmed.slice(2))}</li>`;
            continue;
        }

        // Numbered list (1. 2. etc)
        const numMatch = trimmed.match(/^\d+\.\s+(.*)/);
        if (numMatch) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatInline(numMatch[1])}</li>`;
            continue;
        }

        // Regular paragraph
        if (inList) { html += "</ul>"; inList = false; }
        html += `<p>${formatInline(trimmed)}</p>`;
    }

    if (inList) html += "</ul>";
    return html;
}

function formatInline(text) {
    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Bold: **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Italic: *text* (but not inside already-processed tags)
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    // Inline code: `text`
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return text;
}

function esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
}

// ------------------------------------------------------------------
// Assemble button
// ------------------------------------------------------------------

async function handleAssemble() {
    const content = document.getElementById("briefing-content");
    const empty = document.getElementById("empty-state");
    const assembling = document.getElementById("assembling-state");
    const btn = document.getElementById("assemble-btn");

    content.style.display = "none";
    empty.style.display = "none";
    assembling.style.display = "block";
    btn.disabled = true;

    try {
        const { status, data } = await api("POST", "/api/briefing/assemble");
        assembling.style.display = "none";

        if (data.assembled_text) {
            content.innerHTML = renderMarkdown(data.assembled_text);
            content.style.display = "block";
            // Update date to today since assembly is always for today
            currentDate = new Date().toISOString().slice(0, 10);
            updateDateDisplay();
        } else {
            empty.style.display = "block";
        }
    } catch (err) {
        assembling.style.display = "none";
        empty.style.display = "block";
        empty.textContent = "assembly failed: " + err.message;
    } finally {
        btn.disabled = false;
    }
}

// ------------------------------------------------------------------
// Date navigation
// ------------------------------------------------------------------

function handleDateNav(delta) {
    const d = new Date(currentDate + "T12:00:00");
    d.setDate(d.getDate() + delta);
    loadBriefing(d.toISOString().slice(0, 10));
}

function updateDateDisplay() {
    const d = new Date(currentDate + "T12:00:00");
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const display = `${days[d.getDay()]}, ${currentDate}`;
    document.getElementById("date-display").textContent = display;
}

// ------------------------------------------------------------------
// Reading progress
// ------------------------------------------------------------------

const SERIES_NAMES = {
    sequences: "LessWrong Sequences",
    gwern: "Gwern Essays",
    acx: "ACX/SSC Best Of",
    albums: "Album of the Day",
};

async function loadProgress() {
    const { data } = await api("GET", "/api/reading-progress");
    const list = document.getElementById("progress-list");
    list.innerHTML = "";

    if (!Array.isArray(data)) return;

    for (const p of data) {
        const li = document.createElement("li");
        li.className = "progress-item";

        const name = SERIES_NAMES[p.series] || p.series;
        const paused = p.paused ? ' <span class="progress-paused">paused</span>' : "";

        li.innerHTML = `
            <div>
                <span class="progress-series">${esc(name)}</span>${paused}
                <span class="progress-position">position ${p.current_index}</span>
            </div>
            <div class="progress-actions">
                ${p.paused
                    ? `<button class="text-btn" onclick="togglePause('${p.series}', false)">resume</button>`
                    : `<button class="text-btn" onclick="togglePause('${p.series}', true)">pause</button>`
                }
                <button class="text-btn" onclick="skipItem('${p.series}')">skip</button>
                <button class="text-btn" onclick="markUnread('${p.series}')">didn't read</button>
            </div>
        `;
        list.appendChild(li);
    }
}

async function togglePause(series, pause) {
    const action = pause ? "pause" : "resume";
    await api("POST", `/api/reading-progress/${series}/${action}`);
    await loadProgress();
}

async function skipItem(series) {
    await api("POST", `/api/reading-progress/${series}/skip`);
    await loadProgress();
}

async function markUnread(series) {
    await api("POST", `/api/reading-progress/${series}/unread`);
    await loadProgress();
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("prev-date").addEventListener("click", () => handleDateNav(-1));
    document.getElementById("next-date").addEventListener("click", () => handleDateNav(1));
    document.getElementById("assemble-btn").addEventListener("click", handleAssemble);

    loadBriefing(currentDate);
    loadProgress();
});
