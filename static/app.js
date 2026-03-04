// ---------------------------------------------------------------------------
// app.js — Main chat page. Uses createChatCore() from chat-core.js for all
// chat functionality (streaming, tree, rendering). This file handles
// page-specific concerns: sidebar, moodboard, files, prompts, context bar.
//
// Supports two modes: "chat" (normal Claude conversations) and "backrooms"
// (two-model sessions). Mode switching destroys/recreates the chatCore
// instance with appropriate config. BackroomsAdapter (backrooms-adapter.js)
// provides config overrides for backrooms mode.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State (page-specific only — chat state lives in chatCore)
// ---------------------------------------------------------------------------
let currentModel = null;
let currentMode = "chat"; // "chat" or "backrooms"
let savedPrompts = [];
let allTags = [];
let activeContext = { files: [], pins: [], total_tokens: 0 };
let boardPins = [];
let boardFiles = [];
let lastUsageEvent = null;

// DOM elements — page-specific
const appEl = document.getElementById("app");
const conversationList = document.getElementById("conversation-list");
const welcomeEl = document.getElementById("welcome");
const inputArea = document.getElementById("input-area");
const messageInput = document.getElementById("message-input");
const promptSelect = document.getElementById("prompt-select");
const boardPanel = document.getElementById("board-panel");
const boardContent = document.getElementById("board-content");
const boardPinsEl = document.getElementById("board-pins");
const boardInput = document.getElementById("board-input");
const contextBar = document.getElementById("context-bar");
const contextBarFiles = document.getElementById("context-bar-files");
const contextTokenCount = document.getElementById("context-token-count");
const tagAutocomplete = document.getElementById("tag-autocomplete");
const newChatBtn = document.getElementById("new-chat-btn");
const compactBtn = document.getElementById("compact-btn");
const menuBtn = document.getElementById("menu-btn");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const sidebar = document.getElementById("sidebar");
const sidebarSearch = document.getElementById("sidebar-search");
const sidebarSectionLabel = document.getElementById("sidebar-section-label");

// DOM elements — chat (passed to chatCore)
const messagesEl = document.getElementById("messages");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const modelSelect = document.getElementById("model-select");
const thinkingCheckbox = document.getElementById("thinking-checkbox");
const costDisplay = document.getElementById("cost-display");
const nodeMap = document.getElementById("node-map");
const treeSearch = document.getElementById("tree-search");

// DOM elements — backrooms-specific
const backroomsToolbar = document.getElementById("backrooms-toolbar");
const modelNamesEl = document.getElementById("model-names");
const statusIndicator = document.getElementById("status-indicator");
const newBackroomsBtn = document.getElementById("new-backrooms-btn");

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// Normalized adapter for chat-core (method, full path, body)
async function apiFetch(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ---------------------------------------------------------------------------
// Chat core instance — mutable for mode switching
// ---------------------------------------------------------------------------
let chatCore = null;

/** Shared chatCore callbacks used in both modes. */
function getSharedCallbacks() {
    return {
        onTitleUpdate(title) {
            const convId = chatCore?.getConversationId();
            if (!convId) return;
            const activeItem = conversationList.querySelector(`li[data-id="${convId}"] span`);
            if (activeItem) activeItem.textContent = title;
        },
        onUsageEvent(event) {
            lastUsageEvent = event;
        },
        onContextUpdate(data) {
            activeContext = {
                files: data.files || [],
                pins: data.pins || [],
                total_tokens: data.total_tokens || 0,
            };
            renderContextBar();
        },
        onMessageDone() {
            loadConversations();
        },
        onEditDone() {
            const id = chatCore?.getConversationId();
            if (id) openConversation(id);
        },
        onCompactionDone() {
            const id = chatCore?.getConversationId();
            if (id) openConversation(id);
        },
    };
}

/** Create a chatCore instance for normal chat mode. */
function createChatCoreForChat() {
    return createChatCore({
        elements: {
            messages: messagesEl,
            input: messageInput,
            sendBtn,
            stopBtn,
            modelSelect,
            thinkingCheckbox,
            costDisplay,
            nodeMap,
            treeSearch,
        },
        apiFetch,
        ...getSharedCallbacks(),

        createMessageActions(role, actionsEl, msgId, parentId) {
            if (role === "assistant") {
                const copyBtn = document.createElement("button");
                copyBtn.className = "msg-action-btn";
                copyBtn.textContent = "copy";
                copyBtn.onclick = () => {
                    const msgEl = copyBtn.closest(".message");
                    copyMessageText(msgEl);
                };
                actionsEl.appendChild(copyBtn);

                const regenBtn = document.createElement("button");
                regenBtn.className = "msg-action-btn";
                regenBtn.textContent = "regenerate";
                regenBtn.onclick = () => {
                    const msgEl = regenBtn.closest(".message");
                    regenerateResponse(msgEl);
                };
                actionsEl.appendChild(regenBtn);
            }

            const pinBtn = document.createElement("button");
            pinBtn.className = "msg-action-btn";
            pinBtn.textContent = "pin";
            pinBtn.onclick = () => {
                const msgEl = pinBtn.closest(".message");
                pinMessage(msgEl);
            };
            actionsEl.appendChild(pinBtn);
        },

        buildSendPayload(rawText, images) {
            const tagRegex = /#([a-zA-Z0-9-]+)/g;
            const extractedTags = [];
            let match;
            while ((match = tagRegex.exec(rawText)) !== null) {
                extractedTags.push(match[1].toLowerCase());
            }
            const text = rawText.replace(/#[a-zA-Z0-9-]+/g, "").trim();

            let messagePayload;
            if (images.length > 0) {
                const blocks = [];
                if (text) blocks.push({ type: "text", text });
                blocks.push(...images);
                messagePayload = blocks;
            } else {
                messagePayload = text;
            }

            const payload = { message: messagePayload, _displayText: text };
            if (extractedTags.length > 0) {
                payload.inject_tags = extractedTags;
            }
            return payload;
        },
    });
}

/** Create a chatCore instance for backrooms mode. */
function createChatCoreForBackrooms() {
    const adapterConfig = BackroomsAdapter.getChatCoreConfig();
    const cc = createChatCore({
        elements: {
            messages: messagesEl,
            input: messageInput,
            sendBtn,
            stopBtn,
            modelSelect: null, // no model select in backrooms
            thinkingCheckbox: null,
            costDisplay,
            nodeMap,
            treeSearch,
        },
        apiFetch,
        ...getSharedCallbacks(),
        ...adapterConfig,
    });
    BackroomsAdapter.setChatCore(cc);
    return cc;
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------
function setChatMode() {
    if (currentMode === "chat") return;
    currentMode = "chat";
    if (chatCore) { chatCore.destroy(); }
    chatCore = createChatCoreForChat();
    chatCore.attachListeners();
    chatCore.loadModels();
    updateModeUI();
}

function setBackroomsMode(meta) {
    currentMode = "backrooms";
    if (chatCore) { chatCore.destroy(); }
    BackroomsAdapter.init(meta, {
        toolbar: backroomsToolbar,
        statusIndicator,
        modelNames: modelNamesEl,
        messages: messagesEl,
    });
    chatCore = createChatCoreForBackrooms();
    chatCore.attachListeners();
    // No model loading needed — backrooms doesn't use model select
    updateModeUI();
}

function updateModeUI() {
    const isBackrooms = currentMode === "backrooms";
    // Chat-only elements
    if (modelSelect) modelSelect.style.display = isBackrooms ? "none" : "";
    if (promptSelect) promptSelect.style.display = isBackrooms ? "none" : "";
    if (thinkingCheckbox) thinkingCheckbox.parentElement.style.display = isBackrooms ? "none" : "";
    if (compactBtn) compactBtn.style.display = isBackrooms ? "none" : (compactBtn.dataset.show ? "" : "none");
    // Backrooms toolbar — single container for all backrooms controls
    if (backroomsToolbar) backroomsToolbar.style.display = isBackrooms ? "flex" : "none";
    // Stop button not used in backrooms
    if (stopBtn) stopBtn.style.display = "none";
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
async function loadPrompts() {
    savedPrompts = await api("/prompts?category=chat");
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
        li.dataset.type = c.type || "chat";
        const activeId = chatCore?.getConversationId();
        if (c.id === activeId) li.classList.add("active");

        const title = document.createElement("span");
        title.textContent = c.title;
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.style.whiteSpace = "nowrap";
        title.style.flex = "1";
        li.appendChild(title);

        // Type indicator for backrooms sessions
        if (c.type === "backrooms") {
            const typeLabel = document.createElement("span");
            typeLabel.className = "conv-type-label";
            typeLabel.textContent = "br";
            li.appendChild(typeLabel);
        }

        // Duplicate button for backrooms sessions
        if (c.type === "backrooms") {
            const dup = document.createElement("button");
            dup.className = "delete-btn";
            dup.textContent = "\u29C9";
            dup.title = "Duplicate session";
            dup.style.fontSize = "0.75rem";
            dup.onclick = async (e) => {
                e.stopPropagation();
                const res = await api(`/backrooms/sessions/${c.id}/duplicate`, { method: "POST" });
                await loadConversations();
                openConversation(res.id, "backrooms");
            };
            li.appendChild(dup);
        }

        const del = document.createElement("button");
        del.className = "delete-btn";
        del.textContent = "\u00d7";
        del.onclick = async (e) => {
            e.stopPropagation();
            const delPath = c.type === "backrooms"
                ? `/backrooms/sessions/${c.id}`
                : `/conversations/${c.id}`;
            await api(delPath, { method: "DELETE" });
            if (chatCore?.getConversationId() === c.id) {
                chatCore.destroy();
                showWelcome();
            }
            loadConversations();
        };
        li.appendChild(del);

        li.onclick = () => { openConversation(c.id, c.type || "chat"); toggleSidebar(false); };
        conversationList.appendChild(li);
    }
}

async function quickCreateConversation() {
    try {
        const conv = await api("/conversations", {
            method: "POST",
            body: JSON.stringify({ title: "New conversation" }),
        });
        await loadConversations();
        await openConversation(conv.id, "chat");
    } catch (e) {
        console.error("Failed to create conversation:", e);
    }
}

async function openConversation(id, type) {
    // Determine type if not provided
    if (!type) {
        const li = conversationList.querySelector(`li[data-id="${id}"]`);
        type = li?.dataset?.type || "chat";
    }

    // Highlight active in sidebar
    document.querySelectorAll("#conversation-list li").forEach((li) => {
        li.classList.toggle("active", li.dataset.id === id);
    });

    // Show chat UI
    welcomeEl.style.display = "none";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";

    if (type === "backrooms") {
        await openBackroomsSession(id);
    } else {
        await openChatConversation(id);
    }
}

async function openChatConversation(id) {
    if (currentMode !== "chat") setChatMode();

    const conv = await chatCore.loadConversation(id);
    currentModel = conv.model;
    populatePromptSelect(conv.prompt_id || "");

    if (compactBtn) {
        const showCompact = (conv.messages || []).length >= 10;
        compactBtn.style.display = showCompact ? "" : "none";
        compactBtn.dataset.show = showCompact ? "1" : "";
        compactBtn.textContent = "compact";
        compactBtn.disabled = false;
    }

    await loadContext();
}

async function openBackroomsSession(id) {
    // Fetch session metadata first (need model info for adapter init)
    let meta = {};
    try {
        const convData = await apiFetch("GET", `/api/conversations/${id}`);
        if (convData._metadata) meta = convData._metadata;
    } catch (e) { /* proceed without metadata */ }

    // Switch mode (this destroys/recreates chatCore)
    if (currentMode !== "backrooms") {
        setBackroomsMode(meta);
    } else {
        // Already in backrooms mode — just update adapter metadata
        BackroomsAdapter.init(meta, {
            toolbar: backroomsToolbar,
            statusIndicator,
            modelNames: modelNamesEl,
            messages: messagesEl,
        });
        BackroomsAdapter.setChatCore(chatCore);
    }

    // Update model names label — join all participant labels
    const parts = BackroomsAdapter.getParticipants();
    if (modelNamesEl) {
        modelNamesEl.textContent = parts.map(p => p.label).join(" / ");
    }

    // Load conversation data through chatCore (uses backrooms WS/cost URLs)
    const conv = await chatCore.loadConversation(id);

    // Re-render messages with speaker labels
    BackroomsAdapter.renderMessages(conv.messages || []);

    // Hide compact button in backrooms
    if (compactBtn) { compactBtn.style.display = "none"; compactBtn.dataset.show = ""; }

    await loadContext();
    await BackroomsAdapter.loadPrompts();
    BackroomsAdapter.renderSpeedControls();
    BackroomsAdapter.loadStats(id);
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    if (compactBtn) compactBtn.style.display = "none";
    if (chatCore) chatCore.destroy();
}

// ---------------------------------------------------------------------------
// Sidebar search — debounced LIKE search across all message content
// ---------------------------------------------------------------------------
let _searchTimer = null;
let _searchActive = false;

function handleSidebarSearch() {
    const query = sidebarSearch.value.trim();
    clearTimeout(_searchTimer);
    if (!query) {
        clearSearch();
        return;
    }
    _searchTimer = setTimeout(() => runSearch(query), 300);
}

async function runSearch(query) {
    try {
        const results = await api(`/conversations/search?q=${encodeURIComponent(query)}&limit=20`);
        _searchActive = true;
        sidebarSectionLabel.textContent = "results";
        conversationList.innerHTML = "";
        if (results.length === 0) {
            const empty = document.createElement("li");
            empty.className = "search-empty";
            empty.textContent = "no matches";
            conversationList.appendChild(empty);
            return;
        }
        for (const r of results) {
            const li = document.createElement("div");
            li.className = "search-result";
            const title = document.createElement("div");
            title.className = "search-result-title";
            title.textContent = r.title;
            li.appendChild(title);
            if (r.matches && r.matches.length > 0) {
                const m = r.matches[0];
                const prev = document.createElement("div");
                prev.className = "search-result-preview";
                prev.innerHTML = highlightQuery(escapeHtml(m.preview), query);
                li.appendChild(prev);
            }
            li.onclick = () => {
                openConversation(r.conversation_id);
                toggleSidebar(false);
            };
            conversationList.appendChild(li);
        }
    } catch (e) {
        console.error("Search failed:", e);
    }
}

function highlightQuery(text, query) {
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
    return text.replace(re, "<mark>$1</mark>");
}

function clearSearch() {
    _searchActive = false;
    sidebarSectionLabel.textContent = "conversations";
    loadConversations();
}

// ---------------------------------------------------------------------------
// Copy / Regenerate / Pin
// ---------------------------------------------------------------------------
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

function regenerateResponse(assistantMsgEl) {
    if (chatCore.isCurrentlyStreaming() || !chatCore.getConversationId()) return;
    const parentId = assistantMsgEl.dataset.parentId;
    if (!parentId) return;
    const userMsgEl = messagesEl.querySelector(`.message[data-msg-id="${parentId}"]`);
    if (!userMsgEl) return;
    const rawText = userMsgEl.dataset.rawText;
    if (!rawText) return;
    const branchParentId = userMsgEl.dataset.parentId || null;

    const payload = {
        action: "edit",
        parent_id: branchParentId,
        message: rawText,
    };
    if (thinkingCheckbox && thinkingCheckbox.checked) {
        payload.thinking_budget = 10000;
    }

    const spacer1 = document.createElement("div");
    spacer1.className = "message-spacer";
    messagesEl.appendChild(spacer1);
    const userEl = chatCore.createMessageEl("user", undefined, null, branchParentId);
    userEl.querySelector(".message-text").textContent = rawText;
    userEl.dataset.rawText = rawText;
    messagesEl.appendChild(userEl);
    chatCore.scrollToBottom();

    chatCore.setStreaming(true);
    chatCore.sendRaw(payload);
}

function pinMessage(msgEl) {
    const textEl = msgEl.querySelector(".message-text");
    const text = textEl?.innerText || textEl?.textContent || "";
    if (!text.trim()) return;
    createPin("message", text.trim(), {
        conversation_id: chatCore.getConversationId(),
        message_id: msgEl.dataset.msgId,
    });
}

// ---------------------------------------------------------------------------
// Tag management (unified: files + pins)
// ---------------------------------------------------------------------------
async function loadAllTags() {
    try {
        const [fileTags, pinTags] = await Promise.all([
            api("/files/tags"),
            api("/pins/tags"),
        ]);
        const merged = new Set([...fileTags, ...pinTags]);
        allTags = [...merged].sort();
    } catch (e) { allTags = []; }
}

function formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k tok";
    return n + " tok";
}

// ---------------------------------------------------------------------------
// Context bar
// ---------------------------------------------------------------------------
async function loadContext() {
    const convId = chatCore?.getConversationId();
    if (!convId) {
        activeContext = { files: [], pins: [], total_tokens: 0 };
        renderContextBar();
        return;
    }
    try {
        const data = await api(`/conversations/${convId}/context`);
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
    if (chatCore) chatCore.scrollToBottom();

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
        removeBtn.onpointerdown = async (e) => {
            e.preventDefault();
            await api(`/conversations/${chatCore.getConversationId()}/context/${f.id}`, { method: "DELETE" });
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
        removeBtn.onpointerdown = async (e) => {
            e.preventDefault();
            await api(`/conversations/${chatCore.getConversationId()}/context/pin/${p.id}`, { method: "DELETE" });
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
        item.onpointerdown = (e) => {
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
// Unified board (pins + files merged by date)
// ---------------------------------------------------------------------------
async function loadBoard() {
    try {
        const [pins, files] = await Promise.all([
            api("/pins"),
            api("/files"),
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

function createPinEl(pin) {
    const el = document.createElement("div");
    el.className = "board-pin";
    el.dataset.pinId = pin.id;

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

    if (pin.tags && pin.tags.length > 0) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "pin-tags";
        for (const tag of pin.tags) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag;
            tagsEl.appendChild(chip);
        }
        tagsEl.onclick = (e) => {
            e.stopPropagation();
            startPinRetag(pin, el);
        };
        el.appendChild(tagsEl);
    }

    const meta = document.createElement("div");
    meta.className = "pin-meta";
    const src = document.createElement("span");
    src.className = "pin-source";
    src.textContent = pin.source;
    meta.appendChild(src);
    if (!pin.tags || pin.tags.length === 0) {
        const retagLink = document.createElement("span");
        retagLink.className = "pin-retag-link";
        retagLink.textContent = "+tag";
        retagLink.onclick = (e) => {
            e.stopPropagation();
            startPinRetag(pin, el);
        };
        meta.appendChild(retagLink);
    }
    const time = document.createElement("span");
    const d = new Date(pin.created);
    time.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    meta.appendChild(time);
    el.appendChild(meta);

    return el;
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
        await api(`/files/${file.id}`, { method: "DELETE" });
        el.remove();
        boardFiles = boardFiles.filter(f => f.id !== file.id);
        await loadAllTags();
    };
    el.appendChild(del);

    const ext = file.filename.split(".").pop().toLowerCase();
    const typeLabel = document.createElement("span");
    typeLabel.className = "file-type-label";
    typeLabel.textContent = ext;
    el.appendChild(typeLabel);

    const nameEl = document.createElement("div");
    nameEl.className = "file-card-name";
    nameEl.textContent = file.filename;
    el.appendChild(nameEl);

    if (file.tags && file.tags.length > 0) {
        const tagsEl = document.createElement("div");
        tagsEl.className = "pin-tags";
        for (const tag of file.tags) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.textContent = tag;
            tagsEl.appendChild(chip);
        }
        tagsEl.onclick = (e) => {
            e.stopPropagation();
            startFileRetag(file, el);
        };
        el.appendChild(tagsEl);
    }

    const meta = document.createElement("div");
    meta.className = "pin-meta";
    const tokSpan = document.createElement("span");
    tokSpan.textContent = formatTokens(file.token_count);
    meta.appendChild(tokSpan);
    if (!file.tags || file.tags.length === 0) {
        const retagLink = document.createElement("span");
        retagLink.className = "pin-retag-link";
        retagLink.textContent = "+tag";
        retagLink.onclick = (e) => {
            e.stopPropagation();
            startFileRetag(file, el);
        };
        meta.appendChild(retagLink);
    }
    const time = document.createElement("span");
    const d = new Date(file.uploaded_at);
    time.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    meta.appendChild(time);
    el.appendChild(meta);

    return el;
}

function startPinRetag(pin, el) {
    document.querySelectorAll(".retag-form").forEach(f => f.remove());
    const form = document.createElement("div");
    form.className = "retag-form";
    const input = document.createElement("input");
    input.type = "text";
    input.value = (pin.tags || []).join(", ");
    input.placeholder = "tags (comma-separated)";
    form.appendChild(input);
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "save";
    saveBtn.onclick = async () => {
        const newTags = input.value.split(",").map(t => t.trim()).filter(Boolean);
        await api(`/pins/${pin.id}`, { method: "PATCH", body: JSON.stringify({ tags: newTags }) });
        form.remove();
        const idx = boardPins.findIndex(p => p.id === pin.id);
        if (idx >= 0) boardPins[idx].tags = newTags;
        renderBoard();
        await loadAllTags();
    };
    form.appendChild(saveBtn);
    el.appendChild(form);
    input.focus();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
    });
}

function startFileRetag(file, el) {
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
        await api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ tags: newTags }) });
        form.remove();
        const idx = boardFiles.findIndex(f => f.id === file.id);
        if (idx >= 0) boardFiles[idx].tags = newTags;
        renderBoard();
        await loadAllTags();
    };
    form.appendChild(saveBtn);
    el.appendChild(form);
    input.focus();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
    });
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
            tags: opts.tags || [],
        }),
    });
    boardPins.unshift(pin);
    boardPinsEl.prepend(createPinEl(pin));
    if (opts.tags && opts.tags.length > 0) await loadAllTags();
}

// ---------------------------------------------------------------------------
// Mobile sidebar toggle
// ---------------------------------------------------------------------------
function toggleSidebar(open) {
    const show = open !== undefined ? open : !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", show);
    sidebarBackdrop.classList.toggle("open", show);
}

if (menuBtn) menuBtn.onclick = () => toggleSidebar();
if (sidebarBackdrop) sidebarBackdrop.onclick = () => toggleSidebar(false);

// ---------------------------------------------------------------------------
// Backrooms: new session + prompts modals
// ---------------------------------------------------------------------------
function showNewSessionModal() {
    const modal = document.getElementById("new-session-modal");
    if (!modal) return;
    const models = chatCore?.getAvailableModels?.() || [];
    const container = document.getElementById("participant-rows");
    if (!container) return;

    // Clear and add initial 2 rows
    container.innerHTML = "";
    _addParticipantRow(container, models, 0);
    _addParticipantRow(container, models, 1);
    _updateParticipantUI(container);
    modal.style.display = "flex";
}

function _addParticipantRow(container, models, seatIndex) {
    const row = document.createElement("div");
    row.className = "participant-row";
    row.dataset.seat = seatIndex;

    const label = document.createElement("label");
    label.className = "form-label";
    label.textContent = seatIndex === 0 ? `seat ${seatIndex + 1} (manages pacing)` : `seat ${seatIndex + 1}`;

    const rowInner = document.createElement("div");
    rowInner.className = "participant-row-inner";

    const sel = document.createElement("select");
    sel.className = "select-minimal form-select participant-select";
    for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        sel.appendChild(opt);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "text-btn participant-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.onclick = () => {
        row.remove();
        _updateParticipantUI(container);
    };

    rowInner.appendChild(sel);
    rowInner.appendChild(removeBtn);
    row.appendChild(label);
    row.appendChild(rowInner);
    container.appendChild(row);
}

function _updateParticipantUI(container) {
    const rows = container.querySelectorAll(".participant-row");
    // Hide remove button if only 2 rows
    rows.forEach(row => {
        const btn = row.querySelector(".participant-remove");
        if (btn) btn.style.display = rows.length <= 2 ? "none" : "";
    });
    // Show/hide add button (max 5)
    const addBtn = document.getElementById("add-participant-btn");
    if (addBtn) addBtn.style.display = rows.length >= 5 ? "none" : "";
}

async function createBackroomsSession() {
    const container = document.getElementById("participant-rows");
    if (!container) return;
    const selects = container.querySelectorAll(".participant-select");
    const participants = [];
    for (const sel of selects) {
        if (sel.value) participants.push(sel.value);
    }
    if (participants.length < 2) return;
    try {
        const session = await api("/backrooms/sessions", {
            method: "POST",
            body: JSON.stringify({ participants }),
        });
        document.getElementById("new-session-modal").style.display = "none";
        await loadConversations();
        await openConversation(session.id, "backrooms");
    } catch (e) {
        console.error("Failed to create backrooms session:", e);
    }
}

// Wire up new session modal
if (newBackroomsBtn) {
    newBackroomsBtn.onclick = (e) => {
        e.preventDefault();
        showNewSessionModal();
    };
}
document.getElementById("new-session-modal-close")?.addEventListener("click", () => {
    document.getElementById("new-session-modal").style.display = "none";
});
document.getElementById("create-session-btn")?.addEventListener("click", createBackroomsSession);
document.getElementById("add-participant-btn")?.addEventListener("click", () => {
    const container = document.getElementById("participant-rows");
    if (!container) return;
    const models = chatCore?.getAvailableModels?.() || [];
    const nextSeat = container.querySelectorAll(".participant-row").length;
    if (nextSeat >= 5) return;
    _addParticipantRow(container, models, nextSeat);
    _updateParticipantUI(container);
});

// Wire up prompts modal
if (modelNamesEl) {
    modelNamesEl.onclick = () => {
        const sessionId = chatCore?.getConversationId();
        if (sessionId && currentMode === "backrooms") {
            BackroomsAdapter.openPromptsModal(sessionId);
        }
    };
}
document.getElementById("br-prompts-modal-close")?.addEventListener("click", () => {
    document.getElementById("backrooms-prompts-modal").style.display = "none";
});
document.getElementById("br-save-prompts-btn")?.addEventListener("click", () => {
    const sessionId = chatCore?.getConversationId();
    if (sessionId) BackroomsAdapter.savePrompts(sessionId);
});
document.getElementById("br-reset-prompts-btn")?.addEventListener("click", () => {
    const sessionId = chatCore?.getConversationId();
    if (sessionId) BackroomsAdapter.resetPrompts(sessionId);
});

// ---------------------------------------------------------------------------
// Event listeners (page-specific)
// ---------------------------------------------------------------------------
newChatBtn.onclick = quickCreateConversation;

if (compactBtn) {
    compactBtn.onclick = () => {
        if (!chatCore?.getConversationId() || chatCore.isCurrentlyStreaming()) return;
        compactBtn.textContent = "compacting...";
        compactBtn.disabled = true;
        chatCore.sendRaw({ action: "compact" });
    };
}

sidebarSearch.addEventListener("input", handleSidebarSearch);

messageInput.addEventListener("input", handleTagAutocomplete);
messageInput.addEventListener("blur", () => {
    setTimeout(hideTagAutocomplete, 150);
});

promptSelect.onchange = async function () {
    const convId = chatCore?.getConversationId();
    if (!convId) return;
    const id = this.value;
    const body = id ? { prompt_id: id } : { clear_prompt: true };
    await api(`/conversations/${convId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
};

// Focus textarea on printable character press
document.addEventListener("keydown", (e) => {
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
    if (messageInput.disabled || !chatCore?.getConversationId()) return;
    messageInput.focus({ preventScroll: true });
});

// Board input auto-resize
function autoResizeBoardInput() {
    boardInput.style.height = "auto";
    boardInput.style.height = Math.min(boardInput.scrollHeight, 200) + "px";
}
boardInput.addEventListener("input", autoResizeBoardInput);

// Board text input — extract #tags before pinning
document.getElementById("board-input-btn").onclick = () => {
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
};
boardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.getElementById("board-input-btn").click();
    }
});

// Board drag and drop
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
    if (e.dataTransfer.files.length > 0) {
        let hasDocFiles = false;
        for (const file of e.dataTransfer.files) {
            const ext = file.name.split(".").pop().toLowerCase();
            if (ext === "pdf" || ext === "md") {
                hasDocFiles = true;
                const form = new FormData();
                form.append("file", file);
                form.append("tags", "");
                try { await fetch("/api/files/upload", { method: "POST", body: form }); }
                catch (err) { console.error("Upload failed:", err); }
            }
            else if (file.type.startsWith("image/")) {
                const reader = new FileReader();
                reader.onload = () => { createPin("image", reader.result); };
                reader.readAsDataURL(file);
            }
        }
        if (hasDocFiles) {
            await loadBoard();
            await loadAllTags();
        }
        return;
    }
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
        const type = /^https?:\/\/\S+$/.test(text) ? "link" : "text";
        createPin(type, text);
    }
});

// Board paste
boardPanel.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith("image/")) {
            e.preventDefault();
            const file = item.getAsFile();
            const reader = new FileReader();
            reader.onload = () => { createPin("image", reader.result); };
            reader.readAsDataURL(file);
            return;
        }
    }
    if (document.activeElement === boardInput) return;
    const text = e.clipboardData.getData("text/plain");
    if (text) {
        e.preventDefault();
        const type = /^https?:\/\/\S+$/.test(text.trim()) ? "link" : "text";
        createPin(type, text.trim());
    }
});

boardPanel.setAttribute("tabindex", "-1");

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
marked.setOptions({ breaks: true, gfm: true });

// Start in chat mode
chatCore = createChatCoreForChat();
chatCore.attachListeners();

chatCore.loadModels().then(() => {
    loadPrompts();
    loadAllTags();
    loadBoard();
    loadConversations().then(() => {
        const params = new URLSearchParams(window.location.search);
        const openId = params.get("c");
        const autoInit = params.get("init") === "1";
        if (openId) {
            history.replaceState(null, "", "/");
            openConversation(openId).then(() => {
                if (autoInit) {
                    chatCore.setStreaming(true);
                    chatCore.sendRaw({ action: "init", model: "claude-haiku-4-5-20251001" });
                }
            });
        }
    });
});
