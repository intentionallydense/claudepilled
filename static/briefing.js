// ---------------------------------------------------------------------------
// briefing.js — Briefing page. Uses createChatCore() from chat-core.js for
// chat functionality. This file handles briefing-specific concerns: date
// sidebar, briefing content rendering, reading progress, assemble button.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentDate = new Date().toISOString().slice(0, 10);
let briefingList = [];  // [{date, has_chat}, ...]

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const welcomeEl = document.getElementById("welcome");
const messagesEl = document.getElementById("messages");
const inputArea = document.getElementById("input-area");
const briefingListEl = document.getElementById("briefing-list");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function briefingApiFetch(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// Variant that returns {status, data} for endpoints that use 404 as data
async function briefingApi(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// Chat core instance
// ---------------------------------------------------------------------------
const chatCore = createChatCore({
    elements: {
        messages: document.getElementById("messages"),
        input: document.getElementById("message-input"),
        sendBtn: document.getElementById("send-btn"),
        stopBtn: document.getElementById("stop-btn"),
        modelSelect: document.getElementById("model-select"),
        thinkingCheckbox: document.getElementById("thinking-checkbox"),
        costDisplay: document.getElementById("cost-display"),
        nodeMap: document.getElementById("node-map"),
        treeSearch: document.getElementById("tree-search"),
    },
    apiFetch: briefingApiFetch,

    onEditDone() {
        // Reload conversation after edit/stop
        const id = chatCore.getConversationId();
        if (id) {
            chatCore.loadConversation(id);
        }
    },
});

// ---------------------------------------------------------------------------
// Briefing sidebar
// ---------------------------------------------------------------------------
async function loadBriefingList() {
    try {
        briefingList = await briefingApiFetch("GET", "/api/briefing/list");
    } catch (e) {
        briefingList = [];
    }
    renderBriefingList();
}

function renderBriefingList() {
    briefingListEl.innerHTML = "";

    // Always include tomorrow at the top
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const dates = new Set(briefingList.map(b => b.date));
    const allDates = [];

    // Add tomorrow if not already in the list
    if (!dates.has(tomorrowStr)) {
        allDates.push({ date: tomorrowStr, has_chat: false, placeholder: true });
    }

    // Add all existing briefings
    for (const b of briefingList) {
        allDates.push(b);
    }

    for (const item of allDates) {
        const li = document.createElement("li");
        li.dataset.date = item.date;
        if (item.date === currentDate) li.classList.add("active");

        const d = new Date(item.date + "T12:00:00");
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const label = document.createElement("span");
        label.textContent = `${days[d.getDay()]} ${item.date}`;
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        label.style.whiteSpace = "nowrap";
        label.style.flex = "1";
        if (item.placeholder) label.style.opacity = "0.4";
        li.appendChild(label);

        li.onclick = () => selectBriefing(item.date);
        briefingListEl.appendChild(li);
    }
}

// ---------------------------------------------------------------------------
// Briefing selection
// ---------------------------------------------------------------------------
async function selectBriefing(dateStr) {
    currentDate = dateStr;

    // Highlight in sidebar
    briefingListEl.querySelectorAll("li").forEach((li) => {
        li.classList.toggle("active", li.dataset.date === dateStr);
    });

    // Load briefing content
    await loadBriefingContent(dateStr);
}

// ---------------------------------------------------------------------------
// Briefing content loading (rendered in right panel)
// ---------------------------------------------------------------------------
async function loadBriefingContent(dateStr) {
    const content = document.getElementById("briefing-content");
    const empty = document.getElementById("empty-state");
    const loading = document.getElementById("loading-state");
    const assembling = document.getElementById("assembling-state");

    content.style.display = "none";
    content.innerHTML = "";
    empty.style.display = "none";
    assembling.style.display = "none";
    loading.style.display = "block";

    const { status, data } = await briefingApi("GET", `/api/briefing/${dateStr}`);
    loading.style.display = "none";

    if (status === 404) {
        empty.style.display = "block";
        showWelcome();
        return;
    }

    content.innerHTML = renderBriefingMarkdown(data.assembled_text || "");
    content.style.display = "block";

    // Init chat for this briefing
    await initChat(dateStr);
}

// ---------------------------------------------------------------------------
// Briefing markdown renderer — lightweight, for briefing content (not chat)
// ---------------------------------------------------------------------------
function renderBriefingMarkdown(text) {
    if (!text) return "<p>empty briefing</p>";

    const lines = text.split("\n");
    let html = "";
    let inList = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            if (inList) { html += "</ul>"; inList = false; }
            continue;
        }

        if (trimmed.startsWith("## ")) {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
            continue;
        }

        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatBriefingInline(trimmed.slice(2))}</li>`;
            continue;
        }

        const numMatch = trimmed.match(/^\d+\.\s+(.*)/);
        if (numMatch) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatBriefingInline(numMatch[1])}</li>`;
            continue;
        }

        if (inList) { html += "</ul>"; inList = false; }
        html += `<p>${formatBriefingInline(trimmed)}</p>`;
    }

    if (inList) html += "</ul>";
    return html;
}

function formatBriefingInline(text) {
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return text;
}

// ---------------------------------------------------------------------------
// Chat init — create/get conversation for a briefing date
// ---------------------------------------------------------------------------
async function initChat(dateStr) {
    chatCore.destroy();

    const { status, data } = await briefingApi("POST", `/api/briefing/${dateStr}/chat`);
    if (status !== 200) {
        showWelcome();
        return;
    }

    showChat();
    await chatCore.loadConversation(data.conversation_id);
}

function showChat() {
    welcomeEl.style.display = "none";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    chatCore.destroy();
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
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
        const { status, data } = await briefingApi("POST", "/api/briefing/assemble");
        assembling.style.display = "none";

        if (data.assembled_text) {
            content.innerHTML = renderBriefingMarkdown(data.assembled_text);
            content.style.display = "block";
            currentDate = new Date().toISOString().slice(0, 10);
            // Refresh sidebar and select today
            await loadBriefingList();
            await selectBriefing(currentDate);
        } else {
            empty.style.display = "block";
        }
    } catch (err) {
        assembling.style.display = "none";
        empty.style.display = "block";
        document.getElementById("empty-state").textContent = "assembly failed: " + err.message;
    } finally {
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Reading progress
// ---------------------------------------------------------------------------
const SERIES_NAMES = {
    sequences: "LessWrong Sequences",
    gwern: "Gwern Essays",
    acx: "ACX/SSC Best Of",
    albums: "Album of the Day",
};

async function loadProgress() {
    try {
        const data = await briefingApiFetch("GET", "/api/reading-progress");
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
                    <span class="progress-series">${escapeHtml(name)}</span>${paused}
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
    } catch (e) {
        console.error("Failed to load progress:", e);
    }
}

async function togglePause(series, pause) {
    const action = pause ? "pause" : "resume";
    await briefingApi("POST", `/api/reading-progress/${series}/${action}`);
    await loadProgress();
}

async function skipItem(series) {
    await briefingApi("POST", `/api/reading-progress/${series}/skip`);
    await loadProgress();
}

async function markUnread(series) {
    await briefingApi("POST", `/api/reading-progress/${series}/unread`);
    await loadProgress();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
document.getElementById("assemble-btn").onclick = handleAssemble;

// Focus textarea on printable character press
document.addEventListener("keydown", (e) => {
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    const input = document.getElementById("message-input");
    if (input.disabled || !chatCore.getConversationId()) return;
    input.focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
marked.setOptions({ breaks: true, gfm: true });
chatCore.attachListeners();
chatCore.loadModels();
loadProgress();

// Load sidebar, then auto-select today's briefing
loadBriefingList().then(async () => {
    // Try to load today's briefing
    const today = new Date().toISOString().slice(0, 10);
    const hasToday = briefingList.some(b => b.date === today);
    if (hasToday) {
        await selectBriefing(today);
    }
});
