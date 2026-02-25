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

// DOM elements
const appEl = document.getElementById("app");
const conversationList = document.getElementById("conversation-list");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const chatHeader = document.getElementById("chat-header");
const inputArea = document.getElementById("input-area");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const modelSelect = document.getElementById("model-select");
const thinkingCheckbox = document.getElementById("thinking-checkbox");
const costDisplay = document.getElementById("cost-display");
const promptSelect = document.getElementById("prompt-select");
const treePanel = document.getElementById("tree-panel");
const nodeMap = document.getElementById("node-map");
const treeSearch = document.getElementById("tree-search");

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
        opt.textContent = `${m.name} ($${m.input_cost}/$${m.output_cost})`;
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
    chatHeader.style.display = "flex";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";
    treePanel.style.display = "flex";
    appEl.classList.remove("no-tree");

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

    // Render existing messages (skip tool_result-only messages)
    let renderedCount = 0;
    for (let i = 0; i < conv.messages.length; i++) {
        const msg = conv.messages[i];
        const content = msg.content;
        // Skip tool_result messages — they show inline via tool call blocks
        if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
            continue;
        }
        if (renderedCount > 0) {
            const spacer = document.createElement("div");
            spacer.className = "message-spacer";
            messagesEl.appendChild(spacer);
        }
        renderMessage(msg.role, content, i, msg.id, msg.parent_id);
        renderedCount++;
    }
    scrollToBottom();
    await loadTree();
    connectWebSocket(id);
    messageInput.focus();
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    chatHeader.style.display = "none";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    treePanel.style.display = "none";
    appEl.classList.add("no-tree");
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

// ---------------------------------------------------------------------------
// Streaming event handler
// ---------------------------------------------------------------------------
let streamingEl = null;
let streamingTextEl = null;
let streamingThinkingEl = null;
let streamingToolCalls = {};
let lastUsageEvent = null;
let streamingSearchEl = null;

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
            scrollToBottom();
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
            scrollToBottom();
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
            streamingTextEl.textContent += event.text;
            streamingTextEl.classList.add("streaming-cursor");
            scrollToBottom();
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
            if (event.tool_use_id && streamingToolCalls[event.tool_use_id]) {
                streamingToolCalls[event.tool_use_id].result = event.tool_result;
                renderToolCallBlock(streamingEl, streamingToolCalls[event.tool_use_id]);
                scrollToBottom();
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
            if (streamingTextEl) {
                streamingTextEl.classList.remove("streaming-cursor");
            }
            if (streamingSearchEl) {
                streamingSearchEl.remove();
                streamingSearchEl = null;
            }
            for (const [id, tc] of Object.entries(streamingToolCalls)) {
                if (!tc.result) {
                    renderToolCallBlock(streamingEl, tc);
                }
            }
            streamingEl = null;
            streamingTextEl = null;
            streamingThinkingEl = null;
            streamingToolCalls = {};
            isStreaming = false;
            editingMessageId = null;
            sendBtn.disabled = false;
            messageInput.disabled = false;
            messageInput.focus();
            fetchAndUpdateCost();
            loadConversations();
            lastUsageEvent = null;
            scrollToBottom();
            loadTree();
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
            }
            scrollToBottom();
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
    if (parentId) div.dataset.parentId = parentId;

    const label = document.createElement("div");
    label.className = "role-label";
    label.textContent = role === "user" ? "you" : "claude";
    div.appendChild(label);

    const text = document.createElement("div");
    text.className = "message-text";
    div.appendChild(text);

    // Add edit button for user messages
    if (role === "user") {
        const actions = document.createElement("div");
        actions.className = "message-actions";
        const editBtn = document.createElement("button");
        editBtn.className = "edit-btn";
        editBtn.textContent = "edit";
        editBtn.onclick = () => startEdit(div);
        actions.appendChild(editBtn);
        div.appendChild(actions);
    }

    return div;
}

function startEdit(msgEl) {
    if (isStreaming) return;

    // Remove any existing edit forms
    document.querySelectorAll(".edit-form").forEach(f => f.remove());

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
    sendEditBtn.onclick = () => submitEdit(parentId, textarea.value.trim(), form);
    actions.appendChild(sendEditBtn);

    form.appendChild(actions);
    msgEl.appendChild(form);

    textarea.focus();
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submitEdit(parentId, textarea.value.trim(), form);
        }
    });
}

function submitEdit(parentId, newText, formEl) {
    if (!newText || !ws || !currentConversationId || isStreaming) return;
    formEl.remove();

    // Clear messages after the edited one and rebuild via reloading
    isStreaming = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;

    const payload = {
        action: "edit",
        parent_id: parentId,
        message: newText,
    };
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }

    // Reload the conversation to show the new branch, then stream
    // The server handles creating the branch and streaming the response
    // We need to re-render after the edit completes — message_done handler
    // will call openConversation which reloads everything.

    // For now, just send the edit and let streaming handle the response
    // We'll reload the full conversation on message_done
    ws.send(JSON.stringify(payload));
}

function renderMessage(role, content, index, msgId, parentId) {
    // Skip tool_result messages — they show inline via tool call blocks
    if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
        return;
    }

    const el = createMessageEl(role, index, msgId, parentId);
    const textEl = el.querySelector(".message-text");

    if (typeof content === "string") {
        textEl.textContent = content;
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
                const thinkingBlock = createThinkingBlock(el);
                thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                thinkingBlock.querySelector(".thinking-body").classList.remove("open");
            } else if (block.type === "text" && block.text) {
                textEl.textContent += block.text;
            } else if (block.type === "tool_use") {
                renderToolCallBlock(el, {
                    name: block.name,
                    input: block.input,
                    result: null,
                });
            }
        }
    }

    messagesEl.appendChild(el);
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

    // Build children map
    const childrenMap = {};
    const nodeById = {};
    let rootId = null;
    for (const n of nodes) {
        nodeById[n.id] = n;
        if (!n.parent_id) {
            rootId = n.id;
        } else {
            if (!childrenMap[n.parent_id]) childrenMap[n.parent_id] = [];
            childrenMap[n.parent_id].push(n.id);
        }
    }

    if (!rootId) return;

    // Layout: DFS with column assignment
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
        // Keep creation order — no path-based sorting so tree layout is stable

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

    // Render
    const layerGap = 28;
    const colGap = 24;
    const startY = 16;
    const baseX = 40;
    const nodeRadius = { user: 6, assistant: 4 };

    const totalHeight = startY + layout.length * layerGap + 20;
    const totalWidth = baseX + (maxCol + 1) * colGap + 40;
    nodeMap.style.minHeight = totalHeight + "px";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", Math.max(totalWidth, 180));
    svg.setAttribute("height", totalHeight);
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    nodeMap.appendChild(svg);

    // Position map
    const posMap = {};
    layout.forEach((item, i) => {
        const x = baseX + item.col * colGap;
        const y = startY + i * layerGap;
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
        node.title = item.preview || `(${item.role})`;

        // Click to navigate
        node.onclick = () => navigateToNode(item.id);

        // Hover tooltip
        node.onmouseenter = () => showNodeTooltip(node, item.preview || `(${item.role})`);
        node.onmouseleave = () => hideNodeTooltip();

        nodeMap.appendChild(node);
        treeNodes.push({ id: item.id, index: i, role: item.role, preview: item.preview, x: pos.x, y: pos.y, el: node, onPath: item.onPath });
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

        // Re-render messages (skip tool_result-only messages)
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
            renderMessage(msg.role, c, i, msg.id, msg.parent_id);
            rendered++;
        }
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
        currentHighlight = index;
    }
}

let tooltipEl = null;
function showNodeTooltip(node, text) {
    hideNodeTooltip();
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tree-node-tooltip";
    tooltipEl.textContent = text;
    node.appendChild(tooltipEl);
}
function hideNodeTooltip() {
    if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
    }
}

// Sync tree highlight with message scroll position
function syncTreeWithScroll() {
    const msgEls = messagesEl.querySelectorAll(".message");
    if (msgEls.length === 0 || treeNodes.length === 0) return;

    const containerRect = messagesEl.getBoundingClientRect();
    const centerY = containerRect.top + containerRect.height / 2;
    let closestIdx = 0;
    let closestDist = Infinity;

    // Match message elements to on-path tree nodes
    const onPathNodes = treeNodes.filter(tn => tn.onPath);
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

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isStreaming || !ws || !currentConversationId) return;

    if (messagesEl.children.length > 0) {
        const spacer = document.createElement("div");
        spacer.className = "message-spacer";
        messagesEl.appendChild(spacer);
    }

    const userEl = createMessageEl("user");
    userEl.querySelector(".message-text").textContent = text;
    messagesEl.appendChild(userEl);
    scrollToBottom();

    const payload = { message: text };
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }

    ws.send(JSON.stringify(payload));
    messageInput.value = "";
    autoResizeInput();
    isStreaming = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + "px";
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
newChatBtn.onclick = quickCreateConversation;
sendBtn.onclick = sendMessage;

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
messageInput.addEventListener("input", autoResizeInput);

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

// Scroll sync for tree
messagesEl.addEventListener("scroll", syncTreeWithScroll);

// Tree search
treeSearch.addEventListener("input", filterTree);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
appEl.classList.add("no-tree");  // hide tree panel initially
loadModels();
loadPrompts();
loadConversations().then(() => {
    // Auto-open conversation from URL parameter (e.g. brain dump redirect)
    const openId = new URLSearchParams(window.location.search).get("c");
    if (openId) {
        history.replaceState(null, "", "/");  // clean up URL
        openConversation(openId);
    }
});
