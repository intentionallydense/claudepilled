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
let chatCurrentHighlight = null;

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
        for (let i = 0; i < conv.messages.length; i++) {
            const msg = conv.messages[i];
            const content = msg.content;
            if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
                continue;
            }
            if (renderedCount > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                messagesEl.appendChild(spacer);
            }
            chatRenderMessage(msg.role, content, i, msg.id, msg.parent_id);
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
            chatScrollToBottom();
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
            chatScrollToBottom();
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
            chatStreamingTextEl.textContent += event.text;
            chatStreamingTextEl.classList.add("streaming-cursor");
            chatScrollToBottom();
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
            if (event.tool_use_id && chatStreamingToolCalls[event.tool_use_id]) {
                chatStreamingToolCalls[event.tool_use_id].result = event.tool_result;
                chatRenderToolCallBlock(chatStreamingEl, chatStreamingToolCalls[event.tool_use_id]);
                chatScrollToBottom();
            }
            break;

        case "usage":
            break;

        case "title_update":
            break;

        case "message_done":
            if (chatStreamingTextEl) {
                chatStreamingTextEl.classList.remove("streaming-cursor");
            }
            if (chatStreamingSearchEl) {
                chatStreamingSearchEl.remove();
                chatStreamingSearchEl = null;
            }
            for (const [id, toolCall] of Object.entries(chatStreamingToolCalls)) {
                if (!toolCall.result) {
                    chatRenderToolCallBlock(chatStreamingEl, toolCall);
                }
            }
            chatStreamingEl = null;
            chatStreamingTextEl = null;
            chatStreamingThinkingEl = null;
            chatStreamingToolCalls = {};
            chatIsStreaming = false;
            inputEl.disabled = false;
            sendBtn.disabled = false;
            inputEl.focus();
            chatFetchAndUpdateCost();
            chatLoadTree();

            if (chatIsEditing) {
                chatIsEditing = false;
                chatLoadConversation(chatConversationId);
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
            chatScrollToBottom();
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
    if (parentId) div.dataset.parentId = parentId;

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
        textEl.textContent = content;
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
                const thinkingBlock = chatCreateThinkingBlock(el);
                thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                thinkingBlock.querySelector(".thinking-body").classList.remove("open");
            } else if (block.type === "text" && block.text) {
                textEl.textContent += block.text;
            } else if (block.type === "tool_use") {
                chatRenderToolCallBlock(el, {
                    name: block.name,
                    input: block.input,
                    result: null,
                });
            }
        }
    }

    document.getElementById("chat-messages").appendChild(el);
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
    const currentText = textEl.textContent;
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
    formEl.remove();

    chatIsStreaming = true;
    chatIsEditing = true;
    document.getElementById("chat-input").disabled = true;
    document.getElementById("chat-send").disabled = true;

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
    if (!text || chatIsStreaming || !chatWs || !chatConversationId) return;

    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }

    const userEl = chatCreateMessageEl("user");
    userEl.querySelector(".message-text").textContent = text;
    messagesEl.appendChild(userEl);
    chatScrollToBottom();

    const payload = { message: text };
    const thinkingCb = document.getElementById("chat-thinking-checkbox");
    if (thinkingCb && thinkingCb.checked) {
        payload.thinking_budget = 10000;
    }

    chatWs.send(JSON.stringify(payload));
    inputEl.value = "";
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

    // Build children map, skipping tool_result nodes
    const toolResultIds = new Set();
    const parentOf = {};
    for (const n of nodes) {
        parentOf[n.id] = n.parent_id;
        if (n.role === "user" && n.parent_id && !n.preview) {
            toolResultIds.add(n.id);
        }
    }

    const childrenMap = {};
    const nodeById = {};
    let rootId = null;
    for (const n of nodes) {
        if (toolResultIds.has(n.id)) continue;
        nodeById[n.id] = n;

        let pid = n.parent_id;
        while (pid && toolResultIds.has(pid)) {
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

    const layout = [];
    let maxCol = 0;

    function dfs(nodeId, depth, column) {
        const node = nodeById[nodeId];
        if (!node) return;
        layout.push({
            ...node,
            col: column,
            depth: depth,
            onPath: currentPath.has(nodeId),
        });
        if (column > maxCol) maxCol = column;

        const kids = childrenMap[nodeId] || [];
        let col = column;
        for (let i = 0; i < kids.length; i++) {
            if (i === 0) {
                dfs(kids[i], depth + 1, column);
            } else {
                col = maxCol + 1;
                dfs(kids[i], depth + 1, col);
            }
        }
    }

    dfs(rootId, 0, 0);

    const layerGap = 24;
    const colGap = 18;
    const startY = 12;
    const baseX = 24;
    const nodeRadius = { user: 5, assistant: 3 };

    const maxDepth = Math.max(...layout.map(n => n.depth));
    const totalHeight = startY + (maxDepth + 1) * layerGap + 16;
    const totalWidth = baseX + (maxCol + 1) * colGap + 24;
    nodeMap.style.minHeight = totalHeight + "px";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", Math.max(totalWidth, 100));
    svg.setAttribute("height", totalHeight);
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    nodeMap.appendChild(svg);

    const posMap = {};
    layout.forEach((item) => {
        const x = baseX + item.col * colGap;
        const y = startY + item.depth * layerGap;
        posMap[item.id] = { x, y };
    });

    // Draw connections
    for (const item of layout) {
        if (item.parent_id && posMap[item.parent_id] && posMap[item.id]) {
            const p = posMap[item.parent_id];
            const c = posMap[item.id];
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const midY = (p.y + c.y) / 2;
            path.setAttribute("d", `M${p.x},${p.y} C${p.x},${midY} ${c.x},${midY} ${c.x},${c.y}`);
            path.setAttribute("stroke", item.onPath && currentPath.has(item.parent_id) ? "#111" : "#ccc");
            path.setAttribute("stroke-width", item.onPath ? "1.5" : "1");
            path.setAttribute("fill", "none");
            svg.appendChild(path);
        }
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
            el: node, onPath: item.onPath,
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

function chatSyncTreeWithScroll() {
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

// ------------------------------------------------------------------
// Chat panel — utilities
// ------------------------------------------------------------------

function chatScrollToBottom() {
    const el = document.getElementById("chat-messages");
    el.scrollTop = el.scrollHeight;
}

function chatAutoResizeInput() {
    const el = document.getElementById("chat-input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
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

    document.getElementById("chat-messages").addEventListener("scroll", chatSyncTreeWithScroll);

    loadBriefing(currentDate);
    loadProgress();
});
