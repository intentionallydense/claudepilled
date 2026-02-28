// ---------------------------------------------------------------------------
// app.js — Main chat page. Uses createChatCore() from chat-core.js for all
// chat functionality (streaming, tree, rendering). This file handles
// page-specific concerns: sidebar, moodboard, files, prompts, context bar.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// State (page-specific only — chat state lives in chatCore)
// ---------------------------------------------------------------------------
let currentModel = null;
let savedPrompts = [];
let allFiles = [];
let allTags = [];
let activeContext = { files: [], total_tokens: 0 };
let boardPins = [];
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
const filesNavBtn = document.getElementById("files-nav-btn");
const newChatBtn = document.getElementById("new-chat-btn");

// DOM elements — chat (passed to chatCore)
const messagesEl = document.getElementById("messages");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const modelSelect = document.getElementById("model-select");
const thinkingCheckbox = document.getElementById("thinking-checkbox");
const costDisplay = document.getElementById("cost-display");
const nodeMap = document.getElementById("node-map");
const treeSearch = document.getElementById("tree-search");

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
// Chat core instance
// ---------------------------------------------------------------------------
const chatCore = createChatCore({
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

    onTitleUpdate(title) {
        const activeItem = conversationList.querySelector(`li[data-id="${chatCore.getConversationId()}"] span`);
        if (activeItem) activeItem.textContent = title;
    },

    onUsageEvent(event) {
        lastUsageEvent = event;
    },

    onContextUpdate(data) {
        activeContext = data;
        renderContextBar();
    },

    onMessageDone() {
        loadConversations();
    },

    onEditDone() {
        const id = chatCore.getConversationId();
        if (id) openConversation(id);
    },

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
        // Extract #tags from message
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

// ---------------------------------------------------------------------------
// Prompts
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
        if (c.id === chatCore.getConversationId()) li.classList.add("active");

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
            if (chatCore.getConversationId() === c.id) {
                chatCore.destroy();
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
        await loadConversations();
        await openConversation(conv.id);
    } catch (e) {
        console.error("Failed to create conversation:", e);
    }
}

async function openConversation(id) {
    // Highlight active in sidebar
    document.querySelectorAll("#conversation-list li").forEach((li) => {
        li.classList.toggle("active", li.dataset.id === id);
    });

    // Show chat UI
    welcomeEl.style.display = "none";
    messagesEl.style.display = "flex";
    inputArea.style.display = "block";

    // Load conversation through chatCore
    const conv = await chatCore.loadConversation(id);

    // Set model + prompt
    currentModel = conv.model;
    populatePromptSelect(conv.prompt_id || "");

    // Load context
    await loadContext();
}

function showWelcome() {
    welcomeEl.style.display = "flex";
    messagesEl.style.display = "none";
    inputArea.style.display = "none";
    chatCore.destroy();
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

    // Show the re-sent user message
    const spacer1 = document.createElement("div");
    spacer1.className = "message-spacer";
    messagesEl.appendChild(spacer1);
    const userEl = chatCore.createMessageEl("user", undefined, null, branchParentId);
    userEl.querySelector(".message-text").textContent = rawText;
    userEl.dataset.rawText = rawText;
    messagesEl.appendChild(userEl);
    chatCore.scrollToBottom();

    // Mark as streaming and send via WS — chatCore handles stream events
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
// File management
// ---------------------------------------------------------------------------
async function loadFiles() {
    try { allFiles = await api("/files"); }
    catch (e) { console.error("Failed to load files:", e); allFiles = []; }
}

async function loadAllTags() {
    try { allTags = await api("/files/tags"); }
    catch (e) { allTags = []; }
}

async function uploadFiles(fileList, tagsStr) {
    for (const file of fileList) {
        const form = new FormData();
        form.append("file", file);
        form.append("tags", tagsStr);
        try { await fetch("/api/files/upload", { method: "POST", body: form }); }
        catch (e) { console.error("Upload failed:", e); }
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
    await api(`/files/${fileId}`, { method: "PATCH", body: JSON.stringify({ tags }) });
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
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
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
    const convId = chatCore.getConversationId();
    if (!convId) {
        activeContext = { files: [], total_tokens: 0 };
        renderContextBar();
        return;
    }
    try {
        activeContext = await api(`/conversations/${convId}/context`);
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
            await api(`/conversations/${chatCore.getConversationId()}/context/${f.id}`, { method: "DELETE" });
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

// ---------------------------------------------------------------------------
// Event listeners (page-specific)
// ---------------------------------------------------------------------------
newChatBtn.onclick = quickCreateConversation;

// Tag autocomplete on input
messageInput.addEventListener("input", handleTagAutocomplete);
messageInput.addEventListener("blur", () => {
    setTimeout(hideTagAutocomplete, 150);
});

// Prompt change mid-conversation
promptSelect.onchange = async function () {
    const convId = chatCore.getConversationId();
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
    if (messageInput.disabled || !chatCore.getConversationId()) return;
    messageInput.focus({ preventScroll: true });
});

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
const uploadArea = document.getElementById("file-upload-area");
uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); };
uploadArea.ondragleave = () => uploadArea.classList.remove("dragover");
uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    const tagsStr = document.getElementById("file-upload-tags-input").value;
    uploadFiles(e.dataTransfer.files, tagsStr);
};
document.getElementById("file-filter-tag").onchange = function() {
    renderFileList(this.value || undefined);
};

// Board text input
document.getElementById("board-input-btn").onclick = () => {
    const val = boardInput.value.trim();
    if (!val) return;
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
        for (const file of e.dataTransfer.files) {
            if (!file.type.startsWith("image/")) continue;
            const reader = new FileReader();
            reader.onload = () => { createPin("image", reader.result); };
            reader.readAsDataURL(file);
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
chatCore.attachListeners();
chatCore.loadModels();
loadPrompts();
loadFiles();
loadAllTags();
loadBoard();
loadConversations().then(() => {
    const openId = new URLSearchParams(window.location.search).get("c");
    if (openId) {
        history.replaceState(null, "", "/");
        openConversation(openId);
    }
});
