// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentConversationId = null;
let ws = null;
let isStreaming = false;
let availableModels = [];
let savedPrompts = [];  // cached prompts list from API
let currentModel = null;
let treeData = null; // {nodes, current_path} from API
let editingMessageId = null; // message id being edited

// File injection state
let allFiles = [];
let allTags = [];
let activeContext = { files: [], total_tokens: 0 };

// Image paste state
let pendingImages = [];

// Moodboard state
let boardPins = [];

// Markdown streaming state
let streamingRawText = "";
let markdownRenderTimer = null;
const MARKDOWN_DEBOUNCE_MS = 80;

// DOM elements
const appEl = document.getElementById("app");
const conversationList = document.getElementById("conversation-list");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const inputArea = document.getElementById("input-area");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const modelSelect = document.getElementById("model-select");
const thinkingCheckbox = document.getElementById("thinking-checkbox");
const costDisplay = document.getElementById("cost-display");
const promptSelect = document.getElementById("prompt-select");
const boardPanel = document.getElementById("board-panel");
const boardContent = document.getElementById("board-content");
const boardPinsEl = document.getElementById("board-pins");
const boardInput = document.getElementById("board-input");
const nodeMap = document.getElementById("node-map");
const treeSearch = document.getElementById("tree-search");
const contextBar = document.getElementById("context-bar");
const contextBarFiles = document.getElementById("context-bar-files");
const contextTokenCount = document.getElementById("context-token-count");
const tagAutocomplete = document.getElementById("tag-autocomplete");
const filesNavBtn = document.getElementById("files-nav-btn");

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
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
    availableModels = await api("/models");
    populateModelSelect(modelSelect);
}

function populateModelSelect(select, selectedModel) {
    if (!select) return;
    select.innerHTML = "";
    for (const m of availableModels) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === selectedModel) opt.selected = true;
        select.appendChild(opt);
    }
}

// ---------------------------------------------------------------------------
// Prompts (for chat header dropdown)
// ---------------------------------------------------------------------------
async function loadPrompts() {
    savedPrompts = await api("/prompts");
}

function populatePromptSelect(selectedId) {
    if (!promptSelect) return;
    promptSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "(none)";
    promptSelect.appendChild(noneOpt);
    for (const p of savedPrompts) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === selectedId) opt.selected = true;
        promptSelect.appendChild(opt);
    }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------
async function loadConversations() {
    const convs = await api("/conversations");
    conversationList.innerHTML = "";
    for (const c of convs) {
        const li = document.createElement("li");
        li.dataset.id = c.id;
        if (c.id === currentConversationId) li.classList.add("active");

        const title = document.createElement("span");
        title.textContent = c.title;
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
            await api(`/conversations/${c.id}`, { method: "DELETE" });
            if (currentConversationId === c.id) {
                currentConversationId = null;
                showWelcome();
            }
            loadConversations();
        };
        li.appendChild(del);

        li.onclick = () => openConversation(c.id);
        conversationList.appendChild(li);
    }
}

async function quickCreateConversation() {
    try {
        const conv = await api("/conversations", {
            method: "POST",
            body: JSON.stringify({ title: "New conversation" }),
        });
        currentConversationId = conv.id;
        await loadConversations();
        await openConversation(conv.id);
    } catch (e) {
        console.error("Failed to create conversation:", e);
    }
}

async function openConversation(id) {
    currentConversationId = id;
    const conv = await api(`/conversations/${id}`);

    // Highlight active in sidebar
    document.querySelectorAll("#conversation-list li").forEach((li) => {
        li.classList.toggle("active", li.dataset.id === id);
    });

    // Show chat UI
    welcomeEl.style.display = "none";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";

    messagesEl.innerHTML = "";

    // Set model selector
    currentModel = conv.model;
    populateModelSelect(modelSelect, conv.model);

    // Set prompt dropdown
    populatePromptSelect(conv.prompt_id || "");

    // Set cost display
    updateCostDisplay(
        conv.total_input_tokens || 0,
        conv.total_output_tokens || 0,
        conv.total_cost || 0,
    );

    renderConversationMessages(conv.messages);
    scrollToBottom();
    await loadTree();
    // Snap tree to bottom to match chat scroll position on load
    nodeMap.scrollTop = nodeMap.scrollHeight;
    await loadContext();
    connectWebSocket(id);

    // Auto-toggle thinking: check if last assistant message had thinking blocks
    if (thinkingCheckbox) {
        let lastHadThinking = false;
        for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === "assistant") {
                const c = conv.messages[i].content;
                if (Array.isArray(c)) {
                    lastHadThinking = c.some(b => b.type === "thinking" && b.thinking);
                }
                break;
            }
        }
        thinkingCheckbox.checked = lastHadThinking;
    }

    messageInput.focus();
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    if (ws) { ws.close(); ws = null; }
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
    if (!currentConversationId) return;
    try {
        const data = await api(`/conversations/${currentConversationId}/cost`);
        updateCostDisplay(data.input_tokens, data.output_tokens, data.cost);
    } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket(conversationId) {
    if (ws) { ws.close(); ws = null; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/chat/${conversationId}`);
    ws.onopen = () => {};
    ws.onclose = () => {};
    ws.onerror = () => {};
    ws.onmessage = (evt) => {
        const event = JSON.parse(evt.data);
        handleStreamEvent(event);
    };
}

function showStopButton() {
    sendBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
}

function showSendButton() {
    stopBtn.style.display = "none";
    sendBtn.style.display = "inline-block";
    sendBtn.disabled = false;
}

function stopStreaming() {
    if (!isStreaming) return;

    // Final render of any partial content
    if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
    if (streamingTextEl && streamingRawText) {
        streamingTextEl.innerHTML = renderMarkdown(streamingRawText);
        removeStreamingCursor(streamingTextEl);
    }

    // Reset streaming state
    streamingRawText = "";
    markdownRenderTimer = null;
    if (streamingSearchEl) { streamingSearchEl.remove(); streamingSearchEl = null; }
    streamingEl = null;
    streamingTextEl = null;
    streamingThinkingEl = null;
    streamingToolCalls = {};
    toolResultsSinceLastText = false;
    isStreaming = false;
    editingMessageId = null;
    messageInput.disabled = false;
    showSendButton();

    // Close WS — server cleans up on disconnect — then reload the
    // conversation from DB so there's no stale partial message in the DOM
    // and all data attributes (msgId, parentId) are correct for edits.
    if (ws) { ws.close(); ws = null; }
    if (currentConversationId) {
        openConversation(currentConversationId);
    }
}

// ---------------------------------------------------------------------------
// Streaming event handler
// ---------------------------------------------------------------------------
let streamingEl = null;
let streamingTextEl = null;
let streamingThinkingEl = null;
let streamingToolCalls = {};
let lastUsageEvent = null;
let streamingSearchEl = null;
let toolResultsSinceLastText = false;

function handleStreamEvent(event) {
    switch (event.type) {
        case "thinking_delta":
            if (!streamingEl) startStreamingMessage();
            if (!streamingThinkingEl) {
                streamingThinkingEl = createThinkingBlock(streamingEl);
            }
            const thinkingContent = streamingThinkingEl.querySelector(".thinking-content");
            thinkingContent.textContent += event.thinking;
            thinkingContent.classList.add("streaming-cursor");
            maybeScrollToBottom();
            break;

        case "thinking_done":
            if (streamingThinkingEl) {
                const tc = streamingThinkingEl.querySelector(".thinking-content");
                tc.classList.remove("streaming-cursor");
                const label = streamingThinkingEl.querySelector(".thinking-label");
                if (label) label.textContent = "thought process";
            }
            streamingThinkingEl = null;
            break;

        case "web_search_start":
            if (!streamingEl) startStreamingMessage();
            streamingSearchEl = document.createElement("div");
            streamingSearchEl.className = "web-search-indicator";
            streamingSearchEl.textContent = "searching the web...";
            const textElBefore = streamingEl.querySelector(".message-text");
            streamingEl.insertBefore(streamingSearchEl, textElBefore);
            maybeScrollToBottom();
            break;

        case "web_search_result":
            if (streamingSearchEl) {
                streamingSearchEl.textContent = "web search complete";
                setTimeout(() => {
                    if (streamingSearchEl) {
                        streamingSearchEl.remove();
                        streamingSearchEl = null;
                    }
                }, 1500);
            }
            break;

        case "text_delta":
            if (!streamingEl) startStreamingMessage();
            // After tool results, create a new text element below the tool blocks
            if (toolResultsSinceLastText) {
                streamingTextEl = document.createElement("div");
                streamingTextEl.className = "message-text";
                streamingEl.appendChild(streamingTextEl);
                streamingRawText = "";
                toolResultsSinceLastText = false;
            }
            streamingRawText += event.text;
            scheduleMarkdownRender();
            maybeScrollToBottom();
            break;

        case "tool_use_start":
            if (!streamingEl) startStreamingMessage();
            streamingToolCalls[event.tool_use_id] = {
                name: event.tool_name,
                inputParts: [],
                input: null,
                result: null,
            };
            break;

        case "tool_use_delta":
            if (event.tool_use_id && streamingToolCalls[event.tool_use_id]) {
                const tc = streamingToolCalls[event.tool_use_id];
                if (typeof event.tool_input === "object") {
                    tc.input = event.tool_input;
                } else if (typeof event.tool_input === "string") {
                    tc.inputParts.push(event.tool_input);
                }
            }
            break;

        case "tool_result":
            toolResultsSinceLastText = true;
            if (event.tool_use_id && streamingToolCalls[event.tool_use_id]) {
                streamingToolCalls[event.tool_use_id].result = event.tool_result;
                renderToolCallBlock(streamingEl, streamingToolCalls[event.tool_use_id]);
                maybeScrollToBottom();
            }
            break;

        case "usage":
            lastUsageEvent = event;
            break;

        case "title_update":
            if (event.text) {
                // Update sidebar with new title
                const activeItem = conversationList.querySelector(`li[data-id="${currentConversationId}"] span`);
                if (activeItem) activeItem.textContent = event.text;
            }
            break;

        case "message_done":
            // Final markdown render
            if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
            if (streamingTextEl && streamingRawText) {
                streamingTextEl.innerHTML = renderMarkdown(streamingRawText);
                removeStreamingCursor(streamingTextEl);
            }
            streamingRawText = "";
            markdownRenderTimer = null;
            if (streamingSearchEl) {
                streamingSearchEl.remove();
                streamingSearchEl = null;
            }
            for (const [id, tc] of Object.entries(streamingToolCalls)) {
                if (!tc.result) {
                    renderToolCallBlock(streamingEl, tc);
                }
            }

            // Auto-toggle thinking checkbox: if this response used thinking, keep it on;
            // otherwise turn it off. Persists the user's intent across turns.
            if (thinkingCheckbox) {
                const usedThinking = streamingEl &&
                    streamingEl.querySelector(".thinking-block") !== null;
                thinkingCheckbox.checked = !!usedThinking;
            }

            const wasEdit = !!editingMessageId;
            streamingEl = null;
            streamingTextEl = null;
            streamingThinkingEl = null;
            streamingToolCalls = {};
            toolResultsSinceLastText = false;
            isStreaming = false;
            editingMessageId = null;
            sendBtn.disabled = false;
            messageInput.disabled = false;
            showSendButton();
            lastUsageEvent = null;

            if (wasEdit) {
                // Reload to get proper branch state, IDs, and tree
                openConversation(currentConversationId);
            } else {
                messageInput.focus();
                fetchAndUpdateCost();
                loadConversations();
                scrollToBottom();
                loadTree();
                syncMessageIds();
            }
            break;

        case "context_update":
            activeContext = { files: event.files || [], total_tokens: event.total_tokens || 0 };
            renderContextBar();
            break;

        case "error":
            if (!streamingEl) startStreamingMessage();
            const isRetry = event.error && event.error.includes("retrying");
            const errEl = document.createElement("div");
            errEl.style.color = isRetry ? "#e8a838" : "#c00";
            errEl.style.fontSize = "0.8rem";
            errEl.textContent = isRetry ? event.error : `error: ${event.error}`;
            streamingEl.appendChild(errEl);
            // Retry messages don't end the stream — only final errors do
            if (!isRetry) {
                isStreaming = false;
                sendBtn.disabled = false;
                messageInput.disabled = false;
                showSendButton();
            }
            maybeScrollToBottom();
            break;
    }
}

function startStreamingMessage() {
    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }
    streamingEl = createMessageEl("assistant");
    streamingTextEl = streamingEl.querySelector(".message-text");
    messagesEl.appendChild(streamingEl);
}

// ---------------------------------------------------------------------------
// Thinking block rendering
// ---------------------------------------------------------------------------
function createThinkingBlock(parentEl) {
    const container = document.createElement("div");
    container.className = "thinking-block";

    const header = document.createElement("div");
    header.className = "thinking-header open";
    header.innerHTML = '<span class="arrow">&#9654;</span> <span class="thinking-label">thinking...</span>';
    container.appendChild(header);

    const body = document.createElement("div");
    body.className = "thinking-body open";

    const content = document.createElement("div");
    content.className = "thinking-content";
    body.appendChild(content);
    container.appendChild(body);

    const textEl = parentEl.querySelector(".message-text");
    parentEl.insertBefore(container, textEl);

    header.onclick = () => {
        header.classList.toggle("open");
        body.classList.toggle("open");
    };

    return container;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function createMessageEl(role, index, msgId, parentId) {
    const div = document.createElement("div");
    div.className = `message ${role}`;
    if (index !== undefined) div.dataset.msgIndex = index;
    if (msgId) div.dataset.msgId = msgId;
    div.dataset.parentId = parentId || "";

    const label = document.createElement("div");
    label.className = "role-label";
    label.textContent = role === "user" ? "you" : "claude";
    div.appendChild(label);

    const text = document.createElement("div");
    text.className = "message-text";
    div.appendChild(text);

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "message-actions";

    if (role === "user") {
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.textContent = "edit";
        editBtn.onclick = () => startEdit(div);
        actions.appendChild(editBtn);
    }

    if (role === "assistant") {
        const copyBtn = document.createElement("button");
        copyBtn.className = "msg-action-btn";
        copyBtn.textContent = "copy";
        copyBtn.onclick = () => copyMessageText(div);
        actions.appendChild(copyBtn);

        const regenBtn = document.createElement("button");
        regenBtn.className = "msg-action-btn";
        regenBtn.textContent = "regenerate";
        regenBtn.onclick = () => regenerateResponse(div);
        actions.appendChild(regenBtn);
    }

    const pinBtn = document.createElement("button");
    pinBtn.className = "msg-action-btn";
    pinBtn.textContent = "pin";
    pinBtn.onclick = () => pinMessage(div);
    actions.appendChild(pinBtn);

    div.appendChild(actions);

    return div;
}

// Per-edit image attachments — separate from the main pendingImages
let editPendingImages = [];

function startEdit(msgEl) {
    if (isStreaming) return;

    // Remove any existing edit forms
    document.querySelectorAll(".edit-form").forEach(f => f.remove());
    editPendingImages = [];

    const textEl = msgEl.querySelector(".message-text");
    const currentText = msgEl.dataset.rawText || textEl.textContent;
    const parentId = msgEl.dataset.parentId || null;

    // Collect existing images from this message for re-attachment
    const existingImages = msgEl.querySelectorAll(".message-image");
    for (const img of existingImages) {
        const src = img.src;
        if (src.startsWith("data:")) {
            const [header, data] = src.split(",");
            const mediaType = header.match(/data:(.*?);/)?.[1] || "image/png";
            editPendingImages.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
        }
    }

    const form = document.createElement("div");
    form.className = "edit-form";

    const textarea = document.createElement("textarea");
    textarea.className = "edit-textarea";
    textarea.value = currentText;
    form.appendChild(textarea);

    // Image preview area
    const previewArea = document.createElement("div");
    previewArea.className = "image-preview-area";
    form.appendChild(previewArea);
    renderEditImagePreviews(previewArea);

    const actions = document.createElement("div");
    actions.className = "edit-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "cancel";
    cancelBtn.onclick = () => { editPendingImages = []; form.remove(); };
    actions.appendChild(cancelBtn);

    const sendEditBtn = document.createElement("button");
    sendEditBtn.className = "edit-send";
    sendEditBtn.textContent = "send edit";
    sendEditBtn.onclick = () => submitEdit(parentId, textarea.value.trim(), form);
    actions.appendChild(sendEditBtn);

    form.appendChild(actions);
    msgEl.appendChild(form);

    // Auto-grow textarea
    function autoGrow() {
        textarea.style.height = "0";
        textarea.style.height = textarea.scrollHeight + "px";
    }
    textarea.addEventListener("input", autoGrow);

    // Paste images into edit form
    textarea.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith("image/")) {
                e.preventDefault();
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = reader.result.split(",")[1];
                    editPendingImages.push({ type: "image", source: { type: "base64", media_type: item.type, data: base64 } });
                    renderEditImagePreviews(previewArea);
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });

    textarea.focus();
    // Set initial height
    requestAnimationFrame(autoGrow);

    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitEdit(parentId, textarea.value.trim(), form);
        }
    });
}

function renderEditImagePreviews(container) {
    container.innerHTML = "";
    editPendingImages.forEach((img, i) => {
        const wrapper = document.createElement("div");
        wrapper.className = "image-preview";
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        wrapper.appendChild(imgEl);
        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.onclick = () => {
            editPendingImages.splice(i, 1);
            renderEditImagePreviews(container);
        };
        wrapper.appendChild(removeBtn);
        container.appendChild(wrapper);
    });
}

function submitEdit(parentId, newText, formEl) {
    const hasImages = editPendingImages.length > 0;
    if ((!newText && !hasImages) || !ws || !currentConversationId || isStreaming) return;

    // Find the message element that contains this edit form, then remove
    // it and everything after it — keeps prior conversation visible.
    const editedMsg = formEl.closest(".message");
    formEl.remove();
    if (editedMsg) {
        while (editedMsg.nextSibling) editedMsg.nextSibling.remove();
        editedMsg.remove();
    }

    isStreaming = true;
    editingMessageId = parentId;
    sendBtn.disabled = true;
    messageInput.disabled = true;
    showStopButton();

    const userEl = createMessageEl("user");
    const textEl = userEl.querySelector(".message-text");
    if (newText) textEl.textContent = newText;
    for (const img of editPendingImages) {
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        imgEl.className = "message-image";
        textEl.appendChild(imgEl);
    }
    userEl.dataset.rawText = newText;
    messagesEl.appendChild(userEl);
    scrollToBottom();

    // Build payload — use block list if images are present
    let messagePayload;
    if (hasImages) {
        const blocks = [];
        if (newText) blocks.push({ type: "text", text: newText });
        blocks.push(...editPendingImages);
        messagePayload = blocks;
    } else {
        messagePayload = newText;
    }

    const payload = {
        action: "edit",
        parent_id: parentId,
        message: messagePayload,
    };
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }

    ws.send(JSON.stringify(payload));
    editPendingImages = [];
}

function renderConversationMessages(messages) {
    messagesEl.innerHTML = "";
    let renderedCount = 0;
    let lastAssistantEl = null;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const content = msg.content;
        if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
            continue;
        }

        // Merge consecutive assistant messages (from tool use loops)
        if (msg.role === "assistant" && lastAssistantEl) {
            appendAssistantContent(lastAssistantEl, content);
            continue;
        }

        if (renderedCount > 0) {
            const spacer = document.createElement("div");
            spacer.className = "message-spacer";
            messagesEl.appendChild(spacer);
        }
        const el = renderMessage(msg.role, content, i, msg.id, msg.parent_id);
        lastAssistantEl = (msg.role === "assistant") ? el : null;
        renderedCount++;
    }
}

function renderMessage(role, content, index, msgId, parentId) {
    // Skip tool_result messages — they show inline via tool call blocks
    if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
        return;
    }

    const el = createMessageEl(role, index, msgId, parentId);
    const textEl = el.querySelector(".message-text");

    if (typeof content === "string") {
        if (role === "assistant") {
            textEl.innerHTML = renderMarkdown(content);
        } else {
            textEl.textContent = content;
            el.dataset.rawText = content;
        }
    } else if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
                const thinkingBlock = createThinkingBlock(el);
                thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                thinkingBlock.querySelector(".thinking-body").classList.remove("open");
            } else if (block.type === "text" && block.text) {
                textParts.push(block.text);
            } else if (block.type === "tool_use") {
                renderToolCallBlock(el, {
                    name: block.name,
                    input: block.input,
                    result: null,
                });
            } else if (block.type === "image" && block.source) {
                const img = document.createElement("img");
                img.src = `data:${block.source.media_type};base64,${block.source.data}`;
                img.className = "message-image";
                textEl.appendChild(img);
            }
        }
        if (textParts.length > 0) {
            const fullText = textParts.join("");
            if (role === "assistant") {
                textEl.innerHTML = renderMarkdown(fullText);
            } else {
                // Insert text before any images already appended
                const textNode = document.createTextNode(fullText);
                textEl.insertBefore(textNode, textEl.firstChild);
                el.dataset.rawText = fullText;
            }
        }
    }

    messagesEl.appendChild(el);
    return el;
}

// Append content from a continuation assistant message (after tool use loop)
// into an existing assistant message element
function appendAssistantContent(el, content) {
    if (!Array.isArray(content)) return;
    const textParts = [];
    for (const block of content) {
        if (block.type === "thinking" && block.thinking) {
            const thinkingBlock = createThinkingBlock(el);
            thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
            thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
            thinkingBlock.querySelector(".thinking-header").classList.remove("open");
            thinkingBlock.querySelector(".thinking-body").classList.remove("open");
        } else if (block.type === "text" && block.text) {
            textParts.push(block.text);
        } else if (block.type === "tool_use") {
            renderToolCallBlock(el, {
                name: block.name,
                input: block.input,
                result: null,
            });
        } else if (block.type === "image" && block.source) {
            const img = document.createElement("img");
            img.src = `data:${block.source.media_type};base64,${block.source.data}`;
            img.className = "message-image";
            el.querySelector(".message-text").appendChild(img);
        }
    }
    if (textParts.length > 0) {
        const newTextEl = document.createElement("div");
        newTextEl.className = "message-text";
        newTextEl.innerHTML = renderMarkdown(textParts.join(""));
        el.appendChild(newTextEl);
    }
}

function renderToolCallBlock(parentEl, toolCall) {
    const container = document.createElement("div");
    container.className = "tool-call";

    const header = document.createElement("div");
    header.className = "tool-call-header";
    header.innerHTML = `<span class="arrow">&#9654;</span> tool: <strong>${escapeHtml(toolCall.name)}</strong>`;
    container.appendChild(header);

    const body = document.createElement("div");
    body.className = "tool-call-body";

    const inputData = toolCall.input ||
        (toolCall.inputParts && toolCall.inputParts.length > 0
            ? tryParseJSON(toolCall.inputParts.join(""))
            : null);

    if (inputData) {
        const inputLabel = document.createElement("div");
        inputLabel.className = "label";
        inputLabel.textContent = "input:";
        body.appendChild(inputLabel);
        const inputPre = document.createElement("pre");
        inputPre.textContent = typeof inputData === "string" ? inputData : JSON.stringify(inputData, null, 2);
        body.appendChild(inputPre);
    }

    if (toolCall.result) {
        const resultLabel = document.createElement("div");
        resultLabel.className = "label";
        resultLabel.textContent = "result:";
        body.appendChild(resultLabel);
        const resultPre = document.createElement("pre");
        resultPre.textContent = toolCall.result;
        body.appendChild(resultPre);
    }

    container.appendChild(body);
    parentEl.appendChild(container);

    header.onclick = () => {
        header.classList.toggle("open");
        body.classList.toggle("open");
    };
}

// ---------------------------------------------------------------------------
// Tree navigator
// ---------------------------------------------------------------------------
let treeNodes = [];
let treeChildrenMap = {};  // parent_id → [child_id, ...] (visible nodes only)
let treeParentMap = {};    // child_id → parent_id (visible parent)
let arrowNavActive = false; // suppresses scroll↔tree sync during keyboard nav
let arrowNavTimer = null;

async function loadTree() {
    if (!currentConversationId) return;
    try {
        treeData = await api(`/conversations/${currentConversationId}/tree`);
        buildTree();
    } catch (e) {
        console.error("Failed to load tree:", e);
    }
}

function buildTree() {
    nodeMap.innerHTML = "";
    treeNodes = [];
    if (!treeData || !treeData.nodes || treeData.nodes.length === 0) return;

    const nodes = treeData.nodes;
    const currentPath = new Set(treeData.current_path || []);

    // Build children map, skipping nodes that don't appear in the chat:
    // 1. tool_result nodes (user role + empty preview)
    // 2. continuation assistant nodes (assistant following a tool_result,
    //    which the chat merges into the previous assistant message)
    // Skipped nodes' children get re-parented to the nearest visible ancestor.
    const skippedIds = new Set();
    const parentOf = {};
    const roleOf = {};
    for (const n of nodes) {
        parentOf[n.id] = n.parent_id;
        roleOf[n.id] = n.role;
        if (n.role === "user" && n.parent_id && !n.preview) {
            skippedIds.add(n.id);
        }
    }
    // Mark continuation assistants: their parent is a tool_result whose
    // parent is an assistant — i.e. they're part of a tool-use loop.
    for (const n of nodes) {
        if (n.role !== "assistant" || !n.parent_id) continue;
        if (!skippedIds.has(n.parent_id)) continue; // parent must be a tool_result
        // Walk up past any chain of skipped nodes to find the visible ancestor
        let ancestor = n.parent_id;
        while (ancestor && skippedIds.has(ancestor)) {
            ancestor = parentOf[ancestor];
        }
        if (ancestor && roleOf[ancestor] === "assistant") {
            skippedIds.add(n.id);
        }
    }

    const childrenMap = {};
    const nodeById = {};
    let rootId = null;
    for (const n of nodes) {
        if (skippedIds.has(n.id)) continue;
        nodeById[n.id] = n;

        // Re-parent if our parent was a skipped node
        let pid = n.parent_id;
        while (pid && skippedIds.has(pid)) {
            pid = parentOf[pid];
        }

        if (!pid) {
            rootId = n.id;
        } else {
            if (!childrenMap[pid]) childrenMap[pid] = [];
            childrenMap[pid].push(n.id);
        }
    }

    if (!rootId) return;

    // Expose topology for keyboard navigation
    treeChildrenMap = childrenMap;
    treeParentMap = {};
    for (const n of nodes) {
        if (skippedIds.has(n.id)) continue;
        let pid = n.parent_id;
        while (pid && skippedIds.has(pid)) {
            pid = parentOf[pid];
        }
        if (pid) treeParentMap[n.id] = pid;
    }

    // Layout: compact tree — leaves get sequential columns left-to-right,
    // parents center over their children. This lets branches from different
    // parents share vertical space when they don't conflict.
    const layout = [];
    let nextLeafCol = 0;

    function layoutDfs(nodeId, depth, effectiveParent) {
        const node = nodeById[nodeId];
        if (!node) return null;

        const kids = childrenMap[nodeId] || [];

        if (kids.length === 0) {
            // Leaf — assign next available column
            const col = nextLeafCol++;
            layout.push({ ...node, col, depth, onPath: currentPath.has(nodeId), drawParent: effectiveParent });
            return col;
        }

        // Non-leaf: layout children first (post-order), then center this node
        const childCols = [];
        for (const kid of kids) {
            const c = layoutDfs(kid, depth + 1, nodeId);
            if (c !== null) childCols.push(c);
        }

        const col = childCols.length > 0
            ? childCols.reduce((a, b) => a + b, 0) / childCols.length
            : nextLeafCol++;
        layout.push({ ...node, col, depth, onPath: currentPath.has(nodeId), drawParent: effectiveParent });
        return col;
    }

    layoutDfs(rootId, 0, null);

    // Render — use depth for Y, col for X
    const layerGap = 28;
    const colGap = 24;
    const startY = 16;
    const baseX = 16;
    const nodeRadius = { user: 6, assistant: 4 };

    const minCol = Math.min(...layout.map(n => n.col));
    const maxCol = Math.max(...layout.map(n => n.col));
    const maxDepth = Math.max(...layout.map(n => n.depth));
    const totalHeight = startY + (maxDepth + 1) * layerGap + 20;
    const totalWidth = baseX + (maxCol - minCol + 1) * colGap + 40;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const svgW = Math.max(totalWidth + centerOffsetX, panelWidth, 180);
    svg.setAttribute("width", svgW);
    svg.setAttribute("height", totalHeight);
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    nodeMap.appendChild(svg);

    // Normal-flow spacer so the container has scrollable height
    const spacerDiv = document.createElement("div");
    spacerDiv.style.height = totalHeight + "px";
    spacerDiv.style.pointerEvents = "none";
    nodeMap.appendChild(spacerDiv);

    // Center tree horizontally when content is narrower than the panel
    const panelWidth = nodeMap.clientWidth || 200;
    const centerOffsetX = totalWidth < panelWidth ? Math.floor((panelWidth - totalWidth) / 2) : 0;

    // Position map — Y from depth, X from column
    const posMap = {};
    layout.forEach((item) => {
        const x = centerOffsetX + baseX + (item.col - minCol) * colGap;
        const y = startY + item.depth * layerGap;
        posMap[item.id] = { x, y };
    });

    // Draw connections (using drawParent — the visible parent after skipping
    // tool_result and continuation assistant nodes)
    for (const item of layout) {
        if (item.drawParent && posMap[item.drawParent] && posMap[item.id]) {
            const p = posMap[item.drawParent];
            const c = posMap[item.id];
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const midY = (p.y + c.y) / 2;
            path.setAttribute("d", `M${p.x},${p.y} C${p.x},${midY} ${c.x},${midY} ${c.x},${c.y}`);
            path.setAttribute("stroke", item.onPath && currentPath.has(item.drawParent) ? "#111" : "#ccc");
            path.setAttribute("stroke-width", item.onPath ? "1.5" : "1");
            path.setAttribute("fill", "none");
            svg.appendChild(path);
        }
    }

    // Draw depth indicator lines every 10 exchanges
    for (let d = 10; d <= maxDepth; d += 10) {
        const y = startY + d * layerGap;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", 0);
        line.setAttribute("y1", y);
        line.setAttribute("x2", svgW);
        line.setAttribute("y2", y);
        line.setAttribute("stroke", "#eee");
        line.setAttribute("stroke-width", "1");
        svg.appendChild(line);

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", 4);
        label.setAttribute("y", y - 3);
        label.setAttribute("fill", "#ccc");
        label.setAttribute("font-size", "9px");
        label.setAttribute("font-family", "inherit");
        label.textContent = String(d);
        svg.appendChild(label);
    }

    // Draw nodes
    const lastOnPath = treeData.current_path?.[treeData.current_path.length - 1];

    layout.forEach((item, i) => {
        const pos = posMap[item.id];
        const r = nodeRadius[item.role] || 5;

        const node = document.createElement("div");
        node.className = `tree-node ${item.role}-node`;
        if (item.onPath) node.classList.add("on-path");
        if (item.id === lastOnPath) node.classList.add("current-node");

        node.style.left = (pos.x - r) + "px";
        node.style.top = (pos.y - r) + "px";

        // Click to navigate
        node.onclick = () => navigateToNode(item.id);

        nodeMap.appendChild(node);
        treeNodes.push({ id: item.id, index: i, role: item.role, preview: item.preview, x: pos.x, y: pos.y, depth: item.depth, el: node, onPath: item.onPath });
    });
}

async function navigateToNode(nodeId) {
    if (isStreaming || !currentConversationId) return;

    // Check if node is on current path — just scroll to it
    if (treeData && treeData.current_path && treeData.current_path.includes(nodeId)) {
        const msgEl = messagesEl.querySelector(`.message[data-msg-id="${nodeId}"]`);
        if (msgEl) {
            msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
    }

    // Switch branch — reload messages, then rebuild tree (layout is stable
    // because children are always in creation order, not sorted by path)
    try {
        const conv = await api(`/conversations/${currentConversationId}/switch/${nodeId}`, {
            method: "POST",
        });

        renderConversationMessages(conv.messages);
        scrollToBottom();

        // Rebuild tree highlighting (layout stays the same due to stable sort)
        await loadTree();
    } catch (e) {
        console.error("Failed to switch branch:", e);
    }
}

let currentHighlight = null;
function highlightTreeNode(index) {
    if (currentHighlight !== null && treeNodes[currentHighlight]) {
        treeNodes[currentHighlight].el.classList.remove("scroll-highlight");
    }
    if (treeNodes[index]) {
        treeNodes[index].el.classList.add("scroll-highlight");
        treeNodes[index].el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        currentHighlight = index;
    }
}

// Sync tree highlight with message scroll position.
// Suppressed during arrow-key navigation to avoid fighting the highlight.
function syncTreeWithScroll() {
    if (arrowNavActive) return;
    const msgEls = messagesEl.querySelectorAll(".message");
    if (msgEls.length === 0 || treeNodes.length === 0) return;

    const containerRect = messagesEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    let closestIdx = 0;
    let closestDist = Infinity;

    // Match message elements to on-path tree nodes.
    // Sort by depth so they align with DOM order (shallowest first).
    const onPathNodes = treeNodes.filter(tn => tn.onPath).sort((a, b) => a.depth - b.depth);
    if (onPathNodes.length === 0) return;

    // Snap to last node when scrolled to bottom, first when at top.
    // Use scrollIntoView "end"/"start" so the tree visually matches.
    const scrollBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    if (scrollBottom < 40) {
        const idx = treeNodes.indexOf(onPathNodes[onPathNodes.length - 1]);
        if (idx >= 0) highlightTreeNode(idx);
        // Scroll the tree panel itself to the bottom
        nodeMap.scrollTo({ top: nodeMap.scrollHeight, behavior: "smooth" });
        return;
    }
    if (messagesEl.scrollTop < 40) {
        const idx = treeNodes.indexOf(onPathNodes[0]);
        if (idx >= 0) highlightTreeNode(idx);
        nodeMap.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }

    msgEls.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top + rect.height / 2 - centerY);
        if (dist < closestDist && i < onPathNodes.length) {
            closestDist = dist;
            closestIdx = treeNodes.indexOf(onPathNodes[i]);
        }
    });

    if (closestIdx >= 0) highlightTreeNode(closestIdx);
}

// Tree search
function filterTree() {
    const query = treeSearch.value.toLowerCase().trim();
    treeNodes.forEach(tn => {
        if (!query || (tn.preview && tn.preview.toLowerCase().includes(query))) {
            tn.el.style.opacity = "1";
        } else {
            tn.el.style.opacity = "0.2";
        }
    });
}

// Arrow key navigation for the tree panel.
// Up/Down walk on-path nodes and scroll the message into view.
// Left/Right jump between nodes at the same tree depth (same layer),
// sorted by x position. If the target is off-path, triggers a branch switch.
function navigateTreeArrowKey(direction) {
    if (treeNodes.length === 0) return;

    const onPathNodes = treeNodes.filter(tn => tn.onPath).sort((a, b) => a.depth - b.depth);
    if (onPathNodes.length === 0) return;

    // Suppress scroll↔tree sync so the smooth scroll doesn't fight our highlight
    arrowNavActive = true;
    clearTimeout(arrowNavTimer);
    arrowNavTimer = setTimeout(() => { arrowNavActive = false; }, 600);

    if (direction === "up" || direction === "down") {
        // Find currently highlighted on-path node
        let curOnPathIdx = -1;
        if (currentHighlight !== null) {
            const highlighted = treeNodes[currentHighlight];
            if (highlighted && highlighted.onPath) {
                curOnPathIdx = onPathNodes.indexOf(highlighted);
            }
        }
        // Default to last on-path node if nothing highlighted
        if (curOnPathIdx < 0) curOnPathIdx = onPathNodes.length - 1;

        let nextIdx;
        if (direction === "up") {
            nextIdx = curOnPathIdx > 0 ? curOnPathIdx - 1 : 0;
        } else {
            nextIdx = curOnPathIdx < onPathNodes.length - 1 ? curOnPathIdx + 1 : onPathNodes.length - 1;
        }

        const target = onPathNodes[nextIdx];
        highlightTreeNode(treeNodes.indexOf(target));

        // Scroll the corresponding message into view (it's on the current path)
        const msgEl = messagesEl.querySelector(`.message[data-msg-id="${target.id}"]`);
        if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });

    } else if (direction === "left" || direction === "right") {
        // Find the highlighted node (or fall back to last on-path node)
        let current = null;
        if (currentHighlight !== null && treeNodes[currentHighlight]) {
            current = treeNodes[currentHighlight];
        }
        if (!current && onPathNodes.length > 0) {
            current = onPathNodes[onPathNodes.length - 1];
        }
        if (!current) return;

        // Collect all nodes at the same depth, sorted by x position
        const sameLayer = treeNodes
            .filter(tn => tn.depth === current.depth)
            .sort((a, b) => a.x - b.x);
        if (sameLayer.length <= 1) return;

        const curIdx = sameLayer.indexOf(current);
        let nextIdx;
        if (direction === "right") {
            nextIdx = (curIdx + 1) % sameLayer.length;
        } else {
            nextIdx = (curIdx - 1 + sameLayer.length) % sameLayer.length;
        }
        if (nextIdx === curIdx) return;

        const target = sameLayer[nextIdx];
        highlightTreeNode(treeNodes.indexOf(target));

        // If target is off the current path, switch branches via API
        if (!target.onPath) {
            navigateToNode(target.id);
        } else {
            const msgEl = messagesEl.querySelector(`.message[data-msg-id="${target.id}"]`);
            if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
function sendMessage() {
    const rawText = messageInput.value.trim();
    const hasImages = pendingImages.length > 0;
    if ((!rawText && !hasImages) || isStreaming || !ws || !currentConversationId) return;

    // Extract #tags from message
    const tagRegex = /#([a-zA-Z0-9-]+)/g;
    const extractedTags = [];
    let match;
    while ((match = tagRegex.exec(rawText)) !== null) {
        extractedTags.push(match[1].toLowerCase());
    }
    // Strip tags from the display/sent message
    const text = rawText.replace(/#[a-zA-Z0-9-]+/g, "").trim();

    // If we have text or images to display, show user message
    if (text || hasImages) {
        if (messagesEl.children.length > 0) {
            const spacer = document.createElement("div");
            spacer.className = "message-spacer";
            messagesEl.appendChild(spacer);
        }
        const userEl = createMessageEl("user");
        const textEl = userEl.querySelector(".message-text");
        if (text) {
            textEl.textContent = text;
            userEl.dataset.rawText = text;
        }
        // Show image thumbnails in the sent message
        for (const img of pendingImages) {
            const imgEl = document.createElement("img");
            imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
            imgEl.className = "message-image";
            textEl.appendChild(imgEl);
        }
        messagesEl.appendChild(userEl);
        scrollToBottom();
    }

    // Build payload — use block list if images are present
    let messagePayload;
    if (hasImages) {
        const blocks = [];
        if (text) blocks.push({ type: "text", text: text });
        blocks.push(...pendingImages);
        messagePayload = blocks;
    } else {
        messagePayload = text;
    }

    const payload = { message: messagePayload };
    if (extractedTags.length > 0) {
        payload.inject_tags = extractedTags;
    }
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }

    ws.send(JSON.stringify(payload));
    messageInput.value = "";
    clearImagePreviews();
    hideTagAutocomplete();
    autoResizeInput();

    // Only set streaming state if there's actual content to send
    if (text || hasImages) {
        isStreaming = true;
        sendBtn.disabled = true;
        messageInput.disabled = true;
        showStopButton();
    }
}

// ---------------------------------------------------------------------------
// Image preview management
// ---------------------------------------------------------------------------
function renderImagePreviews() {
    let area = document.getElementById("image-preview-area");
    if (!area) {
        area = document.createElement("div");
        area.id = "image-preview-area";
        area.className = "image-preview-area";
        // Insert before the textarea in the input wrapper
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
            renderImagePreviews();
        };
        preview.appendChild(removeBtn);
        area.appendChild(preview);
    });
}

function clearImagePreviews() {
    pendingImages = [];
    const area = document.getElementById("image-preview-area");
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

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
    if (!text) return "";
    // Close any open code fences so partial streaming doesn't break layout
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

    // Descend to the deepest last inline-containing element
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

// Patch DOM elements with server-assigned message IDs so edits work on fresh messages
async function syncMessageIds() {
    if (!currentConversationId) return;
    try {
        const conv = await api(`/conversations/${currentConversationId}`);
        const msgEls = messagesEl.querySelectorAll(".message");
        const convMsgs = conv.messages.filter(m => {
            if (Array.isArray(m.content) && m.content.every(b => b.type === "tool_result")) return false;
            return true;
        });
        for (let i = 0; i < Math.min(msgEls.length, convMsgs.length); i++) {
            msgEls[i].dataset.msgId = convMsgs[i].id;
            msgEls[i].dataset.parentId = convMsgs[i].parent_id || "";
        }
    } catch (e) { /* ignore */ }
}

function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function tryParseJSON(str) {
    try { return JSON.parse(str); } catch { return str; }
}

function autoResizeInput() {
    const prevHeight = messageInput.offsetHeight;
    // Only remeasure from zero when content might have shrunk,
    // otherwise just check if we need to grow — avoids layout thrash
    // that jitters the scroll position on every keystroke.
    if (messageInput.scrollHeight > messageInput.clientHeight) {
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
    } else {
        messageInput.style.overflow = "hidden";
        messageInput.style.height = "0";
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
        messageInput.style.overflow = "";
    }
    // When height changes (new line added/removed), keep messages pinned to bottom
    if (messageInput.offsetHeight !== prevHeight && isNearBottom()) {
        scrollToBottom();
    }
}

// ---------------------------------------------------------------------------
// File management
// ---------------------------------------------------------------------------
async function loadFiles() {
    try {
        allFiles = await api("/files");
    } catch (e) {
        console.error("Failed to load files:", e);
        allFiles = [];
    }
}

async function loadAllTags() {
    try {
        allTags = await api("/files/tags");
    } catch (e) {
        allTags = [];
    }
}

async function uploadFiles(fileList, tagsStr) {
    for (const file of fileList) {
        const form = new FormData();
        form.append("file", file);
        form.append("tags", tagsStr);
        try {
            await fetch("/api/files/upload", { method: "POST", body: form });
        } catch (e) {
            console.error("Upload failed:", e);
        }
    }
    await loadFiles();
    await loadAllTags();
    renderFileList();
    populateFileFilterTag();
}

async function deleteFile(fileId) {
    await api(`/files/${fileId}`, { method: "DELETE" });
    await loadFiles();
    await loadAllTags();
    renderFileList();
    populateFileFilterTag();
}

async function updateFileTags(fileId, tags) {
    await api(`/files/${fileId}`, {
        method: "PATCH",
        body: JSON.stringify({ tags }),
    });
    await loadFiles();
    await loadAllTags();
    renderFileList();
    populateFileFilterTag();
}

// ---------------------------------------------------------------------------
// File modal
// ---------------------------------------------------------------------------
function openFileModal() {
    document.getElementById("file-modal").style.display = "flex";
    renderFileList();
    populateFileFilterTag();
}

function closeFileModal() {
    document.getElementById("file-modal").style.display = "none";
}

function populateFileFilterTag() {
    const select = document.getElementById("file-filter-tag");
    if (!select) return;
    const val = select.value;
    select.innerHTML = '<option value="">all</option>';
    for (const tag of allTags) {
        const opt = document.createElement("option");
        opt.value = tag;
        opt.textContent = tag;
        if (tag === val) opt.selected = true;
        select.appendChild(opt);
    }
}

function renderFileList(filterTag) {
    const listEl = document.getElementById("file-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    let files = allFiles;
    if (filterTag) {
        files = files.filter(f => f.tags && f.tags.includes(filterTag));
    }
    if (files.length === 0) {
        listEl.innerHTML = '<div style="color:#aaa;font-size:0.8rem;padding:0.5rem 0;">no files uploaded yet</div>';
        return;
    }
    for (const f of files) {
        const row = document.createElement("div");
        row.className = "file-row";
        row.dataset.fileId = f.id;

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = f.filename;
        name.onclick = () => previewFile(f.id, row);
        row.appendChild(name);

        const tokens = document.createElement("span");
        tokens.className = "file-tokens";
        tokens.textContent = formatTokens(f.token_count);
        row.appendChild(tokens);

        const tagsEl = document.createElement("span");
        tagsEl.className = "file-tags";
        for (const tag of (f.tags || [])) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag;
            chip.onclick = () => {
                document.getElementById("file-filter-tag").value = tag;
                renderFileList(tag);
            };
            tagsEl.appendChild(chip);
        }
        row.appendChild(tagsEl);

        const actions = document.createElement("span");
        actions.className = "file-actions";

        const retagBtn = document.createElement("button");
        retagBtn.textContent = "retag";
        retagBtn.onclick = () => startRetag(f, row);
        actions.appendChild(retagBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "delete-file-btn";
        delBtn.textContent = "\u00d7";
        delBtn.onclick = () => deleteFile(f.id);
        actions.appendChild(delBtn);

        row.appendChild(actions);
        listEl.appendChild(row);
    }
}

async function previewFile(fileId, row) {
    // Toggle existing preview
    const existing = row.querySelector(".file-preview-content");
    if (existing) { existing.remove(); return; }

    try {
        const data = await api(`/files/${fileId}/content`);
        const preview = document.createElement("div");
        preview.className = "file-preview-content";
        preview.textContent = (data.content || "").slice(0, 2000);
        if (data.content && data.content.length > 2000) {
            preview.textContent += "\n\n... (truncated)";
        }
        row.appendChild(preview);
    } catch (e) {
        console.error("Failed to preview file:", e);
    }
}

function startRetag(file, row) {
    // Remove any existing retag forms
    document.querySelectorAll(".retag-form").forEach(f => f.remove());

    const form = document.createElement("div");
    form.className = "retag-form";

    const input = document.createElement("input");
    input.type = "text";
    input.value = (file.tags || []).join(", ");
    input.placeholder = "tags (comma-separated)";
    form.appendChild(input);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "save";
    saveBtn.onclick = async () => {
        const newTags = input.value.split(",").map(t => t.trim()).filter(Boolean);
        await updateFileTags(file.id, newTags);
        form.remove();
    };
    form.appendChild(saveBtn);

    row.appendChild(form);
    input.focus();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            saveBtn.click();
        }
    });
}

function formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k tok";
    return n + " tok";
}

// ---------------------------------------------------------------------------
// Context bar
// ---------------------------------------------------------------------------
async function loadContext() {
    if (!currentConversationId) {
        activeContext = { files: [], total_tokens: 0 };
        renderContextBar();
        return;
    }
    try {
        activeContext = await api(`/conversations/${currentConversationId}/context`);
    } catch (e) {
        activeContext = { files: [], total_tokens: 0 };
    }
    renderContextBar();
}

function renderContextBar() {
    if (!contextBar) return;
    if (!activeContext.files || activeContext.files.length === 0) {
        contextBar.style.display = "none";
        return;
    }
    contextBar.style.display = "block";
    contextBarFiles.innerHTML = "";

    for (const f of activeContext.files) {
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
            await api(`/conversations/${currentConversationId}/context/${f.id}`, { method: "DELETE" });
            await loadContext();
        };
        item.appendChild(removeBtn);

        contextBarFiles.appendChild(item);
    }

    const totalTok = activeContext.total_tokens;
    contextTokenCount.textContent = formatTokens(totalTok);
    if (totalTok > 160000) {
        contextTokenCount.classList.add("warning");
    } else {
        contextTokenCount.classList.remove("warning");
    }
}

// ---------------------------------------------------------------------------
// Tag autocomplete
// ---------------------------------------------------------------------------
function handleTagAutocomplete() {
    const text = messageInput.value;
    const cursorPos = messageInput.selectionStart;
    // Find the word at cursor
    const before = text.slice(0, cursorPos);
    const match = before.match(/#([a-zA-Z0-9-]*)$/);

    if (!match) {
        hideTagAutocomplete();
        return;
    }

    const partial = match[1].toLowerCase();
    const filtered = allTags.filter(t => t.startsWith(partial) || t.includes(partial));

    if (filtered.length === 0) {
        hideTagAutocomplete();
        return;
    }

    tagAutocomplete.innerHTML = "";
    for (const tag of filtered.slice(0, 8)) {
        const item = document.createElement("div");
        item.className = "autocomplete-item";
        item.innerHTML = `<span class="tag-prefix">#</span>${escapeHtml(tag)}`;
        item.onmousedown = (e) => {
            e.preventDefault();
            // Replace the partial #tag with the full tag
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
// Event listeners
// ---------------------------------------------------------------------------
newChatBtn.onclick = quickCreateConversation;
sendBtn.onclick = sendMessage;
stopBtn.onclick = stopStreaming;

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
                renderImagePreviews();
            };
            reader.readAsDataURL(file);
            break;  // handle one image per paste
        }
    }
});

// Model change mid-conversation
modelSelect.onchange = async function () {
    if (!currentConversationId) return;
    const newModel = this.value;
    await api(`/conversations/${currentConversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ model: newModel }),
    });
    currentModel = newModel;
};

// Prompt change mid-conversation
promptSelect.onchange = async function () {
    if (!currentConversationId) return;
    const id = this.value;
    const body = id ? { prompt_id: id } : { clear_prompt: true };
    await api(`/conversations/${currentConversationId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
};

// Arrow key navigation for tree panel
document.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    // Only when a conversation is open (tree has nodes)
    if (treeNodes.length === 0) return;
    // Not when typing in an input
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    // Not while streaming
    if (isStreaming) return;

    e.preventDefault();
    const dirMap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    navigateTreeArrowKey(dirMap[e.key]);
});

// Focus textarea on printable character press
document.addEventListener("keydown", (e) => {
    // Only capture single printable characters without modifiers
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
    // Don't capture if another input/textarea is focused
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    // Don't capture if textarea is disabled or no conversation open
    if (messageInput.disabled || !currentConversationId) return;
    messageInput.focus({ preventScroll: true });
});

// Scroll sync for tree
messagesEl.addEventListener("scroll", syncTreeWithScroll);

// Tree search
treeSearch.addEventListener("input", filterTree);

// File modal
filesNavBtn.onclick = (e) => { e.preventDefault(); openFileModal(); };
document.getElementById("file-modal-close").onclick = closeFileModal;
document.getElementById("file-modal").onclick = (e) => {
    if (e.target.id === "file-modal") closeFileModal();
};
document.getElementById("file-upload-link").onclick = (e) => {
    e.preventDefault();
    document.getElementById("file-upload-input").click();
};
document.getElementById("file-upload-input").onchange = (e) => {
    const tagsStr = document.getElementById("file-upload-tags-input").value;
    uploadFiles(e.target.files, tagsStr);
    e.target.value = "";
};
// Drag and drop
const uploadArea = document.getElementById("file-upload-area");
uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); };
uploadArea.ondragleave = () => uploadArea.classList.remove("dragover");
uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    const tagsStr = document.getElementById("file-upload-tags-input").value;
    uploadFiles(e.dataTransfer.files, tagsStr);
};
// File filter
document.getElementById("file-filter-tag").onchange = function() {
    renderFileList(this.value || undefined);
};

// Hide autocomplete on blur
messageInput.addEventListener("blur", () => {
    setTimeout(hideTagAutocomplete, 150);
});

// ---------------------------------------------------------------------------
// Moodboard
// ---------------------------------------------------------------------------
async function loadBoard() {
    try {
        boardPins = await api("/pins");
        renderBoard();
    } catch (e) {
        console.error("Failed to load board:", e);
    }
}

function renderBoard() {
    boardPinsEl.innerHTML = "";
    for (const pin of boardPins) {
        boardPinsEl.appendChild(createPinEl(pin));
    }
}

function createPinEl(pin) {
    const el = document.createElement("div");
    el.className = "board-pin";
    el.dataset.pinId = pin.id;

    // Delete button
    const del = document.createElement("button");
    del.className = "pin-delete";
    del.textContent = "\u00d7";
    del.onclick = async (e) => {
        e.stopPropagation();
        await api(`/pins/${pin.id}`, { method: "DELETE" });
        el.remove();
        boardPins = boardPins.filter(p => p.id !== pin.id);
    };
    el.appendChild(del);

    // Content based on type
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
        // text or message
        const txt = document.createElement("div");
        txt.className = "pin-text";
        txt.textContent = pin.content;
        el.appendChild(txt);
    }

    // Note
    if (pin.note) {
        const note = document.createElement("div");
        note.className = "pin-note";
        note.textContent = pin.note;
        el.appendChild(note);
    }

    // Meta line: source + timestamp
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

async function createPin(type, content, opts = {}) {
    const pin = await api("/pins", {
        method: "POST",
        body: JSON.stringify({
            type,
            content,
            source: opts.source || "sylvia",
            note: opts.note || null,
            conversation_id: opts.conversation_id || null,
            message_id: opts.message_id || null,
        }),
    });
    boardPins.unshift(pin);
    boardPinsEl.prepend(createPinEl(pin));
}

// Pin message from chat
function pinMessage(msgEl) {
    const textEl = msgEl.querySelector(".message-text");
    const text = textEl?.innerText || textEl?.textContent || "";
    if (!text.trim()) return;
    createPin("message", text.trim(), {
        conversation_id: currentConversationId,
        message_id: msgEl.dataset.msgId,
    });
}

// Copy assistant message text
function copyMessageText(msgEl) {
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

// Regenerate: resubmit the same user message to create a new branch
function regenerateResponse(assistantMsgEl) {
    if (isStreaming || !ws || !currentConversationId) return;
    // The assistant message's parent is the user message that triggered it
    const parentId = assistantMsgEl.dataset.parentId;
    if (!parentId) return;
    // Find the user message element with that msgId
    const userMsgEl = messagesEl.querySelector(`.message[data-msg-id="${parentId}"]`);
    if (!userMsgEl) return;
    const rawText = userMsgEl.dataset.rawText;
    if (!rawText) return;
    // The user message's parentId is where the edit branches from
    const branchParentId = userMsgEl.dataset.parentId || null;
    // Send as an edit from the same branch point with the same content
    const payload = {
        action: "edit",
        parent_id: branchParentId,
        message: rawText,
    };
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }
    // Set up streaming UI
    isStreaming = true;
    sendBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
    messageInput.disabled = true;
    // Add spacer + streaming elements
    const spacer1 = document.createElement("div");
    spacer1.className = "message-spacer";
    messagesEl.appendChild(spacer1);
    streamingEl = createMessageEl("user", undefined, null, branchParentId);
    streamingEl.querySelector(".message-text").textContent = rawText;
    streamingEl.dataset.rawText = rawText;
    messagesEl.appendChild(streamingEl);
    const spacer2 = document.createElement("div");
    spacer2.className = "message-spacer";
    messagesEl.appendChild(spacer2);
    streamingEl = createMessageEl("assistant", undefined, null, null);
    streamingTextEl = streamingEl.querySelector(".message-text");
    messagesEl.appendChild(streamingEl);
    streamingRawText = "";
    scrollToBottom();
    ws.send(JSON.stringify(payload));
}

// Board text input
document.getElementById("board-input-btn").onclick = () => {
    const val = boardInput.value.trim();
    if (!val) return;
    // Auto-detect links
    const type = /^https?:\/\/\S+$/.test(val) ? "link" : "text";
    createPin(type, val);
    boardInput.value = "";
};
boardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.getElementById("board-input-btn").click();
    }
});

// Board drag and drop — images and text
boardPanel.addEventListener("dragover", (e) => {
    e.preventDefault();
    boardPanel.classList.add("dragover");
});
boardPanel.addEventListener("dragleave", (e) => {
    if (!boardPanel.contains(e.relatedTarget)) {
        boardPanel.classList.remove("dragover");
    }
});
boardPanel.addEventListener("drop", async (e) => {
    e.preventDefault();
    boardPanel.classList.remove("dragover");

    // Handle files (images)
    if (e.dataTransfer.files.length > 0) {
        for (const file of e.dataTransfer.files) {
            if (!file.type.startsWith("image/")) continue;
            const reader = new FileReader();
            reader.onload = () => {
                createPin("image", reader.result);
            };
            reader.readAsDataURL(file);
        }
        return;
    }

    // Handle dragged text
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
        const type = /^https?:\/\/\S+$/.test(text) ? "link" : "text";
        createPin(type, text);
    }
});

// Board paste — images and text
boardPanel.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const file = item.getAsFile();
            const reader = new FileReader();
            reader.onload = () => {
                createPin("image", reader.result);
            };
            reader.readAsDataURL(file);
            return;
        }
    }

    // If paste happened while board input is focused, let it handle normally
    if (document.activeElement === boardInput) return;

    // Otherwise paste as text pin
    const text = e.clipboardData.getData("text/plain");
    if (text) {
        e.preventDefault();
        const type = /^https?:\/\/\S+$/.test(text.trim()) ? "link" : "text";
        createPin(type, text.trim());
    }
});

// Make board panel focusable for paste events
boardPanel.setAttribute("tabindex", "-1");

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
marked.setOptions({ breaks: true, gfm: true });
loadModels();
loadPrompts();
loadFiles();
loadAllTags();
loadBoard();
loadConversations().then(() => {
    // Auto-open conversation from URL parameter (e.g. brain dump redirect)
    const openId = new URLSearchParams(window.location.search).get("c");
    if (openId) {
        history.replaceState(null, "", "/");  // clean up URL
        openConversation(openId);
    }
});
