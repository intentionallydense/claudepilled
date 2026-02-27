/**
 * Briefing page — fetch and render daily briefings, manage reading progress,
 * and embedded chat panel with full tree navigation and edit support.
 */

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let currentDate = new Date().toISOString().slice(0, 10);

// Chat state
let chatConversationId = null;
let chatWs = null;
let chatIsStreaming = false;
let chatIsEditing = false;
let chatStreamingEl = null;
let chatStreamingTextEl = null;
let chatStreamingThinkingEl = null;
let chatStreamingToolCalls = {};
let chatStreamingSearchEl = null;
let chatTreeData = null;
let chatTreeNodes = [];
let chatTreeChildrenMap = {};  // parent_id → [child_id, ...] (visible nodes only)
let chatTreeParentMap = {};    // child_id → parent_id (visible parent)
let chatCurrentHighlight = null;
let chatArrowNavActive = false; // suppresses scroll↔tree sync during keyboard nav
let chatArrowNavTimer = null;
let chatPendingImages = [];

// Markdown streaming state
let chatStreamingRawText = "";
let chatMarkdownRenderTimer = null;
const CHAT_MARKDOWN_DEBOUNCE_MS = 80;
let chatToolResultsSinceLastText = false;

// ------------------------------------------------------------------
// API helpers
// ------------------------------------------------------------------
async function api(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return { status: res.status, data: await res.json() };
}

async function apiGet(path) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
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
        hideChat();
        return;
    }

    content.innerHTML = renderMarkdown(data.assembled_text || "");
    content.style.display = "block";
    initChat(dateStr);
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

        if (!trimmed) {
            if (inList) { html += "</ul>"; inList = false; }
            continue;
        }

        if (trimmed.startsWith("## ")) {
            if (inList) { html += "</ul>"; inList = false; }
            html += `<h2>${esc(trimmed.slice(3))}</h2>`;
            continue;
        }

        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatInline(trimmed.slice(2))}</li>`;
            continue;
        }

        const numMatch = trimmed.match(/^\d+\.\s+(.*)/);
        if (numMatch) {
            if (!inList) { html += "<ul>"; inList = true; }
            html += `<li>${formatInline(numMatch[1])}</li>`;
            continue;
        }

        if (inList) { html += "</ul>"; inList = false; }
        html += `<p>${formatInline(trimmed)}</p>`;
    }

    if (inList) html += "</ul>";
    return html;
}

function formatInline(text) {
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    return text;
}

function esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
}

function tryParseJSON(str) {
    try { return JSON.parse(str); } catch { return str; }
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
            currentDate = new Date().toISOString().slice(0, 10);
            updateDateDisplay();
            initChat(currentDate);
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
// Chat panel — show / hide
// ------------------------------------------------------------------

function hideChat() {
    document.getElementById("briefing-page").classList.add("no-chat");
    document.getElementById("chat-panel").style.display = "none";
    if (chatWs) { chatWs.close(); chatWs = null; }
    chatConversationId = null;
    chatTreeData = null;
    chatTreeNodes = [];
    chatTreeChildrenMap = {};
    chatTreeParentMap = {};
}

function showChat() {
    document.getElementById("briefing-page").classList.remove("no-chat");
    document.getElementById("chat-panel").style.display = "flex";
}

// ------------------------------------------------------------------
// Chat panel — init and conversation loading
// ------------------------------------------------------------------

async function initChat(dateStr) {
    if (chatWs) { chatWs.close(); chatWs = null; }
    chatConversationId = null;

    const { status, data } = await api("POST", `/api/briefing/${dateStr}/chat`);
    if (status !== 200) {
        hideChat();
        return;
    }

    chatConversationId = data.conversation_id;
    showChat();
    await chatLoadConversation(chatConversationId);
    connectChatWebSocket(chatConversationId);
}

async function chatLoadConversation(conversationId) {
    const messagesEl = document.getElementById("chat-messages");
    messagesEl.innerHTML = "";

    try {
        const conv = await apiGet(`/api/conversations/${conversationId}`);

        chatUpdateCostDisplay(
            conv.total_input_tokens || 0,
            conv.total_output_tokens || 0,
            conv.total_cost || 0,
        );

        let renderedCount = 0;
        let lastAssistantEl = null;
        for (let i = 0; i < conv.messages.length; i++) {
            const msg = conv.messages[i];
            const content = msg.content;
            if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
                continue;
            }
            // Merge consecutive assistant messages (from tool use loops)
            if (msg.role === "assistant" && lastAssistantEl) {
                chatAppendAssistantContent(lastAssistantEl, content);
                continue;
            }
            if (renderedCount > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                messagesEl.appendChild(spacer);
            }
            const el = chatRenderMessage(msg.role, content, i, msg.id, msg.parent_id);
            lastAssistantEl = (msg.role === "assistant") ? el : null;
            renderedCount++;
        }
        chatScrollToBottom();
        await chatLoadTree();
    } catch (e) {
        console.error("Failed to load chat conversation:", e);
    }
}

// ------------------------------------------------------------------
// Chat panel — WebSocket
// ------------------------------------------------------------------

function connectChatWebSocket(conversationId) {
    if (chatWs) { chatWs.close(); chatWs = null; }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    chatWs = new WebSocket(`${proto}//${location.host}/api/chat/${conversationId}`);
    chatWs.onclose = () => { chatWs = null; };
    chatWs.onerror = () => { chatWs = null; };
    chatWs.onmessage = (event) => {
        handleChatStreamEvent(JSON.parse(event.data));
    };
}

// ------------------------------------------------------------------
// Chat panel — stream event handling
// ------------------------------------------------------------------

function handleChatStreamEvent(event) {
    const inputEl = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");

    switch (event.type) {
        case "thinking_delta":
            if (!chatStreamingEl) chatStartStreamingMessage();
            if (!chatStreamingThinkingEl) {
                chatStreamingThinkingEl = chatCreateThinkingBlock(chatStreamingEl);
            }
            const tc = chatStreamingThinkingEl.querySelector(".thinking-content");
            tc.textContent += event.thinking;
            tc.classList.add("streaming-cursor");
            chatMaybeScrollToBottom();
            break;

        case "thinking_done":
            if (chatStreamingThinkingEl) {
                const thinkContent = chatStreamingThinkingEl.querySelector(".thinking-content");
                thinkContent.classList.remove("streaming-cursor");
                const label = chatStreamingThinkingEl.querySelector(".thinking-label");
                if (label) label.textContent = "thought process";
            }
            chatStreamingThinkingEl = null;
            break;

        case "web_search_start":
            if (!chatStreamingEl) chatStartStreamingMessage();
            chatStreamingSearchEl = document.createElement("div");
            chatStreamingSearchEl.className = "web-search-indicator";
            chatStreamingSearchEl.textContent = "searching the web...";
            const textElBefore = chatStreamingEl.querySelector(".message-text");
            chatStreamingEl.insertBefore(chatStreamingSearchEl, textElBefore);
            chatMaybeScrollToBottom();
            break;

        case "web_search_result":
            if (chatStreamingSearchEl) {
                chatStreamingSearchEl.textContent = "web search complete";
                setTimeout(() => {
                    if (chatStreamingSearchEl) {
                        chatStreamingSearchEl.remove();
                        chatStreamingSearchEl = null;
                    }
                }, 1500);
            }
            break;

        case "text_delta":
            if (!chatStreamingEl) chatStartStreamingMessage();
            // After tool results, create a new text element below the tool blocks
            if (chatToolResultsSinceLastText) {
                chatStreamingTextEl = document.createElement("div");
                chatStreamingTextEl.className = "message-text";
                chatStreamingEl.appendChild(chatStreamingTextEl);
                chatStreamingRawText = "";
                chatToolResultsSinceLastText = false;
            }
            chatStreamingRawText += event.text;
            chatScheduleMarkdownRender();
            chatMaybeScrollToBottom();
            break;

        case "tool_use_start":
            if (!chatStreamingEl) chatStartStreamingMessage();
            chatStreamingToolCalls[event.tool_use_id] = {
                name: event.tool_name,
                inputParts: [],
                input: null,
                result: null,
            };
            break;

        case "tool_use_delta":
            if (event.tool_use_id && chatStreamingToolCalls[event.tool_use_id]) {
                const toolCall = chatStreamingToolCalls[event.tool_use_id];
                if (typeof event.tool_input === "object") {
                    toolCall.input = event.tool_input;
                } else if (typeof event.tool_input === "string") {
                    toolCall.inputParts.push(event.tool_input);
                }
            }
            break;

        case "tool_result":
            chatToolResultsSinceLastText = true;
            if (event.tool_use_id && chatStreamingToolCalls[event.tool_use_id]) {
                chatStreamingToolCalls[event.tool_use_id].result = event.tool_result;
                chatRenderToolCallBlock(chatStreamingEl, chatStreamingToolCalls[event.tool_use_id]);
                chatMaybeScrollToBottom();
            }
            break;

        case "usage":
            break;

        case "title_update":
            break;

        case "message_done":
            // Final markdown render
            if (chatMarkdownRenderTimer) clearTimeout(chatMarkdownRenderTimer);
            if (chatStreamingTextEl && chatStreamingRawText) {
                chatStreamingTextEl.innerHTML = chatRenderMarkdown(chatStreamingRawText);
                chatRemoveStreamingCursor(chatStreamingTextEl);
            }
            chatStreamingRawText = "";
            chatMarkdownRenderTimer = null;
            if (chatStreamingSearchEl) {
                chatStreamingSearchEl.remove();
                chatStreamingSearchEl = null;
            }
            for (const [id, toolCall] of Object.entries(chatStreamingToolCalls)) {
                if (!toolCall.result) {
                    chatRenderToolCallBlock(chatStreamingEl, toolCall);
                }
            }

            const wasEdit = chatIsEditing;
            chatStreamingEl = null;
            chatStreamingTextEl = null;
            chatStreamingThinkingEl = null;
            chatStreamingToolCalls = {};
            chatToolResultsSinceLastText = false;
            chatIsStreaming = false;
            chatIsEditing = false;
            inputEl.disabled = false;
            sendBtn.disabled = false;

            if (wasEdit) {
                chatLoadConversation(chatConversationId);
            } else {
                inputEl.focus();
                chatFetchAndUpdateCost();
                chatScrollToBottom();
                chatLoadTree();
            }
            break;

        case "error":
            if (!chatStreamingEl) chatStartStreamingMessage();
            const isRetry = event.error && event.error.includes("retrying");
            const errEl = document.createElement("div");
            errEl.style.color = isRetry ? "#e8a838" : "#c00";
            errEl.style.fontSize = "0.8rem";
            errEl.textContent = isRetry ? event.error : `error: ${event.error}`;
            chatStreamingEl.appendChild(errEl);
            if (!isRetry) {
                chatIsStreaming = false;
                inputEl.disabled = false;
                sendBtn.disabled = false;
            }
            chatMaybeScrollToBottom();
            break;
    }
}

function chatStartStreamingMessage() {
    const messagesEl = document.getElementById("chat-messages");
    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }
    chatStreamingEl = chatCreateMessageEl("assistant");
    chatStreamingTextEl = chatStreamingEl.querySelector(".message-text");
    messagesEl.appendChild(chatStreamingEl);
}

// ------------------------------------------------------------------
// Chat panel — message rendering
// ------------------------------------------------------------------

function chatCreateMessageEl(role, index, msgId, parentId) {
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

    if (role === "user") {
        const actions = document.createElement("div");
        actions.className = "message-actions";
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.textContent = "edit";
        editBtn.onclick = () => chatStartEdit(div);
        actions.appendChild(editBtn);
        div.appendChild(actions);
    }

    return div;
}

function chatRenderMessage(role, content, index, msgId, parentId) {
    if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
        return;
    }

    const el = chatCreateMessageEl(role, index, msgId, parentId);
    const textEl = el.querySelector(".message-text");

    if (typeof content === "string") {
        if (role === "assistant") {
            textEl.innerHTML = chatRenderMarkdown(content);
        } else {
            textEl.textContent = content;
            el.dataset.rawText = content;
        }
    } else if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
                const thinkingBlock = chatCreateThinkingBlock(el);
                thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                thinkingBlock.querySelector(".thinking-body").classList.remove("open");
            } else if (block.type === "text" && block.text) {
                textParts.push(block.text);
            } else if (block.type === "tool_use") {
                chatRenderToolCallBlock(el, {
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
                textEl.innerHTML = chatRenderMarkdown(fullText);
            } else {
                const textNode = document.createTextNode(fullText);
                textEl.insertBefore(textNode, textEl.firstChild);
                el.dataset.rawText = fullText;
            }
        }
    }

    document.getElementById("chat-messages").appendChild(el);
    return el;
}

// Append content from a continuation assistant message (after tool use loop)
// into an existing assistant message element
function chatAppendAssistantContent(el, content) {
    if (!Array.isArray(content)) return;
    const textParts = [];
    for (const block of content) {
        if (block.type === "thinking" && block.thinking) {
            const thinkingBlock = chatCreateThinkingBlock(el);
            thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
            thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
            thinkingBlock.querySelector(".thinking-header").classList.remove("open");
            thinkingBlock.querySelector(".thinking-body").classList.remove("open");
        } else if (block.type === "text" && block.text) {
            textParts.push(block.text);
        } else if (block.type === "tool_use") {
            chatRenderToolCallBlock(el, {
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
        newTextEl.innerHTML = chatRenderMarkdown(textParts.join(""));
        el.appendChild(newTextEl);
    }
}

function chatCreateThinkingBlock(parentEl) {
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

function chatRenderToolCallBlock(parentEl, toolCall) {
    const container = document.createElement("div");
    container.className = "tool-call";

    const header = document.createElement("div");
    header.className = "tool-call-header";
    header.innerHTML = `<span class="arrow">&#9654;</span> tool: <strong>${esc(toolCall.name)}</strong>`;
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

// ------------------------------------------------------------------
// Chat panel — edit messages
// ------------------------------------------------------------------

function chatStartEdit(msgEl) {
    if (chatIsStreaming) return;

    document.querySelectorAll("#chat-panel .edit-form").forEach(f => f.remove());

    const textEl = msgEl.querySelector(".message-text");
    const currentText = msgEl.dataset.rawText || textEl.textContent;
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

    const sendEditBtn = document.createElement("button");
    sendEditBtn.className = "edit-send";
    sendEditBtn.textContent = "send edit";
    sendEditBtn.onclick = () => chatSubmitEdit(parentId, textarea.value.trim(), form);
    actions.appendChild(sendEditBtn);

    form.appendChild(actions);
    msgEl.appendChild(form);

    textarea.focus();
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            chatSubmitEdit(parentId, textarea.value.trim(), form);
        }
    });
}

function chatSubmitEdit(parentId, newText, formEl) {
    if (!newText || !chatWs || !chatConversationId || chatIsStreaming) return;

    // Remove the edited message and everything after it
    const editedMsg = formEl.closest(".message");
    formEl.remove();
    if (editedMsg) {
        while (editedMsg.nextSibling) editedMsg.nextSibling.remove();
        editedMsg.remove();
    }

    chatIsStreaming = true;
    chatIsEditing = true;
    document.getElementById("chat-input").disabled = true;
    document.getElementById("chat-send").disabled = true;

    // Show the user's edited text
    const messagesEl = document.getElementById("chat-messages");
    const userEl = chatCreateMessageEl("user");
    userEl.querySelector(".message-text").textContent = newText;
    userEl.dataset.rawText = newText;
    messagesEl.appendChild(userEl);
    chatScrollToBottom();

    const payload = {
        action: "edit",
        parent_id: parentId,
        message: newText,
    };
    const thinkingCb = document.getElementById("chat-thinking-checkbox");
    if (thinkingCb && thinkingCb.checked) {
        payload.thinking_budget = 10000;
    }

    chatWs.send(JSON.stringify(payload));
}

// ------------------------------------------------------------------
// Chat panel — send message
// ------------------------------------------------------------------

function sendChatMessage() {
    const inputEl = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");
    const messagesEl = document.getElementById("chat-messages");
    const text = inputEl.value.trim();
    const hasImages = chatPendingImages.length > 0;
    if ((!text && !hasImages) || chatIsStreaming || !chatWs || !chatConversationId) return;

    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }

    const userEl = chatCreateMessageEl("user");
    const textEl = userEl.querySelector(".message-text");
    if (text) textEl.textContent = text;
    for (const img of chatPendingImages) {
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        imgEl.className = "message-image";
        textEl.appendChild(imgEl);
    }
    messagesEl.appendChild(userEl);
    chatScrollToBottom();

    // Build payload — use block list if images are present
    let messagePayload;
    if (hasImages) {
        const blocks = [];
        if (text) blocks.push({ type: "text", text: text });
        blocks.push(...chatPendingImages);
        messagePayload = blocks;
    } else {
        messagePayload = text;
    }

    const payload = { message: messagePayload };
    const thinkingCb = document.getElementById("chat-thinking-checkbox");
    if (thinkingCb && thinkingCb.checked) {
        payload.thinking_budget = 10000;
    }

    chatWs.send(JSON.stringify(payload));
    inputEl.value = "";
    clearBriefingImagePreviews();
    chatAutoResizeInput();
    chatIsStreaming = true;
    sendBtn.disabled = true;
    inputEl.disabled = true;
}

// ------------------------------------------------------------------
// Chat panel — cost display
// ------------------------------------------------------------------

function chatUpdateCostDisplay(inputTokens, outputTokens, cost) {
    const el = document.getElementById("chat-cost-display");
    if (!el) return;
    const totalTokens = inputTokens + outputTokens;
    let tokenStr;
    if (totalTokens >= 1_000_000) {
        tokenStr = (totalTokens / 1_000_000).toFixed(1) + "M";
    } else if (totalTokens >= 1000) {
        tokenStr = (totalTokens / 1000).toFixed(1) + "k";
    } else {
        tokenStr = String(totalTokens);
    }
    el.textContent = `${tokenStr} tok | $${(cost || 0).toFixed(4)}`;
    el.title = `in: ${inputTokens} | out: ${outputTokens} | $${(cost || 0).toFixed(6)}`;
}

async function chatFetchAndUpdateCost() {
    if (!chatConversationId) return;
    try {
        const data = await apiGet(`/api/conversations/${chatConversationId}/cost`);
        chatUpdateCostDisplay(data.input_tokens, data.output_tokens, data.cost);
    } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------
// Chat panel — tree navigator
// ------------------------------------------------------------------

async function chatLoadTree() {
    if (!chatConversationId) return;
    try {
        chatTreeData = await apiGet(`/api/conversations/${chatConversationId}/tree`);
        chatBuildTree();
    } catch (e) {
        console.error("Failed to load chat tree:", e);
    }
}

function chatBuildTree() {
    const nodeMap = document.getElementById("chat-node-map");
    nodeMap.innerHTML = "";
    chatTreeNodes = [];
    if (!chatTreeData || !chatTreeData.nodes || chatTreeData.nodes.length === 0) return;

    const nodes = chatTreeData.nodes;
    const currentPath = new Set(chatTreeData.current_path || []);

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
        if (!skippedIds.has(n.parent_id)) continue;
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
    chatTreeChildrenMap = childrenMap;
    chatTreeParentMap = {};
    for (const n of nodes) {
        if (skippedIds.has(n.id)) continue;
        let pid = n.parent_id;
        while (pid && skippedIds.has(pid)) {
            pid = parentOf[pid];
        }
        if (pid) chatTreeParentMap[n.id] = pid;
    }

    // Layout: DFS with column assignment.
    // Branches grow both left and right — 1st child continues straight,
    // subsequent siblings alternate right then left of the current extent.
    const layout = [];
    let maxCol = 0;
    let minCol = 0;

    function dfs(nodeId, depth, column, effectiveParent) {
        const node = nodeById[nodeId];
        if (!node) return;
        layout.push({
            ...node,
            col: column,
            depth: depth,
            onPath: currentPath.has(nodeId),
            drawParent: effectiveParent,
        });
        if (column > maxCol) maxCol = column;
        if (column < minCol) minCol = column;

        const kids = childrenMap[nodeId] || [];
        for (let i = 0; i < kids.length; i++) {
            if (i === 0) {
                dfs(kids[i], depth + 1, column, nodeId);
            } else if (i % 2 === 1) {
                dfs(kids[i], depth + 1, maxCol + 1, nodeId);
            } else {
                dfs(kids[i], depth + 1, minCol - 1, nodeId);
            }
        }
    }

    dfs(rootId, 0, 0, null);

    const layerGap = 24;
    const colGap = 18;
    const startY = 12;
    const baseX = 24;
    const nodeRadius = { user: 5, assistant: 3 };

    const maxDepth = Math.max(...layout.map(n => n.depth));
    const totalHeight = startY + (maxDepth + 1) * layerGap + 16;
    const totalWidth = baseX + (maxCol - minCol + 1) * colGap + 24;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", Math.max(totalWidth, 100));
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

    // Position map — Y from depth, X from column (offset by minCol)
    const posMap = {};
    layout.forEach((item) => {
        const x = baseX + (item.col - minCol) * colGap;
        const y = startY + item.depth * layerGap;
        posMap[item.id] = { x, y };
    });

    // Draw connections (using drawParent — the visible parent after skipping)
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
    const svgWidth = Math.max(totalWidth, 100);
    for (let d = 10; d <= maxDepth; d += 10) {
        const y = startY + d * layerGap;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", 0);
        line.setAttribute("y1", y);
        line.setAttribute("x2", svgWidth);
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
    const lastOnPath = chatTreeData.current_path?.[chatTreeData.current_path.length - 1];

    layout.forEach((item, i) => {
        const pos = posMap[item.id];
        const r = nodeRadius[item.role] || 4;

        const node = document.createElement("div");
        node.className = `tree-node ${item.role}-node`;
        if (item.onPath) node.classList.add("on-path");
        if (item.id === lastOnPath) node.classList.add("current-node");

        node.style.left = (pos.x - r) + "px";
        node.style.top = (pos.y - r) + "px";
        node.onclick = () => chatNavigateToNode(item.id);

        nodeMap.appendChild(node);
        chatTreeNodes.push({
            id: item.id, index: i, role: item.role,
            preview: item.preview, x: pos.x, y: pos.y,
            depth: item.depth, el: node, onPath: item.onPath,
        });
    });
}

async function chatNavigateToNode(nodeId) {
    if (chatIsStreaming || !chatConversationId) return;

    // If on current path, just scroll to it
    if (chatTreeData && chatTreeData.current_path && chatTreeData.current_path.includes(nodeId)) {
        const msgEl = document.getElementById("chat-messages").querySelector(`.message[data-msg-id="${nodeId}"]`);
        if (msgEl) {
            msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
    }

    // Switch branch
    try {
        const { data: conv } = await api("POST", `/api/conversations/${chatConversationId}/switch/${nodeId}`);

        const messagesEl = document.getElementById("chat-messages");
        messagesEl.innerHTML = "";
        let rendered = 0;
        for (let i = 0; i < conv.messages.length; i++) {
            const msg = conv.messages[i];
            const c = msg.content;
            if (Array.isArray(c) && c.every(b => b.type === "tool_result")) continue;
            if (rendered > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                messagesEl.appendChild(spacer);
            }
            chatRenderMessage(msg.role, c, i, msg.id, msg.parent_id);
            rendered++;
        }
        chatScrollToBottom();
        await chatLoadTree();
    } catch (e) {
        console.error("Failed to switch branch:", e);
    }
}

function chatHighlightTreeNode(index) {
    if (chatCurrentHighlight !== null && chatTreeNodes[chatCurrentHighlight]) {
        chatTreeNodes[chatCurrentHighlight].el.classList.remove("scroll-highlight");
    }
    if (chatTreeNodes[index]) {
        chatTreeNodes[index].el.classList.add("scroll-highlight");
        chatCurrentHighlight = index;
    }
}

// Suppressed during arrow-key navigation to avoid fighting the highlight.
function chatSyncTreeWithScroll() {
    if (chatArrowNavActive) return;
    const messagesEl = document.getElementById("chat-messages");
    const msgEls = messagesEl.querySelectorAll(".message");
    if (msgEls.length === 0 || chatTreeNodes.length === 0) return;

    const containerRect = messagesEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    let closestIdx = 0;
    let closestDist = Infinity;

    const onPathNodes = chatTreeNodes.filter(tn => tn.onPath);
    msgEls.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top + rect.height / 2 - centerY);
        if (dist < closestDist && i < onPathNodes.length) {
            closestDist = dist;
            closestIdx = chatTreeNodes.indexOf(onPathNodes[i]);
        }
    });

    if (closestIdx >= 0) chatHighlightTreeNode(closestIdx);
}

// Arrow key navigation for the briefing tree panel.
// Up/Down walk on-path nodes and scroll the message into view.
// Left/Right jump between nodes at the same tree depth (same layer),
// sorted by x position. If the target is off-path, triggers a branch switch.
function chatNavigateTreeArrowKey(direction) {
    if (chatTreeNodes.length === 0) return;

    const onPathNodes = chatTreeNodes.filter(tn => tn.onPath);
    if (onPathNodes.length === 0) return;

    // Suppress scroll↔tree sync so the smooth scroll doesn't fight our highlight
    chatArrowNavActive = true;
    clearTimeout(chatArrowNavTimer);
    chatArrowNavTimer = setTimeout(() => { chatArrowNavActive = false; }, 600);

    if (direction === "up" || direction === "down") {
        let curOnPathIdx = -1;
        if (chatCurrentHighlight !== null) {
            const highlighted = chatTreeNodes[chatCurrentHighlight];
            if (highlighted && highlighted.onPath) {
                curOnPathIdx = onPathNodes.indexOf(highlighted);
            }
        }
        if (curOnPathIdx < 0) curOnPathIdx = onPathNodes.length - 1;

        let nextIdx;
        if (direction === "up") {
            nextIdx = curOnPathIdx > 0 ? curOnPathIdx - 1 : 0;
        } else {
            nextIdx = curOnPathIdx < onPathNodes.length - 1 ? curOnPathIdx + 1 : onPathNodes.length - 1;
        }

        const target = onPathNodes[nextIdx];
        chatHighlightTreeNode(chatTreeNodes.indexOf(target));

        const msgEl = document.getElementById("chat-messages").querySelector(`.message[data-msg-id="${target.id}"]`);
        if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });

    } else if (direction === "left" || direction === "right") {
        let current = null;
        if (chatCurrentHighlight !== null && chatTreeNodes[chatCurrentHighlight]) {
            current = chatTreeNodes[chatCurrentHighlight];
        }
        if (!current && onPathNodes.length > 0) {
            current = onPathNodes[onPathNodes.length - 1];
        }
        if (!current) return;

        const sameLayer = chatTreeNodes
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
        chatHighlightTreeNode(chatTreeNodes.indexOf(target));

        if (!target.onPath) {
            chatNavigateToNode(target.id);
        } else {
            const msgEl = document.getElementById("chat-messages").querySelector(`.message[data-msg-id="${target.id}"]`);
            if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
}

// ------------------------------------------------------------------
// Chat panel — image preview management
// ------------------------------------------------------------------

function renderBriefingImagePreviews() {
    const inputEl = document.getElementById("chat-input");
    let area = document.getElementById("briefing-image-preview-area");
    if (!area) {
        area = document.createElement("div");
        area.id = "briefing-image-preview-area";
        area.className = "image-preview-area";
        const wrapper = inputEl.closest(".chat-input-wrapper");
        wrapper.insertBefore(area, inputEl);
    }
    area.innerHTML = "";
    if (chatPendingImages.length === 0) {
        area.style.display = "none";
        return;
    }
    area.style.display = "flex";
    chatPendingImages.forEach((img, i) => {
        const preview = document.createElement("div");
        preview.className = "image-preview";
        const imgEl = document.createElement("img");
        imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
        preview.appendChild(imgEl);
        const removeBtn = document.createElement("button");
        removeBtn.className = "remove-btn";
        removeBtn.textContent = "\u00d7";
        removeBtn.onclick = () => {
            chatPendingImages.splice(i, 1);
            renderBriefingImagePreviews();
        };
        preview.appendChild(removeBtn);
        area.appendChild(preview);
    });
}

function clearBriefingImagePreviews() {
    chatPendingImages = [];
    const area = document.getElementById("briefing-image-preview-area");
    if (area) {
        area.innerHTML = "";
        area.style.display = "none";
    }
}

// ------------------------------------------------------------------
// Chat panel — utilities
// ------------------------------------------------------------------

function chatScrollToBottom() {
    const el = document.getElementById("chat-messages");
    el.scrollTop = el.scrollHeight;
}

function chatIsNearBottom(threshold = 150) {
    const el = document.getElementById("chat-messages");
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function chatMaybeScrollToBottom() {
    if (chatIsNearBottom()) chatScrollToBottom();
}

function chatAutoResizeInput() {
    const el = document.getElementById("chat-input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
}

// ------------------------------------------------------------------
// Chat panel — markdown rendering
// ------------------------------------------------------------------

function chatRenderMarkdown(text) {
    if (!text) return "";
    // Close any open code fences so partial streaming doesn't break layout
    let processed = text;
    const fenceCount = (processed.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) {
        processed += "\n```";
    }
    return DOMPurify.sanitize(marked.parse(processed));
}

function chatAppendStreamingCursor(el) {
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

function chatRemoveStreamingCursor(el) {
    const cursor = el.querySelector(".streaming-cursor-char");
    if (cursor) cursor.remove();
}

function chatScheduleMarkdownRender() {
    if (chatMarkdownRenderTimer) clearTimeout(chatMarkdownRenderTimer);
    chatMarkdownRenderTimer = setTimeout(() => {
        if (chatStreamingTextEl && chatStreamingRawText) {
            chatStreamingTextEl.innerHTML = chatRenderMarkdown(chatStreamingRawText);
            chatAppendStreamingCursor(chatStreamingTextEl);
        }
    }, CHAT_MARKDOWN_DEBOUNCE_MS);
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("prev-date").addEventListener("click", () => handleDateNav(-1));
    document.getElementById("next-date").addEventListener("click", () => handleDateNav(1));
    document.getElementById("assemble-btn").addEventListener("click", handleAssemble);
    document.getElementById("chat-send").addEventListener("click", sendChatMessage);

    const chatInput = document.getElementById("chat-input");
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    chatInput.addEventListener("input", chatAutoResizeInput);
    chatInput.addEventListener("paste", (e) => {
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
                    chatPendingImages.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
                    renderBriefingImagePreviews();
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });

    document.getElementById("chat-messages").addEventListener("scroll", chatSyncTreeWithScroll);

    // Arrow key navigation for tree panel
    document.addEventListener("keydown", (e) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        // Only when chat panel is visible
        const chatPanel = document.getElementById("chat-panel");
        if (!chatPanel || chatPanel.style.display === "none") return;
        // Not when typing in an input
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
        // Not while streaming
        if (chatIsStreaming) return;

        e.preventDefault();
        const dirMap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
        chatNavigateTreeArrowKey(dirMap[e.key]);
    });

    marked.setOptions({ breaks: true, gfm: true });

    loadBriefing(currentDate);
    loadProgress();
});
