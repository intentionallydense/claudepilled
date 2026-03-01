// ---------------------------------------------------------------------------
// couch.js — Two-model conversation UI. Handles sessions, streaming,
// message rendering, tree visualization, and board/pin management.
// Loads style.css for shared layout; couch.css for overrides only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentSessionId = null;
let ws = null;
let isRunning = false;
let availableModels = [];
let sessionModelLabels = { model_a: "Claude 4.6 Opus", model_b: "Claude 3 Opus" };
let pendingImages = [];
let boardPins = [];
let boardFiles = [];
let allTags = [];
let savedPrompts = [];
let activeContext = { files: [], pins: [], total_tokens: 0 };

// Markdown streaming state
let streamingRawText = "";
let markdownRenderTimer = null;
const MARKDOWN_DEBOUNCE_MS = 80;

// DOM elements
const sessionList = document.getElementById("session-list");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const inputArea = document.getElementById("input-area");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const statusIndicator = document.getElementById("status-indicator");
const costDisplay = document.getElementById("cost-display");
const modelNames = document.getElementById("model-names");
const newSessionModal = document.getElementById("new-session-modal");
const nodeMapEl = document.getElementById("node-map");
const treeSearchEl = document.getElementById("tree-search");
const boardPinsEl = document.getElementById("board-pins");
const boardInput = document.getElementById("board-input");
const tagAutocomplete = document.getElementById("tag-autocomplete");
const contextBar = document.getElementById("context-bar");
const contextBarFiles = document.getElementById("context-bar-files");
const contextTokenCount = document.getElementById("context-token-count");

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

// Generic API helper for non-couch endpoints (pins, tree, etc.)
async function apiGeneric(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
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
    // Group by provider
    const byProvider = {};
    for (const m of availableModels) {
        const p = m.provider || "anthropic";
        if (!byProvider[p]) byProvider[p] = [];
        byProvider[p].push(m);
    }
    for (const [provider, group] of Object.entries(byProvider)) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = provider.charAt(0).toUpperCase() + provider.slice(1);
        for (const m of group) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = `${m.name} ($${m.input_cost}/$${m.output_cost})`;
            if (m.id === defaultId) opt.selected = true;
            optgroup.appendChild(opt);
        }
        select.appendChild(optgroup);
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
        renderMessage(msg.speaker || msg.role, msg.content, getSpeakerLabel(msg.speaker), msg.id, msg.parent_id);
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

    // Load tree and context for this session
    loadTree();
    loadContext();
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    if (ws) { ws.close(); ws = null; }
    nodeMapEl.innerHTML = "";
    couchTreeNodes = [];
    couchTreeHighlight = null;
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
    ws.onclose = () => {
        ws = null;
        // If we were mid-stream when the connection dropped, reset UI state
        if (isRunning) {
            isRunning = false;
            sendBtn.disabled = false;
            messageInput.disabled = false;
            statusIndicator.textContent = "";
        }
    };
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
            loadTree();
            break;

        case "context_update":
            // Tag injection activated — refresh context bar
            activeContext = {
                files: event.files || [],
                pins: event.pins || [],
                total_tokens: event.total_tokens || 0,
            };
            renderContextBar();
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
function createMessageEl(speaker, label, msgId, parentId) {
    const div = document.createElement("div");
    // Add base role class so style.css rules apply (e.g. .message.assistant white-space)
    const baseRole = isModelSpeaker(speaker) ? "assistant" : "user";
    div.className = `message ${baseRole} speaker-${speaker}`;
    if (msgId) div.dataset.msgId = msgId;
    if (parentId) div.dataset.parentId = parentId;

    const labelEl = document.createElement("div");
    labelEl.className = "role-label";
    labelEl.textContent = label;
    div.appendChild(labelEl);

    const text = document.createElement("div");
    text.className = "message-text";
    div.appendChild(text);

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "message-actions";

    if (speaker === "curator" && msgId) {
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.textContent = "edit";
        editBtn.onclick = () => startCouchEdit(div);
        actions.appendChild(editBtn);
    }

    if (msgId) {
        if (isModelSpeaker(speaker)) {
            const copyBtn = document.createElement("button");
            copyBtn.className = "msg-action-btn";
            copyBtn.textContent = "copy";
            copyBtn.onclick = () => couchCopyMessage(div);
            actions.appendChild(copyBtn);

            const regenBtn = document.createElement("button");
            regenBtn.className = "msg-action-btn";
            regenBtn.textContent = "regenerate";
            regenBtn.onclick = () => couchRegenerate(div);
            actions.appendChild(regenBtn);
        }

        const pinBtn = document.createElement("button");
        pinBtn.className = "msg-action-btn";
        pinBtn.textContent = "pin";
        pinBtn.onclick = () => couchPinMessage(div);
        actions.appendChild(pinBtn);
    }

    div.appendChild(actions);
    return div;
}

function renderMessage(speaker, content, label, msgId, parentId) {
    const el = createMessageEl(speaker, label, msgId, parentId);
    const textEl = el.querySelector(".message-text");
    const useMarkdown = isModelSpeaker(speaker);

    // Store raw text for edit
    if (typeof content === "string") {
        el.dataset.rawText = content;
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
            el.dataset.rawText = fullText;
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
// Message actions — copy, pin, edit, regenerate
// ---------------------------------------------------------------------------
function couchCopyMessage(msgEl) {
    const textEl = msgEl.querySelector(".message-text");
    const text = textEl?.innerText || textEl?.textContent || "";
    navigator.clipboard.writeText(text).then(() => {
        const btn = msgEl.querySelector(".msg-action-btn");
        if (btn && btn.textContent === "copy") {
            btn.textContent = "copied";
            setTimeout(() => { btn.textContent = "copy"; }, 1500);
        }
    });
}

function couchPinMessage(msgEl) {
    const textEl = msgEl.querySelector(".message-text");
    const text = textEl?.innerText || textEl?.textContent || "";
    if (!text.trim()) return;
    createPin("message", text.trim(), {
        source: "couch",
    });
}

function startCouchEdit(msgEl) {
    if (isRunning) return;

    // Remove any existing edit forms
    messagesEl.querySelectorAll(".edit-form").forEach(f => f.remove());

    const currentText = msgEl.dataset.rawText || msgEl.querySelector(".message-text")?.textContent || "";
    const parentId = msgEl.dataset.parentId || null;

    const form = document.createElement("div");
    form.className = "edit-form";

    const textarea = document.createElement("textarea");
    textarea.className = "edit-textarea";
    textarea.value = currentText;
    form.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "edit-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "cancel";
    cancelBtn.onclick = () => form.remove();
    actions.appendChild(cancelBtn);

    const editSendBtn = document.createElement("button");
    editSendBtn.className = "edit-send";
    editSendBtn.textContent = "send edit";
    editSendBtn.onclick = () => submitCouchEdit(parentId, textarea.value.trim(), form);
    actions.appendChild(editSendBtn);

    form.appendChild(actions);
    msgEl.appendChild(form);

    function autoGrow() {
        textarea.style.height = "0";
        textarea.style.height = textarea.scrollHeight + "px";
    }
    textarea.addEventListener("input", autoGrow);
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitCouchEdit(parentId, textarea.value.trim(), form);
        }
    });
    textarea.focus();
    requestAnimationFrame(autoGrow);
}

function submitCouchEdit(parentId, newText, formEl) {
    if (!newText || !ws || !currentSessionId || isRunning) return;

    // Remove edited message and everything after it from the DOM
    const editedMsg = formEl.closest(".message");
    formEl.remove();
    if (editedMsg) {
        while (editedMsg.nextSibling) editedMsg.nextSibling.remove();
        editedMsg.remove();
    }

    // Show the edited curator message in feed
    const curatorEl = createMessageEl("curator", "curator");
    curatorEl.querySelector(".message-text").textContent = newText;
    messagesEl.appendChild(curatorEl);
    scrollToBottom();

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    isRunning = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;
    statusIndicator.textContent = "running...";

    ws.send(JSON.stringify({
        action: "edit",
        parent_id: parentId,
        content: newText,
        type: "share",
    }));
}

function couchRegenerate(modelMsgEl) {
    if (isRunning || !ws || !currentSessionId) return;

    // Walk back from the model message to find the curator message that started
    // this turn sequence (nearest preceding element with speaker-curator class).
    let curatorMsgEl = null;
    let el = modelMsgEl.previousElementSibling;
    while (el) {
        if (el.classList.contains("speaker-curator")) {
            curatorMsgEl = el;
            break;
        }
        el = el.previousElementSibling;
    }

    const curatorMsgId = curatorMsgEl?.dataset?.msgId;
    if (!curatorMsgId) return;

    // Save the curator text for re-display
    const curatorText = curatorMsgEl.querySelector(".message-text")?.textContent || "";

    // Remove from the curator message's spacer onward
    const prevSpacer = curatorMsgEl.previousElementSibling;
    while (curatorMsgEl.nextSibling) curatorMsgEl.nextSibling.remove();
    if (prevSpacer && prevSpacer.classList.contains("message-spacer")) {
        prevSpacer.remove();
    }
    curatorMsgEl.remove();

    // Re-display the curator message (stream_turns will save a new one to DB)
    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }
    const newCuratorEl = createMessageEl("curator", "curator");
    newCuratorEl.querySelector(".message-text").textContent = curatorText;
    messagesEl.appendChild(newCuratorEl);
    scrollToBottom();

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    isRunning = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;
    statusIndicator.textContent = "regenerating...";

    ws.send(JSON.stringify({
        action: "regenerate",
        curator_msg_id: curatorMsgId,
    }));
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
function sendMessage() {
    const rawText = messageInput.value.trim();
    const hasImages = pendingImages.length > 0;
    if ((!rawText && !hasImages) || isRunning || !ws || !currentSessionId) return;

    // Extract #tags from text
    const tagRegex = /#([a-zA-Z0-9-]+)/g;
    const injectTags = [];
    let match;
    while ((match = tagRegex.exec(rawText)) !== null) {
        injectTags.push(match[1].toLowerCase());
    }
    // Strip tags from the text sent to models
    const text = rawText.replace(/#[a-zA-Z0-9-]+/g, "").trim();

    // Tag-only message (no actual text, just context activation)
    if (!text && !hasImages && injectTags.length > 0) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "share", content: "", inject_tags: injectTags }));
        messageInput.value = "";
        hideTagAutocomplete();
        autoResizeInput();
        return;
    }

    if (!text && !hasImages) return;

    // Show curator message in feed
    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }

    const displayText = `[shared: ${text}]`;

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

    const payload = { type: "share", content: contentPayload };
    if (injectTags.length > 0) payload.inject_tags = injectTags;

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
    messageInput.value = "";
    hideTagAutocomplete();
    clearCouchImagePreviews();
    autoResizeInput();
    isRunning = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;
    statusIndicator.textContent = "running...";
}

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
// Tree panel — uses shared buildTreeLayout from chat-core.js for proper
// SVG bezier connections. Clicking a node scrolls to the corresponding
// message. Scroll position syncs to tree highlight.
// ---------------------------------------------------------------------------
let couchTreeNodes = [];
let couchTreeHighlight = null;

function onTreeNodeClick(nodeId) {
    const msgEl = messagesEl.querySelector(`.message[data-msg-id="${nodeId}"]`);
    if (msgEl) {
        msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

function highlightCouchTreeNode(index) {
    if (couchTreeHighlight !== null && couchTreeNodes[couchTreeHighlight]) {
        couchTreeNodes[couchTreeHighlight].el.classList.remove("scroll-highlight");
    }
    if (couchTreeNodes[index]) {
        couchTreeNodes[index].el.classList.add("scroll-highlight");
        couchTreeNodes[index].el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        couchTreeHighlight = index;
    }
}

function syncCouchTreeWithScroll() {
    const msgEls = messagesEl.querySelectorAll(".message");
    if (msgEls.length === 0 || couchTreeNodes.length === 0) return;

    const onPathNodes = couchTreeNodes.filter(tn => tn.onPath).sort((a, b) => a.depth - b.depth);
    if (onPathNodes.length === 0) return;

    // At bottom — highlight last node
    const scrollBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (scrollBottom < 40) {
        const idx = couchTreeNodes.indexOf(onPathNodes[onPathNodes.length - 1]);
        if (idx >= 0) highlightCouchTreeNode(idx);
        nodeMapEl.scrollTo({ top: nodeMapEl.scrollHeight, behavior: "smooth" });
        return;
    }
    // At top — highlight first node
    if (messagesEl.scrollTop < 40) {
        const idx = couchTreeNodes.indexOf(onPathNodes[0]);
        if (idx >= 0) highlightCouchTreeNode(idx);
        nodeMapEl.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }

    // Find message closest to viewport center
    const containerRect = messagesEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    let closestIdx = 0;
    let closestDist = Infinity;
    msgEls.forEach((msgEl, i) => {
        const rect = msgEl.getBoundingClientRect();
        const dist = Math.abs(rect.top + rect.height / 2 - centerY);
        if (dist < closestDist && i < onPathNodes.length) {
            closestDist = dist;
            closestIdx = couchTreeNodes.indexOf(onPathNodes[i]);
        }
    });
    if (closestIdx >= 0) highlightCouchTreeNode(closestIdx);
}

function filterCouchTree(query) {
    const q = (query || "").toLowerCase().trim();
    couchTreeNodes.forEach(tn => {
        if (!q || (tn.preview && tn.preview.toLowerCase().includes(q))) {
            tn.el.style.opacity = "1";
        } else {
            tn.el.style.opacity = "0.2";
        }
    });
}

async function loadTree() {
    if (!currentSessionId) {
        nodeMapEl.innerHTML = "";
        couchTreeNodes = [];
        return;
    }
    try {
        const tree = await apiGeneric(`/conversations/${currentSessionId}/tree`);
        const result = buildTreeLayout(tree, nodeMapEl, {}, onTreeNodeClick);
        couchTreeNodes = result.treeNodes;
        couchTreeHighlight = null;
    } catch (e) {
        console.error("Failed to load/render tree:", e);
        nodeMapEl.innerHTML = "";
        couchTreeNodes = [];
    }
}

// ---------------------------------------------------------------------------
// Board panel — pins with tags, same as chat board but standalone
// ---------------------------------------------------------------------------
async function loadBoard() {
    try {
        const [pins, files] = await Promise.all([
            apiGeneric("/pins"),
            apiGeneric("/files"),
        ]);
        boardPins = pins;
        boardFiles = files;
        renderBoard();
    } catch (e) {
        console.error("Failed to load board:", e);
    }
}

function renderBoard() {
    boardPinsEl.innerHTML = "";
    // Merge pins and files into a single list sorted by date (newest first)
    const items = [];
    for (const pin of boardPins) {
        items.push({ _kind: "pin", _date: pin.created, ...pin });
    }
    for (const file of boardFiles) {
        items.push({ _kind: "file", _date: file.uploaded_at, ...file });
    }
    items.sort((a, b) => (b._date || "").localeCompare(a._date || ""));
    for (const item of items) {
        if (item._kind === "file") {
            boardPinsEl.appendChild(createFileCardEl(item));
        } else {
            boardPinsEl.appendChild(createPinEl(item));
        }
    }
}

function formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k tok";
    return n + " tok";
}

function createFileCardEl(file) {
    const el = document.createElement("div");
    el.className = "board-pin board-file";
    el.dataset.fileId = file.id;

    const del = document.createElement("button");
    del.className = "pin-delete";
    del.textContent = "\u00d7";
    del.onclick = async (e) => {
        e.stopPropagation();
        await apiGeneric(`/files/${file.id}`, { method: "DELETE" });
        el.remove();
        boardFiles = boardFiles.filter(f => f.id !== file.id);
    };
    el.appendChild(del);

    // File type label
    const ext = file.filename.split(".").pop().toLowerCase();
    const typeLabel = document.createElement("span");
    typeLabel.className = "file-type-label";
    typeLabel.textContent = ext;
    el.appendChild(typeLabel);

    // Filename
    const nameEl = document.createElement("div");
    nameEl.className = "file-card-name";
    nameEl.textContent = file.filename;
    el.appendChild(nameEl);

    // Tags
    if (file.tags && file.tags.length > 0) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "pin-tags";
        for (const tag of file.tags) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag;
            tagsEl.appendChild(chip);
        }
        el.appendChild(tagsEl);
    }

    // Token count + date
    const meta = document.createElement("div");
    meta.className = "pin-meta";
    const tokSpan = document.createElement("span");
    tokSpan.textContent = formatTokens(file.token_count);
    meta.appendChild(tokSpan);
    const time = document.createElement("span");
    const d = new Date(file.uploaded_at);
    time.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    meta.appendChild(time);
    el.appendChild(meta);

    return el;
}

function createPinEl(pin) {
    const el = document.createElement("div");
    el.className = "board-pin";
    el.dataset.pinId = pin.id;

    const del = document.createElement("button");
    del.className = "pin-delete";
    del.textContent = "\u00d7";
    del.onclick = async (e) => {
        e.stopPropagation();
        await apiGeneric(`/pins/${pin.id}`, { method: "DELETE" });
        el.remove();
        boardPins = boardPins.filter(p => p.id !== pin.id);
    };
    el.appendChild(del);

    if (pin.type === "image") {
        const img = document.createElement("img");
        img.src = pin.content;
        img.loading = "lazy";
        el.appendChild(img);
    } else if (pin.type === "link") {
        const a = document.createElement("a");
        a.className = "pin-link";
        a.href = pin.content;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = pin.content;
        el.appendChild(a);
    } else {
        const txt = document.createElement("div");
        txt.className = "pin-text";
        txt.textContent = pin.content;
        el.appendChild(txt);
    }

    if (pin.note) {
        const note = document.createElement("div");
        note.className = "pin-note";
        note.textContent = pin.note;
        el.appendChild(note);
    }

    // Tag chips
    if (pin.tags && pin.tags.length > 0) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "pin-tags";
        for (const tag of pin.tags) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag;
            tagsEl.appendChild(chip);
        }
        el.appendChild(tagsEl);
    }

    const meta = document.createElement("div");
    meta.className = "pin-meta";
    const src = document.createElement("span");
    src.className = "pin-source";
    src.textContent = pin.source;
    meta.appendChild(src);
    const time = document.createElement("span");
    const d = new Date(pin.created);
    time.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    meta.appendChild(time);
    el.appendChild(meta);

    return el;
}

// Board input — extract #tags before pinning
function handleBoardSubmit() {
    const val = boardInput.value.trim();
    if (!val) return;
    const tagRegex = /#([a-zA-Z0-9-]+)/g;
    const extractedTags = [];
    let match;
    while ((match = tagRegex.exec(val)) !== null) {
        extractedTags.push(match[1].toLowerCase());
    }
    const text = val.replace(/#[a-zA-Z0-9-]+/g, "").trim();
    if (!text) { boardInput.value = ""; autoResizeBoardInput(); return; }
    const type = /^https?:\/\/\S+$/.test(text) ? "link" : "text";
    createPin(type, text, { tags: extractedTags });
    boardInput.value = "";
    autoResizeBoardInput();
}

async function createPin(type, content, opts = {}) {
    const pin = await apiGeneric("/pins", {
        method: "POST",
        body: JSON.stringify({
            type,
            content,
            source: opts.source || "couch",
            note: opts.note || null,
            tags: opts.tags || [],
        }),
    });
    boardPins.unshift(pin);
    boardPinsEl.prepend(createPinEl(pin));
}

// Board input auto-resize — matches chat textarea behavior
function autoResizeBoardInput() {
    boardInput.style.height = "auto";
    boardInput.style.height = Math.min(boardInput.scrollHeight, 200) + "px";
}

// ---------------------------------------------------------------------------
// Tag autocomplete — loads all tags from files + pins, shows dropdown
// as user types #partial in the message input.
// ---------------------------------------------------------------------------
async function loadAllTags() {
    try {
        const [fileTags, pinTags] = await Promise.all([
            apiGeneric("/files/tags"),
            apiGeneric("/pins/tags"),
        ]);
        allTags = [...new Set([...fileTags, ...pinTags])].sort();
    } catch (e) { allTags = []; }
}

function handleTagAutocomplete() {
    const text = messageInput.value;
    const cursorPos = messageInput.selectionStart;
    const before = text.slice(0, cursorPos);
    const match = before.match(/#([a-zA-Z0-9-]*)$/);

    if (!match) { hideTagAutocomplete(); return; }

    const partial = match[1].toLowerCase();
    const filtered = allTags.filter(t => t.startsWith(partial) || t.includes(partial));
    if (filtered.length === 0) { hideTagAutocomplete(); return; }

    tagAutocomplete.innerHTML = "";
    for (const tag of filtered.slice(0, 8)) {
        const item = document.createElement("div");
        item.className = "autocomplete-item";
        item.innerHTML = `<span class="tag-prefix">#</span>${escapeHtml(tag)}`;
        item.onmousedown = (e) => {
            e.preventDefault();
            const beforeTag = before.slice(0, before.length - match[0].length);
            const after = text.slice(cursorPos);
            messageInput.value = beforeTag + "#" + tag + " " + after;
            messageInput.focus();
            const newPos = beforeTag.length + tag.length + 2;
            messageInput.setSelectionRange(newPos, newPos);
            hideTagAutocomplete();
        };
        tagAutocomplete.appendChild(item);
    }
    tagAutocomplete.classList.add("visible");
}

function hideTagAutocomplete() {
    tagAutocomplete.classList.remove("visible");
    tagAutocomplete.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Context bar — shows active files/pins injected via #tags
// ---------------------------------------------------------------------------
async function loadContext() {
    if (!currentSessionId) {
        activeContext = { files: [], pins: [], total_tokens: 0 };
        renderContextBar();
        return;
    }
    try {
        const data = await apiGeneric(`/conversations/${currentSessionId}/context`);
        activeContext = {
            files: data.files || [],
            pins: data.pins || [],
            total_tokens: data.total_tokens || 0,
        };
    } catch (e) {
        activeContext = { files: [], pins: [], total_tokens: 0 };
    }
    renderContextBar();
}

function renderContextBar() {
    if (!contextBar) return;
    const hasFiles = activeContext.files && activeContext.files.length > 0;
    const hasPins = activeContext.pins && activeContext.pins.length > 0;
    if (!hasFiles && !hasPins) {
        contextBar.style.display = "none";
        return;
    }
    contextBar.style.display = "block";
    contextBarFiles.innerHTML = "";

    for (const f of (activeContext.files || [])) {
        const item = document.createElement("span");
        item.className = "context-file-item";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = f.filename;
        item.appendChild(nameSpan);
        const tokSpan = document.createElement("span");
        tokSpan.className = "context-file-tokens";
        tokSpan.textContent = formatTokens(f.token_count);
        item.appendChild(tokSpan);
        const removeBtn = document.createElement("button");
        removeBtn.className = "context-remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.onmousedown = async (e) => {
            e.preventDefault();
            await apiGeneric(`/conversations/${currentSessionId}/context/${f.id}`, { method: "DELETE" });
            await loadContext();
        };
        item.appendChild(removeBtn);
        contextBarFiles.appendChild(item);
    }

    for (const p of (activeContext.pins || [])) {
        const item = document.createElement("span");
        item.className = "context-file-item context-pin-item";
        const nameSpan = document.createElement("span");
        const label = (p.content || "").slice(0, 30) + (p.content && p.content.length > 30 ? "..." : "");
        nameSpan.textContent = label;
        item.appendChild(nameSpan);
        const tokSpan = document.createElement("span");
        tokSpan.className = "context-file-tokens";
        tokSpan.textContent = formatTokens(p.token_count);
        item.appendChild(tokSpan);
        const removeBtn = document.createElement("button");
        removeBtn.className = "context-remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.onmousedown = async (e) => {
            e.preventDefault();
            await apiGeneric(`/conversations/${currentSessionId}/context/pin/${p.id}`, { method: "DELETE" });
            await loadContext();
        };
        item.appendChild(removeBtn);
        contextBarFiles.appendChild(item);
    }

    contextTokenCount.textContent = formatTokens(activeContext.total_tokens);
    if (activeContext.total_tokens > 160000) {
        contextTokenCount.classList.add("warning");
    } else {
        contextTokenCount.classList.remove("warning");
    }
}

// ---------------------------------------------------------------------------
// Saved prompt loading — used by the modal dropdowns
// ---------------------------------------------------------------------------
async function loadPrompts() {
    try {
        savedPrompts = await apiGeneric("/prompts?category=couch");
    } catch (e) { savedPrompts = []; }
}

// ---------------------------------------------------------------------------
// System prompt modal — dropdown-based prompt selection per seat.
// Populates two <select> elements from savedPrompts, sets selection
// from current session metadata. Saves only prompt IDs (no baked content).
// ---------------------------------------------------------------------------
const promptsModal = document.getElementById("prompts-modal");
const promptSelectA = document.getElementById("prompt-a-select");
const promptSelectB = document.getElementById("prompt-b-select");

function populatePromptSelect(sel, selectedId) {
    sel.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "(default)";
    sel.appendChild(noneOpt);
    for (const p of savedPrompts) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
    }
    sel.value = selectedId || "";
}

async function openPromptsModal() {
    if (!currentSessionId) return;

    const meta = sessionMetadataCache[currentSessionId];
    if (meta) {
        document.getElementById("prompt-a-label").textContent = `${meta.model_a.label} (seat 1 — manages pacing)`;
        document.getElementById("prompt-b-label").textContent = `${meta.model_b.label} (seat 2)`;
    }

    // Fetch current prompt IDs from session
    let promptIdA = "";
    let promptIdB = "";
    try {
        const data = await api(`/sessions/${currentSessionId}/prompts`);
        promptIdA = data.prompt_id_a || "";
        promptIdB = data.prompt_id_b || "";
    } catch (e) {
        console.error("Failed to load prompts:", e);
    }

    populatePromptSelect(promptSelectA, promptIdA);
    populatePromptSelect(promptSelectB, promptIdB);

    document.getElementById("prompts-save-status").textContent = "";
    promptsModal.style.display = "flex";
}

async function savePrompts() {
    if (!currentSessionId) return;
    const promptIdA = promptSelectA.value;
    const promptIdB = promptSelectB.value;

    try {
        await fetch(`/api/couch/sessions/${currentSessionId}/prompts`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt_id_a: promptIdA || "",
                prompt_id_b: promptIdB || "",
            }),
        });
        // Update local cache
        const meta = sessionMetadataCache[currentSessionId];
        if (meta) {
            meta.prompt_id_a = promptIdA || null;
            meta.prompt_id_b = promptIdB || null;
        }
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
    // Clear both prompt IDs and any legacy baked content
    await fetch(`/api/couch/sessions/${currentSessionId}/prompts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt_id_a: "",
            prompt_id_b: "",
            prompt_a: "",
            prompt_b: "",
        }),
    });
    // Update local cache
    const meta = sessionMetadataCache[currentSessionId];
    if (meta) {
        meta.prompt_id_a = null;
        meta.prompt_id_b = null;
    }
    // Reload dropdowns to show defaults
    populatePromptSelect(promptSelectA, "");
    populatePromptSelect(promptSelectB, "");
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
messageInput.addEventListener("input", () => {
    autoResizeInput();
    handleTagAutocomplete();
});
messageInput.addEventListener("blur", () => {
    setTimeout(hideTagAutocomplete, 150);
});

messageInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const file = item.getAsFile();
            compressImage(file).then(({ base64, mediaType }) => {
                pendingImages.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
                renderCouchImagePreviews();
            });
            break;
        }
    }
});

// Tree scroll sync + search
messagesEl.addEventListener("scroll", syncCouchTreeWithScroll);
treeSearchEl.addEventListener("input", () => filterCouchTree(treeSearchEl.value));

// Board input listeners
document.getElementById("board-input-btn").onclick = handleBoardSubmit;
boardInput.addEventListener("input", autoResizeBoardInput);
boardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleBoardSubmit();
    }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
marked.setOptions({ breaks: true, gfm: true });
loadModels();
loadSessions();
loadBoard();
loadAllTags();
loadPrompts();
