// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentSessionId = null;
let ws = null;
let isRunning = false;
let inputType = "share";
let availableModels = [];
let sessionModelLabels = { model_a: "Claude 4.6 Opus", model_b: "Claude 3 Opus" };
let pendingImages = [];

// Markdown streaming state
let streamingRawText = "";
let markdownRenderTimer = null;
const MARKDOWN_DEBOUNCE_MS = 80;

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
            streamingRawText = "";
            messagesEl.appendChild(streamingEl);

            statusIndicator.textContent = `${event.model_label} is talking...`;
            scrollToBottom();
            break;
        }

        case "text_delta":
            if (streamingTextEl) {
                streamingRawText += event.text;
                scheduleMarkdownRender();
                maybeScrollToBottom();
            }
            break;

        case "couch_turn_end":
            // Final markdown render with the cleaned text (without [ready])
            if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
            if (streamingTextEl) {
                const finalText = (event.text !== undefined && event.text !== null)
                    ? event.text
                    : streamingRawText;
                streamingTextEl.innerHTML = renderMarkdown(finalText);
                removeStreamingCursor(streamingTextEl);
            }
            streamingRawText = "";
            markdownRenderTimer = null;
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
            maybeScrollToBottom();
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
            maybeScrollToBottom();
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
    const useMarkdown = isModelSpeaker(speaker);

    if (typeof content === "string") {
        if (useMarkdown) {
            textEl.innerHTML = renderMarkdown(content);
        } else {
            textEl.textContent = content;
        }
    } else if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
            if (block.type === "text" && block.text) {
                textParts.push(block.text);
            } else if (block.type === "image" && block.source) {
                const img = document.createElement("img");
                img.src = `data:${block.source.media_type};base64,${block.source.data}`;
                img.className = "message-image";
                textEl.appendChild(img);
            }
        }
        if (textParts.length > 0) {
            const fullText = textParts.join("");
            if (useMarkdown) {
                textEl.innerHTML = renderMarkdown(fullText);
            } else {
                const textNode = document.createTextNode(fullText);
                textEl.insertBefore(textNode, textEl.firstChild);
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
    const hasImages = pendingImages.length > 0;
    if ((!text && !hasImages) || isRunning || !ws || !currentSessionId) return;

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
    const curatorTextEl = curatorEl.querySelector(".message-text");
    curatorTextEl.textContent = displayText;
    for (const img of pendingImages) {
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        imgEl.className = "message-image";
        curatorTextEl.appendChild(imgEl);
    }
    messagesEl.appendChild(curatorEl);
    scrollToBottom();

    // Build payload — use block list if images are present
    let contentPayload;
    if (hasImages) {
        const blocks = [];
        if (text) blocks.push({ type: "text", text: text });
        blocks.push(...pendingImages);
        contentPayload = blocks;
    } else {
        contentPayload = text;
    }

    ws.send(JSON.stringify({ type: inputType, content: contentPayload }));
    messageInput.value = "";
    clearCouchImagePreviews();
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
// Image preview management
// ---------------------------------------------------------------------------
function renderCouchImagePreviews() {
    let area = document.getElementById("couch-image-preview-area");
    if (!area) {
        area = document.createElement("div");
        area.id = "couch-image-preview-area";
        area.className = "image-preview-area";
        const wrapper = messageInput.closest(".input-wrapper");
        wrapper.insertBefore(area, messageInput);
    }
    area.innerHTML = "";
    if (pendingImages.length === 0) {
        area.style.display = "none";
        return;
    }
    area.style.display = "flex";
    pendingImages.forEach((img, i) => {
        const preview = document.createElement("div");
        preview.className = "image-preview";
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        preview.appendChild(imgEl);
        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.onclick = () => {
            pendingImages.splice(i, 1);
            renderCouchImagePreviews();
        };
        preview.appendChild(removeBtn);
        area.appendChild(preview);
    });
}

function clearCouchImagePreviews() {
    pendingImages = [];
    const area = document.getElementById("couch-image-preview-area");
    if (area) {
        area.innerHTML = "";
        area.style.display = "none";
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function isNearBottom(threshold = 150) {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function maybeScrollToBottom() {
    if (isNearBottom()) scrollToBottom();
}

function autoResizeInput() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
    if (!text) return "";
    let processed = text;
    const fenceCount = (processed.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) {
        processed += "\n```";
    }
    processed = extractLatex(processed);
    const html = DOMPurify.sanitize(marked.parse(processed));
    return restoreLatex(html);
}

function appendStreamingCursor(el) {
    const existing = el.querySelector(".streaming-cursor-char");
    if (existing) existing.remove();

    const cursor = document.createElement("span");
    cursor.className = "streaming-cursor-char";
    cursor.textContent = "\u25AE";

    let target = el;
    while (target.lastElementChild) {
        const last = target.lastElementChild;
        if (["PRE", "HR", "BR", "IMG", "TABLE", "UL", "OL"].includes(last.tagName)) break;
        target = last;
    }
    target.appendChild(cursor);
}

function removeStreamingCursor(el) {
    const cursor = el.querySelector(".streaming-cursor-char");
    if (cursor) cursor.remove();
}

function scheduleMarkdownRender() {
    if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
    markdownRenderTimer = setTimeout(() => {
        if (streamingTextEl && streamingRawText) {
            streamingTextEl.innerHTML = renderMarkdown(streamingRawText);
            appendStreamingCursor(streamingTextEl);
        }
    }, MARKDOWN_DEBOUNCE_MS);
}

// Returns true if speaker is a model (should render markdown)
function isModelSpeaker(speaker) {
    return speaker === "model_a" || speaker === "model_b";
}

// ---------------------------------------------------------------------------
// System prompt editing
// ---------------------------------------------------------------------------
const promptsModal = document.getElementById("prompts-modal");

async function openPromptsModal() {
    if (!currentSessionId) return;

    const meta = sessionMetadataCache[currentSessionId];
    if (meta) {
        document.getElementById("prompt-a-label").textContent = `${meta.model_a.label} (seat 1 — manages pacing)`;
        document.getElementById("prompt-b-label").textContent = `${meta.model_b.label} (seat 2)`;
    }

    // Fetch current prompts (custom or defaults)
    try {
        const res = await fetch(`/api/couch/sessions/${currentSessionId}/prompts`, {
            headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        document.getElementById("prompt-a-input").value = data.prompt_a || "";
        document.getElementById("prompt-b-input").value = data.prompt_b || "";
    } catch (e) {
        console.error("Failed to load prompts:", e);
    }

    document.getElementById("prompts-save-status").textContent = "";
    promptsModal.style.display = "flex";
}

async function savePrompts() {
    if (!currentSessionId) return;
    const promptA = document.getElementById("prompt-a-input").value;
    const promptB = document.getElementById("prompt-b-input").value;

    try {
        await fetch(`/api/couch/sessions/${currentSessionId}/prompts`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt_a: promptA, prompt_b: promptB }),
        });
        document.getElementById("prompts-save-status").textContent = "saved";
        setTimeout(() => {
            document.getElementById("prompts-save-status").textContent = "";
        }, 2000);
    } catch (e) {
        document.getElementById("prompts-save-status").textContent = "error saving";
    }
}

async function resetPrompts() {
    if (!currentSessionId) return;
    // Setting empty strings resets to defaults
    await fetch(`/api/couch/sessions/${currentSessionId}/prompts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_a: "", prompt_b: "" }),
    });
    // Reload the defaults into the textareas
    await openPromptsModal();
    document.getElementById("prompts-save-status").textContent = "reset to defaults";
    setTimeout(() => {
        document.getElementById("prompts-save-status").textContent = "";
    }, 2000);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
newSessionBtn.onclick = showNewSessionModal;
sendBtn.onclick = sendMessage;
modelNames.onclick = openPromptsModal;

document.getElementById("new-session-modal-close").onclick = () => {
    newSessionModal.style.display = "none";
};
newSessionModal.onclick = (e) => {
    if (e.target === newSessionModal) newSessionModal.style.display = "none";
};
document.getElementById("create-session-btn").onclick = createSession;

document.getElementById("prompts-modal-close").onclick = () => {
    promptsModal.style.display = "none";
};
promptsModal.onclick = (e) => {
    if (e.target === promptsModal) promptsModal.style.display = "none";
};
document.getElementById("save-prompts-btn").onclick = savePrompts;
document.getElementById("reset-prompts-btn").onclick = resetPrompts;

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
messageInput.addEventListener("input", autoResizeInput);
messageInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const file = item.getAsFile();
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(",")[1];
                const mediaType = item.type;
                pendingImages.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
                renderCouchImagePreviews();
            };
            reader.readAsDataURL(file);
            break;
        }
    }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
marked.setOptions({ breaks: true, gfm: true });
loadModels();
loadSessions();
