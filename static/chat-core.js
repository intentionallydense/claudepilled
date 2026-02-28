// ---------------------------------------------------------------------------
// chat-core.js — Shared chat module used by both the main chat page and
// the briefing page. Provides a factory function createChatCore(config) that
// encapsulates all chat state, streaming, rendering, tree navigation, and
// event wiring. Each page calls createChatCore() with its own DOM elements
// and callbacks.
//
// Pure utility functions (escapeHtml, tryParseJSON, renderMarkdown, cursor
// helpers) are exported as globals so both pages can use them directly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure utilities (no state, globally available)
// ---------------------------------------------------------------------------
function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function tryParseJSON(str) {
    try { return JSON.parse(str); } catch { return str; }
}

/**
 * Render markdown for chat messages using marked + DOMPurify + LaTeX.
 * NOT the lightweight briefing-content renderer — this is the full one.
 */
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

// ---------------------------------------------------------------------------
// Factory: createChatCore(config)
// ---------------------------------------------------------------------------
//
// config.elements — DOM element references (required):
//   messages, input, sendBtn, stopBtn, modelSelect, thinkingCheckbox,
//   costDisplay, nodeMap, treeSearch, inputStatus
//
// config.apiFetch(method, path, body) — normalized API adapter.
//   Must return parsed JSON, throw on error.
//
// config.treeLayout — optional layout constants for the tree (has defaults)
//
// config callbacks (all optional):
//   onTitleUpdate(title)          — app.js: update sidebar title
//   onUsageEvent(event)           — app.js: store usage data
//   onContextUpdate(data)         — app.js: update context bar
//   onMessageDone()               — app.js: reload sidebar, etc.
//   onEditDone()                  — called after edit completes (reload)
//   createMessageActions(role, el, msgId, parentId)
//                                 — app.js: add copy/regen/pin buttons
//   buildSendPayload(text, images) — return custom payload (tag injection)
//   autoResizeMax                 — max textarea height (default 200)
//
function createChatCore(config) {
    const el = config.elements;
    const apiFetch = config.apiFetch;

    // Tree layout constants with defaults
    const treeLayout = Object.assign({
        layerGap: 28,
        colGap: 24,
        startY: 16,
        baseX: 16,
        nodeRadiusUser: 6,
        nodeRadiusAssistant: 4,
        svgMinWidth: 180,
        heightPad: 20,
        widthPad: 40,
    }, config.treeLayout || {});

    const autoResizeMax = config.autoResizeMax || 200;
    const MARKDOWN_DEBOUNCE_MS = 80;

    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------
    let conversationId = null;
    let ws = null;
    let isStreaming = false;
    let editingId = null;            // parent message id being edited
    let availableModels = [];

    // Tree state
    let treeData = null;
    let treeNodes = [];
    let treeChildrenMap = {};
    let treeParentMap = {};
    let currentHighlight = null;
    let arrowNavActive = false;
    let arrowNavTimer = null;

    // Image state
    let pendingImages = [];
    let editPendingImages = [];

    // Streaming state
    let streamingRawText = "";
    let markdownRenderTimer = null;
    let streamingEl = null;
    let streamingTextEl = null;
    let streamingThinkingEl = null;
    let streamingToolCalls = {};
    let streamingSearchEl = null;
    let toolResultsSinceLastText = false;

    // -----------------------------------------------------------------------
    // Models
    // -----------------------------------------------------------------------
    async function loadModels() {
        availableModels = await apiFetch("GET", "/api/models");
        populateModelSelect();
    }

    function populateModelSelect(selectedModel) {
        if (!el.modelSelect) return;
        el.modelSelect.innerHTML = "";
        for (const m of availableModels) {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === selectedModel) opt.selected = true;
            el.modelSelect.appendChild(opt);
        }
    }

    // -----------------------------------------------------------------------
    // Cost display
    // -----------------------------------------------------------------------
    function updateCostDisplay(inputTokens, outputTokens, cost, cacheCreationTokens, cacheReadTokens) {
        if (!el.costDisplay) return;
        const totalTokens = inputTokens + outputTokens;
        let tokenStr;
        if (totalTokens >= 1_000_000) {
            tokenStr = (totalTokens / 1_000_000).toFixed(1) + "M";
        } else if (totalTokens >= 1000) {
            tokenStr = (totalTokens / 1000).toFixed(1) + "k";
        } else {
            tokenStr = String(totalTokens);
        }
        el.costDisplay.textContent = `${tokenStr} tok | $${(cost || 0).toFixed(4)}`;
        let tooltip = `in: ${inputTokens} | out: ${outputTokens} | $${(cost || 0).toFixed(6)}`;
        if (cacheCreationTokens || cacheReadTokens) {
            tooltip += `\ncache write: ${cacheCreationTokens || 0} | cache read: ${cacheReadTokens || 0}`;
        }
        el.costDisplay.title = tooltip;
    }

    async function fetchAndUpdateCost() {
        if (!conversationId) return;
        try {
            const data = await apiFetch("GET", `/api/conversations/${conversationId}/cost`);
            updateCostDisplay(data.input_tokens, data.output_tokens, data.cost,
                data.cache_creation_tokens, data.cache_read_tokens);
        } catch (e) { /* ignore */ }
    }

    // -----------------------------------------------------------------------
    // WebSocket
    // -----------------------------------------------------------------------
    function connectWebSocket(convId) {
        if (ws) { ws.close(); ws = null; }
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${proto}//${location.host}/api/chat/${convId}`);
        ws.onopen = () => {};
        ws.onclose = () => { ws = null; };
        ws.onerror = () => {};
        ws.onmessage = (evt) => {
            const event = JSON.parse(evt.data);
            handleStreamEvent(event);
        };
    }

    // -----------------------------------------------------------------------
    // Send / stop buttons
    // -----------------------------------------------------------------------
    function showStopButton() {
        el.sendBtn.style.display = "none";
        el.stopBtn.style.display = "inline-block";
    }

    function showSendButton() {
        el.stopBtn.style.display = "none";
        el.sendBtn.style.display = "inline-block";
        el.sendBtn.disabled = false;
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
        editingId = null;
        el.input.disabled = false;
        showSendButton();

        // Close WS — server cleans up on disconnect — then reload
        if (ws) { ws.close(); ws = null; }
        if (conversationId && config.onEditDone) {
            config.onEditDone();
        }
    }

    // -----------------------------------------------------------------------
    // Stream event handler
    // -----------------------------------------------------------------------
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
                if (config.onUsageEvent) config.onUsageEvent(event);
                break;

            case "title_update":
                if (event.text && config.onTitleUpdate) {
                    config.onTitleUpdate(event.text);
                }
                break;

            case "message_done": {
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

                // Auto-toggle thinking checkbox
                if (el.thinkingCheckbox) {
                    const usedThinking = streamingEl &&
                        streamingEl.querySelector(".thinking-block") !== null;
                    el.thinkingCheckbox.checked = !!usedThinking;
                }

                const wasEdit = !!editingId;
                streamingEl = null;
                streamingTextEl = null;
                streamingThinkingEl = null;
                streamingToolCalls = {};
                toolResultsSinceLastText = false;
                isStreaming = false;
                editingId = null;
                el.sendBtn.disabled = false;
                el.input.disabled = false;
                showSendButton();

                if (wasEdit) {
                    if (config.onEditDone) config.onEditDone();
                } else {
                    el.input.focus();
                    fetchAndUpdateCost();
                    if (config.onMessageDone) config.onMessageDone();
                    scrollToBottom();
                    loadTree();
                    syncMessageIds();
                }
                break;
            }

            case "context_update":
                if (config.onContextUpdate) {
                    config.onContextUpdate({
                        files: event.files || [],
                        total_tokens: event.total_tokens || 0,
                    });
                }
                break;

            case "error": {
                if (!streamingEl) startStreamingMessage();
                const isRetry = event.error && event.error.includes("retrying");
                const errEl = document.createElement("div");
                errEl.style.color = isRetry ? "#e8a838" : "#c00";
                errEl.style.fontSize = "0.8rem";
                errEl.textContent = isRetry ? event.error : `error: ${event.error}`;
                streamingEl.appendChild(errEl);
                if (!isRetry) {
                    isStreaming = false;
                    el.sendBtn.disabled = false;
                    el.input.disabled = false;
                    showSendButton();
                }
                maybeScrollToBottom();
                break;
            }
        }
    }

    function startStreamingMessage() {
        if (el.messages.children.length > 0) {
            const spacer = document.createElement("div");
            spacer.className = "message-spacer";
            el.messages.appendChild(spacer);
        }
        streamingEl = createMessageEl("assistant");
        streamingTextEl = streamingEl.querySelector(".message-text");
        el.messages.appendChild(streamingEl);
    }

    // -----------------------------------------------------------------------
    // Thinking block
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Message rendering
    // -----------------------------------------------------------------------
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

        // Action buttons — user always gets "edit"
        const actions = document.createElement("div");
        actions.className = "message-actions";

        if (role === "user") {
            const editBtn = document.createElement("button");
            editBtn.className = "edit-btn";
            editBtn.textContent = "edit";
            editBtn.onclick = () => startEdit(div);
            actions.appendChild(editBtn);
        }

        // Page-specific actions (copy, regen, pin on main chat page)
        if (config.createMessageActions) {
            config.createMessageActions(role, actions, msgId, parentId);
        }

        div.appendChild(actions);
        return div;
    }

    function renderMessage(role, content, index, msgId, parentId) {
        // Skip tool_result messages
        if (Array.isArray(content) && content.every(b => b.type === "tool_result")) {
            return;
        }

        const msgEl = createMessageEl(role, index, msgId, parentId);
        const textEl = msgEl.querySelector(".message-text");

        if (typeof content === "string") {
            if (role === "assistant") {
                textEl.innerHTML = renderMarkdown(content);
            } else {
                textEl.textContent = content;
                msgEl.dataset.rawText = content;
            }
        } else if (Array.isArray(content)) {
            const textParts = [];
            for (const block of content) {
                if (block.type === "thinking" && block.thinking) {
                    const thinkingBlock = createThinkingBlock(msgEl);
                    thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                    thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                    thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                    thinkingBlock.querySelector(".thinking-body").classList.remove("open");
                } else if (block.type === "text" && block.text) {
                    textParts.push(block.text);
                } else if (block.type === "tool_use") {
                    renderToolCallBlock(msgEl, {
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
                    const textNode = document.createTextNode(fullText);
                    textEl.insertBefore(textNode, textEl.firstChild);
                    msgEl.dataset.rawText = fullText;
                }
            }
        }

        el.messages.appendChild(msgEl);
        return msgEl;
    }

    function appendAssistantContent(msgEl, content) {
        if (!Array.isArray(content)) return;
        const textParts = [];
        for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
                const thinkingBlock = createThinkingBlock(msgEl);
                thinkingBlock.querySelector(".thinking-content").textContent = block.thinking;
                thinkingBlock.querySelector(".thinking-label").textContent = "thought process";
                thinkingBlock.querySelector(".thinking-header").classList.remove("open");
                thinkingBlock.querySelector(".thinking-body").classList.remove("open");
            } else if (block.type === "text" && block.text) {
                textParts.push(block.text);
            } else if (block.type === "tool_use") {
                renderToolCallBlock(msgEl, {
                    name: block.name,
                    input: block.input,
                    result: null,
                });
            } else if (block.type === "image" && block.source) {
                const img = document.createElement("img");
                img.src = `data:${block.source.media_type};base64,${block.source.data}`;
                img.className = "message-image";
                msgEl.querySelector(".message-text").appendChild(img);
            }
        }
        if (textParts.length > 0) {
            const newTextEl = document.createElement("div");
            newTextEl.className = "message-text";
            newTextEl.innerHTML = renderMarkdown(textParts.join(""));
            msgEl.appendChild(newTextEl);
        }
    }

    function renderConversationMessages(messages) {
        el.messages.innerHTML = "";
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
                el.messages.appendChild(spacer);
            }
            const rendered = renderMessage(msg.role, content, i, msg.id, msg.parent_id);
            lastAssistantEl = (msg.role === "assistant") ? rendered : null;
            renderedCount++;
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

    // -----------------------------------------------------------------------
    // Edit
    // -----------------------------------------------------------------------
    function startEdit(msgEl) {
        if (isStreaming) return;

        // Remove any existing edit forms
        el.messages.querySelectorAll(".edit-form").forEach(f => f.remove());
        editPendingImages = [];

        const textEl = msgEl.querySelector(".message-text");
        const currentText = msgEl.dataset.rawText || textEl.textContent;
        const parentId = msgEl.dataset.parentId || null;

        // Collect existing images for re-attachment
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
        if ((!newText && !hasImages) || !ws || !conversationId || isStreaming) return;

        const editedMsg = formEl.closest(".message");
        formEl.remove();
        if (editedMsg) {
            while (editedMsg.nextSibling) editedMsg.nextSibling.remove();
            editedMsg.remove();
        }

        isStreaming = true;
        editingId = parentId;
        el.sendBtn.disabled = true;
        el.input.disabled = true;
        showStopButton();

        const userEl = createMessageEl("user");
        const textElUser = userEl.querySelector(".message-text");
        if (newText) textElUser.textContent = newText;
        for (const img of editPendingImages) {
            const imgEl = document.createElement("img");
            imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
            imgEl.className = "message-image";
            textElUser.appendChild(imgEl);
        }
        userEl.dataset.rawText = newText;
        el.messages.appendChild(userEl);
        scrollToBottom();

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
        if (el.thinkingCheckbox && el.thinkingCheckbox.checked) {
            payload.thinking_budget = 10000;
        }

        ws.send(JSON.stringify(payload));
        editPendingImages = [];
    }

    // -----------------------------------------------------------------------
    // Send message
    // -----------------------------------------------------------------------
    function sendMessage() {
        const rawText = el.input.value.trim();
        const hasImages = pendingImages.length > 0;
        if ((!rawText && !hasImages) || isStreaming || !ws || !conversationId) return;

        // Let the page customize the payload (e.g. tag extraction)
        let text = rawText;
        let payload;
        if (config.buildSendPayload) {
            payload = config.buildSendPayload(rawText, pendingImages);
            text = payload._displayText || rawText;
        } else {
            // Default: simple send
            let messagePayload;
            if (hasImages) {
                const blocks = [];
                if (rawText) blocks.push({ type: "text", text: rawText });
                blocks.push(...pendingImages);
                messagePayload = blocks;
            } else {
                messagePayload = rawText;
            }
            payload = { message: messagePayload };
        }

        if (el.thinkingCheckbox && el.thinkingCheckbox.checked) {
            payload.thinking_budget = 10000;
        }

        // Show user message
        if (text || hasImages) {
            if (el.messages.children.length > 0) {
                const spacer = document.createElement("div");
                spacer.className = "message-spacer";
                el.messages.appendChild(spacer);
            }
            const userEl = createMessageEl("user");
            const textElUser = userEl.querySelector(".message-text");
            if (text) {
                textElUser.textContent = text;
                userEl.dataset.rawText = text;
            }
            for (const img of pendingImages) {
                const imgEl = document.createElement("img");
                imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
                imgEl.className = "message-image";
                textElUser.appendChild(imgEl);
            }
            el.messages.appendChild(userEl);
            scrollToBottom();
        }

        delete payload._displayText;  // clean up internal field before sending
        ws.send(JSON.stringify(payload));
        el.input.value = "";
        clearImagePreviews();
        autoResizeInput();

        if (text || hasImages) {
            isStreaming = true;
            el.sendBtn.disabled = true;
            el.input.disabled = true;
            showStopButton();
        }
    }

    // -----------------------------------------------------------------------
    // Image preview
    // -----------------------------------------------------------------------
    function renderImagePreviews() {
        let area = el.messages.parentElement.querySelector(".image-preview-area:not(.edit-form .image-preview-area)");
        if (!area) {
            area = document.createElement("div");
            area.className = "image-preview-area";
            const wrapper = el.input.closest(".input-wrapper");
            if (wrapper) wrapper.insertBefore(area, el.input);
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
        const area = el.messages.parentElement.querySelector(".image-preview-area:not(.edit-form .image-preview-area)");
        if (area) {
            area.innerHTML = "";
            area.style.display = "none";
        }
    }

    // -----------------------------------------------------------------------
    // Scroll utilities
    // -----------------------------------------------------------------------
    function scrollToBottom() {
        el.messages.scrollTop = el.messages.scrollHeight;
    }

    function isNearBottom(threshold = 150) {
        return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < threshold;
    }

    function maybeScrollToBottom() {
        if (isNearBottom()) scrollToBottom();
    }

    function autoResizeInput() {
        const inp = el.input;
        const prevHeight = inp.offsetHeight;
        if (inp.scrollHeight > inp.clientHeight) {
            inp.style.height = Math.min(inp.scrollHeight, autoResizeMax) + "px";
        } else {
            inp.style.overflow = "hidden";
            inp.style.height = "0";
            inp.style.height = Math.min(inp.scrollHeight, autoResizeMax) + "px";
            inp.style.overflow = "";
        }
        if (inp.offsetHeight !== prevHeight && isNearBottom()) {
            scrollToBottom();
        }
    }

    // -----------------------------------------------------------------------
    // Markdown streaming
    // -----------------------------------------------------------------------
    function scheduleMarkdownRender() {
        if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
        markdownRenderTimer = setTimeout(() => {
            if (streamingTextEl && streamingRawText) {
                streamingTextEl.innerHTML = renderMarkdown(streamingRawText);
                appendStreamingCursor(streamingTextEl);
            }
        }, MARKDOWN_DEBOUNCE_MS);
    }

    // -----------------------------------------------------------------------
    // Sync message IDs
    // -----------------------------------------------------------------------
    async function syncMessageIds() {
        if (!conversationId) return;
        try {
            const conv = await apiFetch("GET", `/api/conversations/${conversationId}`);
            const msgEls = el.messages.querySelectorAll(".message");
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

    // -----------------------------------------------------------------------
    // Load conversation
    // -----------------------------------------------------------------------
    async function loadConversation(convId) {
        conversationId = convId;
        const conv = await apiFetch("GET", `/api/conversations/${convId}`);

        el.messages.style.display = "flex";
        el.messages.innerHTML = "";

        populateModelSelect(conv.model);
        updateCostDisplay(
            conv.total_input_tokens || 0,
            conv.total_output_tokens || 0,
            conv.total_cost || 0,
            conv.total_cache_creation_tokens || 0,
            conv.total_cache_read_tokens || 0,
        );

        renderConversationMessages(conv.messages);
        scrollToBottom();
        await loadTree();
        el.nodeMap.scrollTop = el.nodeMap.scrollHeight;
        connectWebSocket(convId);

        // Auto-toggle thinking
        if (el.thinkingCheckbox) {
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
            el.thinkingCheckbox.checked = lastHadThinking;
        }

        el.input.focus();
        return conv;
    }

    // -----------------------------------------------------------------------
    // Tree navigator
    // -----------------------------------------------------------------------
    async function loadTree() {
        if (!conversationId) return;
        try {
            treeData = await apiFetch("GET", `/api/conversations/${conversationId}/tree`);
            buildTree();
        } catch (e) {
            console.error("Failed to load tree:", e);
        }
    }

    function buildTree() {
        el.nodeMap.innerHTML = "";
        treeNodes = [];
        if (!treeData || !treeData.nodes || treeData.nodes.length === 0) return;

        const nodes = treeData.nodes;
        const currentPath = new Set(treeData.current_path || []);

        // Build children map, skipping tool_result and continuation assistant nodes
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

        // Layout: compact tree
        const layout = [];
        let nextLeafCol = 0;

        function layoutDfs(nodeId, depth, effectiveParent) {
            const node = nodeById[nodeId];
            if (!node) return null;

            const kids = childrenMap[nodeId] || [];

            if (kids.length === 0) {
                const col = nextLeafCol++;
                layout.push({ ...node, col, depth, onPath: currentPath.has(nodeId), drawParent: effectiveParent });
                return col;
            }

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

        const { layerGap, colGap, startY, baseX, nodeRadiusUser, nodeRadiusAssistant, svgMinWidth, heightPad, widthPad } = treeLayout;
        const nodeRadius = { user: nodeRadiusUser, assistant: nodeRadiusAssistant };

        const minCol = Math.min(...layout.map(n => n.col));
        const maxCol = Math.max(...layout.map(n => n.col));
        const maxDepth = Math.max(...layout.map(n => n.depth));
        const totalHeight = startY + (maxDepth + 1) * layerGap + heightPad;
        const totalWidth = baseX + (maxCol - minCol + 1) * colGap + widthPad;

        // Center tree horizontally when content is narrower than the panel
        const panelWidth = el.nodeMap.clientWidth || 200;
        const centerOffsetX = totalWidth < panelWidth ? Math.floor((panelWidth - totalWidth) / 2) : 0;

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const svgW = Math.max(totalWidth + centerOffsetX, panelWidth, svgMinWidth);
        svg.setAttribute("width", svgW);
        svg.setAttribute("height", totalHeight);
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        el.nodeMap.appendChild(svg);

        const spacerDiv = document.createElement("div");
        spacerDiv.style.height = totalHeight + "px";
        spacerDiv.style.pointerEvents = "none";
        el.nodeMap.appendChild(spacerDiv);

        // Position map
        const posMap = {};
        layout.forEach((item) => {
            const x = centerOffsetX + baseX + (item.col - minCol) * colGap;
            const y = startY + item.depth * layerGap;
            posMap[item.id] = { x, y };
        });

        // Draw connections
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

            const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            labelEl.setAttribute("x", 4);
            labelEl.setAttribute("y", y - 3);
            labelEl.setAttribute("fill", "#ccc");
            labelEl.setAttribute("font-size", "9px");
            labelEl.setAttribute("font-family", "inherit");
            labelEl.textContent = String(d);
            svg.appendChild(labelEl);
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

            node.onclick = () => navigateToNode(item.id);

            el.nodeMap.appendChild(node);
            treeNodes.push({ id: item.id, index: i, role: item.role, preview: item.preview, x: pos.x, y: pos.y, depth: item.depth, el: node, onPath: item.onPath });
        });
    }

    async function navigateToNode(nodeId) {
        if (isStreaming || !conversationId) return;

        if (treeData && treeData.current_path && treeData.current_path.includes(nodeId)) {
            const msgEl = el.messages.querySelector(`.message[data-msg-id="${nodeId}"]`);
            if (msgEl) {
                msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
        }

        try {
            const conv = await apiFetch("POST", `/api/conversations/${conversationId}/switch/${nodeId}`);
            renderConversationMessages(conv.messages);
            scrollToBottom();
            await loadTree();
        } catch (e) {
            console.error("Failed to switch branch:", e);
        }
    }

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

    function syncTreeWithScroll() {
        if (arrowNavActive) return;
        const msgEls = el.messages.querySelectorAll(".message");
        if (msgEls.length === 0 || treeNodes.length === 0) return;

        const containerRect = el.messages.getBoundingClientRect();
        const centerY = containerRect.top + containerRect.height / 2;
        let closestIdx = 0;
        let closestDist = Infinity;

        const onPathNodes = treeNodes.filter(tn => tn.onPath).sort((a, b) => a.depth - b.depth);
        if (onPathNodes.length === 0) return;

        const scrollBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
        if (scrollBottom < 40) {
            const idx = treeNodes.indexOf(onPathNodes[onPathNodes.length - 1]);
            if (idx >= 0) highlightTreeNode(idx);
            el.nodeMap.scrollTo({ top: el.nodeMap.scrollHeight, behavior: "smooth" });
            return;
        }
        if (el.messages.scrollTop < 40) {
            const idx = treeNodes.indexOf(onPathNodes[0]);
            if (idx >= 0) highlightTreeNode(idx);
            el.nodeMap.scrollTo({ top: 0, behavior: "smooth" });
            return;
        }

        msgEls.forEach((msgEl, i) => {
            const rect = msgEl.getBoundingClientRect();
            const dist = Math.abs(rect.top + rect.height / 2 - centerY);
            if (dist < closestDist && i < onPathNodes.length) {
                closestDist = dist;
                closestIdx = treeNodes.indexOf(onPathNodes[i]);
            }
        });

        if (closestIdx >= 0) highlightTreeNode(closestIdx);
    }

    function filterTree(query) {
        const q = (query || "").toLowerCase().trim();
        treeNodes.forEach(tn => {
            if (!q || (tn.preview && tn.preview.toLowerCase().includes(q))) {
                tn.el.style.opacity = "1";
            } else {
                tn.el.style.opacity = "0.2";
            }
        });
    }

    function navigateTreeArrowKey(direction) {
        if (treeNodes.length === 0) return;

        const onPathNodes = treeNodes.filter(tn => tn.onPath).sort((a, b) => a.depth - b.depth);
        if (onPathNodes.length === 0) return;

        arrowNavActive = true;
        clearTimeout(arrowNavTimer);
        arrowNavTimer = setTimeout(() => { arrowNavActive = false; }, 600);

        if (direction === "up" || direction === "down") {
            let curOnPathIdx = -1;
            if (currentHighlight !== null) {
                const highlighted = treeNodes[currentHighlight];
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
            highlightTreeNode(treeNodes.indexOf(target));

            const msgEl = el.messages.querySelector(`.message[data-msg-id="${target.id}"]`);
            if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });

        } else if (direction === "left" || direction === "right") {
            let current = null;
            if (currentHighlight !== null && treeNodes[currentHighlight]) {
                current = treeNodes[currentHighlight];
            }
            if (!current && onPathNodes.length > 0) {
                current = onPathNodes[onPathNodes.length - 1];
            }
            if (!current) return;

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

            if (!target.onPath) {
                navigateToNode(target.id);
            } else {
                const msgEl = el.messages.querySelector(`.message[data-msg-id="${target.id}"]`);
                if (msgEl) msgEl.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Attach event listeners
    // -----------------------------------------------------------------------
    function attachListeners() {
        // Scroll sync
        el.messages.addEventListener("scroll", syncTreeWithScroll);

        // Tree search
        if (el.treeSearch) {
            el.treeSearch.addEventListener("input", () => filterTree(el.treeSearch.value));
        }

        // Input auto-resize
        el.input.addEventListener("input", () => autoResizeInput());

        // Send on Enter
        el.input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Image paste
        el.input.addEventListener("paste", (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64 = reader.result.split(",")[1];
                        pendingImages.push({ type: "image", source: { type: "base64", media_type: item.type, data: base64 } });
                        renderImagePreviews();
                    };
                    reader.readAsDataURL(file);
                    break;
                }
            }
        });

        // Send / stop buttons
        el.sendBtn.onclick = sendMessage;
        el.stopBtn.onclick = stopStreaming;

        // Arrow key navigation
        document.addEventListener("keydown", (e) => {
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
            if (treeNodes.length === 0) return;
            const active = document.activeElement;
            if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
            if (isStreaming) return;

            e.preventDefault();
            const dirMap = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
            navigateTreeArrowKey(dirMap[e.key]);
        });

        // Model change mid-conversation
        if (el.modelSelect) {
            el.modelSelect.onchange = async function () {
                if (!conversationId) return;
                await apiFetch("PATCH", `/api/conversations/${conversationId}`, { model: this.value });
            };
        }
    }

    // -----------------------------------------------------------------------
    // Destroy — clean up WS and timers
    // -----------------------------------------------------------------------
    function destroy() {
        if (ws) { ws.close(); ws = null; }
        if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
        if (arrowNavTimer) clearTimeout(arrowNavTimer);
        conversationId = null;
        treeData = null;
        treeNodes = [];
        treeChildrenMap = {};
        treeParentMap = {};
        currentHighlight = null;
        isStreaming = false;
        editingId = null;
        pendingImages = [];
        editPendingImages = [];
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        loadModels,
        populateModelSelect,
        connectWebSocket,
        loadConversation,
        destroy,

        sendMessage,
        stopStreaming,

        renderMessage,
        renderConversationMessages,
        createMessageEl,
        appendAssistantContent,

        loadTree,
        buildTree,
        highlightTreeNode,
        syncTreeWithScroll,
        navigateTreeArrowKey,
        navigateToNode,
        filterTree,

        updateCostDisplay,
        fetchAndUpdateCost,
        syncMessageIds,

        startEdit,
        submitEdit,

        renderImagePreviews,
        clearImagePreviews,

        scrollToBottom,
        isNearBottom,
        maybeScrollToBottom,
        autoResizeInput,

        attachListeners,

        // Send a raw JSON payload through the WebSocket (for regenerate, etc.)
        sendRaw(payload) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            }
        },

        // Mark as streaming (for external features like regenerate)
        setStreaming(val) {
            isStreaming = val;
            if (val) {
                el.sendBtn.disabled = true;
                el.input.disabled = true;
                showStopButton();
            } else {
                el.sendBtn.disabled = false;
                el.input.disabled = false;
                showSendButton();
            }
        },

        // State accessors
        getConversationId: () => conversationId,
        setConversationId: (id) => { conversationId = id; },
        isCurrentlyStreaming: () => isStreaming,
        getTreeNodes: () => treeNodes,
        getAvailableModels: () => availableModels,
    };
}
