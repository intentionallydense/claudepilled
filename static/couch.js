// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentSessionId = null;
let ws = null;
let isRunning = false;
let inputType = "share";
let availableModels = [];
let sessionModelLabels = { model_a: "Claude 4.6 Opus", model_b: "Claude 3 Opus" };

// DOM elements
const sessionList = document.getElementById("session-list");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const feedHeader = document.getElementById("feed-header");
const inputArea = document.getElementById("input-area");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const statusIndicator = document.getElementById("status-indicator");
const costDisplay = document.getElementById("cost-display");
const modelNames = document.getElementById("model-names");
const newSessionModal = document.getElementById("new-session-modal");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
    const res = await fetch(`/api/couch${path}`, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
async function loadModels() {
    const res = await fetch("/api/models", {
        headers: { "Content-Type": "application/json" },
    });
    availableModels = await res.json();
    populateModelSelect(document.getElementById("model-a-select"), "claude-opus-4-6");
    populateModelSelect(document.getElementById("model-b-select"), "claude-3-opus-20240229");
}

function populateModelSelect(select, defaultId) {
    if (!select) return;
    select.innerHTML = "";
    for (const m of availableModels) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} ($${m.input_cost}/$${m.output_cost})`;
        if (m.id === defaultId) opt.selected = true;
        select.appendChild(opt);
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
let sessionMetadataCache = {};

async function loadSessions() {
    const sessions = await api("/sessions");
    sessionList.innerHTML = "";
    sessionMetadataCache = {};
    for (const s of sessions) {
        // Cache metadata for later use
        if (s.metadata) {
            try {
                sessionMetadataCache[s.id] = JSON.parse(s.metadata);
            } catch (e) { /* ignore */ }
        }

        const li = document.createElement("li");
        li.dataset.id = s.id;
        if (s.id === currentSessionId) li.classList.add("active");

        const title = document.createElement("span");
        title.textContent = s.title;
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.style.whiteSpace = "nowrap";
        title.style.flex = "1";
        li.appendChild(title);

        const del = document.createElement("button");
        del.className = "delete-btn";
        del.textContent = "\u00d7";
        del.onclick = async (e) => {
            e.stopPropagation();
            await api(`/sessions/${s.id}`, { method: "DELETE" });
            if (currentSessionId === s.id) {
                currentSessionId = null;
                showWelcome();
            }
            loadSessions();
        };
        li.appendChild(del);

        li.onclick = () => openSession(s.id);
        sessionList.appendChild(li);
    }
}

function showNewSessionModal() {
    populateModelSelect(document.getElementById("model-a-select"), "claude-opus-4-6");
    populateModelSelect(document.getElementById("model-b-select"), "claude-3-opus-20240229");
    newSessionModal.style.display = "flex";
    document.getElementById("create-session-btn").focus();
}

async function createSession() {
    const modelA = document.getElementById("model-a-select").value;
    const modelB = document.getElementById("model-b-select").value;
    newSessionModal.style.display = "none";

    const session = await api("/sessions", {
        method: "POST",
        body: JSON.stringify({ model_a: modelA, model_b: modelB }),
    });
    currentSessionId = session.id;
    await loadSessions();
    openSession(session.id);
}

async function openSession(id) {
    currentSessionId = id;
    const conv = await api(`/sessions/${id}`);

    // Get model labels from cached metadata or fallback
    const meta = sessionMetadataCache[id];
    if (meta) {
        sessionModelLabels = {
            model_a: meta.model_a.label,
            model_b: meta.model_b.label,
        };
    } else {
        sessionModelLabels = { model_a: "Claude 4.6 Opus", model_b: "Claude 3 Opus" };
    }

    // Update header
    modelNames.textContent = `${sessionModelLabels.model_a} & ${sessionModelLabels.model_b}`;

    // Highlight active in sidebar
    document.querySelectorAll("#session-list li").forEach((li) => {
        li.classList.toggle("active", li.dataset.id === id);
    });

    // Show feed UI
    welcomeEl.style.display = "none";
    feedHeader.style.display = "flex";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";

    messagesEl.innerHTML = "";

    // Set cost display
    updateCostDisplay(
        conv.total_input_tokens || 0,
        conv.total_output_tokens || 0,
        conv.total_cost || 0,
    );

    // Render existing messages
    for (let i = 0; i < conv.messages.length; i++) {
        const msg = conv.messages[i];
        renderMessage(msg.speaker || msg.role, msg.content, getSpeakerLabel(msg.speaker));
        if (i < conv.messages.length - 1) {
            const spacer = document.createElement("div");
            spacer.className = "message-spacer";
            messagesEl.appendChild(spacer);
        }
    }
    scrollToBottom();

    statusIndicator.textContent = "ready";
    connectWebSocket(id);
    messageInput.focus();
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    feedHeader.style.display = "none";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    if (ws) { ws.close(); ws = null; }
}

// ---------------------------------------------------------------------------
// Speaker labels
// ---------------------------------------------------------------------------
function getSpeakerLabel(speaker) {
    switch (speaker) {
        case "model_a": return sessionModelLabels.model_a;
        case "model_b": return sessionModelLabels.model_b;
        case "curator": return "curator";
        case "system": return "";
        default: return speaker || "unknown";
    }
}

// ---------------------------------------------------------------------------
// Cost display
// ---------------------------------------------------------------------------
function updateCostDisplay(inputTokens, outputTokens, cost) {
    const totalTokens = inputTokens + outputTokens;
    let tokenStr;
    if (totalTokens >= 1_000_000) {
        tokenStr = (totalTokens / 1_000_000).toFixed(1) + "M";
    } else if (totalTokens >= 1000) {
        tokenStr = (totalTokens / 1000).toFixed(1) + "k";
    } else {
        tokenStr = String(totalTokens);
    }
    costDisplay.textContent = `${tokenStr} tok | $${cost.toFixed(4)}`;
    costDisplay.title = `in: ${inputTokens} | out: ${outputTokens} | $${cost.toFixed(6)}`;
}

async function fetchAndUpdateCost() {
    if (!currentSessionId) return;
    try {
        const data = await api(`/sessions/${currentSessionId}/cost`);
        updateCostDisplay(data.input_tokens, data.output_tokens, data.cost);
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket(sessionId) {
    if (ws) { ws.close(); ws = null; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/couch/${sessionId}`);
    ws.onopen = () => {};
    ws.onclose = () => {};
    ws.onerror = () => {};
    ws.onmessage = (evt) => {
        const event = JSON.parse(evt.data);
        handleStreamEvent(event);
    };
}

// ---------------------------------------------------------------------------
// Streaming event handler
// ---------------------------------------------------------------------------
let streamingEl = null;
let streamingTextEl = null;
let currentStreamingSpeaker = null;

function handleStreamEvent(event) {
    switch (event.type) {
        case "couch_turn_start": {
            // Determine seat from model_id
            const speaker = event.model_label === sessionModelLabels.model_a ? "model_a" : "model_b";
            currentStreamingSpeaker = speaker;

            if (messagesEl.children.length > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                messagesEl.appendChild(spacer);
            }

            streamingEl = createMessageEl(speaker, event.model_label);
            streamingTextEl = streamingEl.querySelector(".message-text");
            messagesEl.appendChild(streamingEl);

            statusIndicator.textContent = `${event.model_label} is talking...`;
            scrollToBottom();
            break;
        }

        case "text_delta":
            if (streamingTextEl) {
                streamingTextEl.textContent += event.text;
                streamingTextEl.classList.add("streaming-cursor");
                scrollToBottom();
            }
            break;

        case "couch_turn_end":
            if (streamingTextEl) {
                streamingTextEl.classList.remove("streaming-cursor");
                // Replace with the final cleaned text (without [ready])
                if (event.text !== undefined && event.text !== null) {
                    streamingTextEl.textContent = event.text;
                }
            }
            streamingEl = null;
            streamingTextEl = null;
            currentStreamingSpeaker = null;
            break;

        case "couch_status":
            statusIndicator.textContent = "...";
            break;

        case "couch_paused": {
            if (messagesEl.children.length > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                messagesEl.appendChild(spacer);
            }
            const pauseEl = createMessageEl("system", "");
            const pauseText = (event.text === "[ready]")
                ? "waiting for something new..."
                : event.text;
            pauseEl.querySelector(".message-text").textContent = pauseText;
            messagesEl.appendChild(pauseEl);
            scrollToBottom();
            statusIndicator.textContent = "ready for more";
            break;
        }

        case "usage":
            // Update cost from the event
            break;

        case "message_done":
            isRunning = false;
            sendBtn.disabled = false;
            messageInput.disabled = false;
            messageInput.focus();
            streamingEl = null;
            streamingTextEl = null;
            currentStreamingSpeaker = null;
            fetchAndUpdateCost();
            statusIndicator.textContent = "ready";
            scrollToBottom();
            break;

        case "error":
            statusIndicator.textContent = "error";
            const errEl = document.createElement("div");
            errEl.style.color = "#c00";
            errEl.style.fontSize = "0.8rem";
            errEl.style.padding = "0.5rem 0 0.5rem 20px";
            errEl.textContent = `error: ${event.error}`;
            messagesEl.appendChild(errEl);
            isRunning = false;
            sendBtn.disabled = false;
            messageInput.disabled = false;
            scrollToBottom();
            break;
    }
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function createMessageEl(speaker, label) {
    const div = document.createElement("div");
    div.className = `message speaker-${speaker}`;

    const labelEl = document.createElement("div");
    labelEl.className = "role-label";
    labelEl.textContent = label;
    div.appendChild(labelEl);

    const text = document.createElement("div");
    text.className = "message-text";
    div.appendChild(text);

    return div;
}

function renderMessage(speaker, content, label) {
    const el = createMessageEl(speaker, label);
    const textEl = el.querySelector(".message-text");

    if (typeof content === "string") {
        textEl.textContent = content;
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === "text" && block.text) {
                textEl.textContent += block.text;
            }
        }
    }

    messagesEl.appendChild(el);
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isRunning || !ws || !currentSessionId) return;

    // Show curator message in feed
    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }

    let displayText;
    if (inputType === "nudge") {
        displayText = `[nudge: "${text}"]`;
    } else if (inputType === "jumpin") {
        displayText = `[human]: ${text}`;
    } else {
        displayText = `[shared: ${text}]`;
    }

    const curatorEl = createMessageEl("curator", "curator");
    curatorEl.querySelector(".message-text").textContent = displayText;
    messagesEl.appendChild(curatorEl);
    scrollToBottom();

    ws.send(JSON.stringify({ type: inputType, content: text }));
    messageInput.value = "";
    autoResizeInput();
    isRunning = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;
    statusIndicator.textContent = "running...";
}

// ---------------------------------------------------------------------------
// Input type selector
// ---------------------------------------------------------------------------
const typeBtns = document.querySelectorAll(".type-btn");
const placeholders = {
    share: "paste a tweet, quote, or anything...",
    nudge: "give them a gentle nudge...",
    jumpin: "say something to the group...",
};
const buttonLabels = {
    share: "drop it",
    nudge: "nudge",
    jumpin: "send",
};

typeBtns.forEach((btn) => {
    btn.onclick = () => {
        typeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        inputType = btn.dataset.type;
        messageInput.placeholder = placeholders[inputType];
        sendBtn.textContent = buttonLabels[inputType];
    };
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autoResizeInput() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
newSessionBtn.onclick = showNewSessionModal;
sendBtn.onclick = sendMessage;

document.getElementById("new-session-modal-close").onclick = () => {
    newSessionModal.style.display = "none";
};
newSessionModal.onclick = (e) => {
    if (e.target === newSessionModal) newSessionModal.style.display = "none";
};
document.getElementById("create-session-btn").onclick = createSession;

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
messageInput.addEventListener("input", autoResizeInput);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
loadModels();
loadSessions();
