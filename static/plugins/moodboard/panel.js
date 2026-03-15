/**
 * Moodboard panel — unified board showing pins and files, sorted by date.
 *
 * Loaded as a Column4 panel module by column4.js via dynamic import().
 * Exports render(container, ctx) and destroy().
 *
 * ctx must provide:
 *   api(path, opts) — fetch wrapper (prepends /api)
 *   loadAllTags()   — refresh tag autocomplete in host page
 *   loadContext()    — refresh context bar in host page
 */

let _container = null;
let _ctx = null;
let _boardPins = [];
let _boardFiles = [];
let _pinsEl = null;
let _inputEl = null;
let _listeners = [];

function _on(el, event, handler) {
    el.addEventListener(event, handler);
    _listeners.push({ el, event, handler });
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

export function render(container, ctx) {
    _container = container;
    _ctx = ctx;

    // Build DOM
    container.innerHTML = `
        <div class="board-pins" id="moodboard-pins"></div>
        <div class="board-input-area">
            <textarea class="board-input" placeholder="pin something... #tag" rows="1"></textarea>
            <div class="board-input-actions">
                <button class="board-input-btn">pin</button>
            </div>
        </div>
    `;

    _pinsEl = container.querySelector(".board-pins");
    _inputEl = container.querySelector(".board-input");
    const pinBtn = container.querySelector(".board-input-btn");

    // Input handlers
    _on(_inputEl, "input", _autoResize);
    _on(_inputEl, "keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            pinBtn.click();
        }
    });
    _on(pinBtn, "click", _handlePinInput);

    // Drag and drop
    _on(container, "dragover", (e) => {
        e.preventDefault();
        container.classList.add("dragover");
    });
    _on(container, "dragleave", (e) => {
        if (!container.contains(e.relatedTarget)) {
            container.classList.remove("dragover");
        }
    });
    _on(container, "drop", _handleDrop);

    // Paste
    _on(container, "paste", _handlePaste);
    container.setAttribute("tabindex", "-1");

    // Cross-column events
    _on(window, "board:pin-message", _handlePinMessage);
    _on(window, "column4:refresh", _handleRefresh);

    // Load data
    _loadBoard();
}

export function destroy() {
    for (const { el, event, handler } of _listeners) {
        el.removeEventListener(event, handler);
    }
    _listeners = [];
    _boardPins = [];
    _boardFiles = [];
    _pinsEl = null;
    _inputEl = null;
    if (_container) {
        _container.innerHTML = "";
        _container = null;
    }
}

// Also export createPin for programmatic use
export async function createPin(type, content, opts = {}) {
    const pin = await _ctx.api("/pins", {
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
    _boardPins.unshift(pin);
    if (_pinsEl) _pinsEl.prepend(_createPinEl(pin));
    if (opts.tags && opts.tags.length > 0) await _ctx.loadAllTags();
}

// ------------------------------------------------------------------
// Data loading
// ------------------------------------------------------------------

async function _loadBoard() {
    try {
        const [pins, files] = await Promise.all([
            _ctx.api("/pins"),
            _ctx.api("/files"),
        ]);
        _boardPins = pins;
        _boardFiles = files;
        _renderBoard();
    } catch (e) {
        console.error("Failed to load board:", e);
    }
}

function _renderBoard() {
    if (!_pinsEl) return;
    _pinsEl.innerHTML = "";
    const items = [];
    for (const pin of _boardPins) {
        items.push({ _kind: "pin", _date: pin.created, ...pin });
    }
    for (const file of _boardFiles) {
        items.push({ _kind: "file", _date: file.uploaded_at, ...file });
    }
    items.sort((a, b) => (b._date || "").localeCompare(a._date || ""));
    for (const item of items) {
        if (item._kind === "file") {
            _pinsEl.appendChild(_createFileCardEl(item));
        } else {
            _pinsEl.appendChild(_createPinEl(item));
        }
    }
}

// ------------------------------------------------------------------
// Pin element
// ------------------------------------------------------------------

function _createPinEl(pin) {
    const el = document.createElement("div");
    el.className = "board-pin";
    el.dataset.pinId = pin.id;

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "pin-delete";
    archiveBtn.textContent = "\u2193";
    archiveBtn.title = "Archive";
    archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        await _ctx.api(`/pins/${pin.id}/archive`, { method: "POST" });
        el.remove();
        _boardPins = _boardPins.filter(p => p.id !== pin.id);
    };
    el.appendChild(archiveBtn);

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
            _startPinRetag(pin, el);
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
            _startPinRetag(pin, el);
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

// ------------------------------------------------------------------
// File card element
// ------------------------------------------------------------------

function _createFileCardEl(file) {
    const el = document.createElement("div");
    el.className = "board-pin board-file";
    el.dataset.fileId = file.id;

    const del = document.createElement("button");
    del.className = "pin-delete";
    del.textContent = "\u00d7";
    del.onclick = async (e) => {
        e.stopPropagation();
        await _ctx.api(`/files/${file.id}`, { method: "DELETE" });
        el.remove();
        _boardFiles = _boardFiles.filter(f => f.id !== file.id);
        await _ctx.loadAllTags();
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
            _startFileRetag(file, el);
        };
        el.appendChild(tagsEl);
    }

    const meta = document.createElement("div");
    meta.className = "pin-meta";
    const tokSpan = document.createElement("span");
    tokSpan.textContent = _formatTokens(file.token_count);
    meta.appendChild(tokSpan);
    if (!file.tags || file.tags.length === 0) {
        const retagLink = document.createElement("span");
        retagLink.className = "pin-retag-link";
        retagLink.textContent = "+tag";
        retagLink.onclick = (e) => {
            e.stopPropagation();
            _startFileRetag(file, el);
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

// ------------------------------------------------------------------
// Retag UI
// ------------------------------------------------------------------

function _startPinRetag(pin, el) {
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
        await _ctx.api(`/pins/${pin.id}`, { method: "PATCH", body: JSON.stringify({ tags: newTags }) });
        form.remove();
        const idx = _boardPins.findIndex(p => p.id === pin.id);
        if (idx >= 0) _boardPins[idx].tags = newTags;
        _renderBoard();
        await _ctx.loadAllTags();
    };
    form.appendChild(saveBtn);
    el.appendChild(form);
    input.focus();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
    });
}

function _startFileRetag(file, el) {
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
        await _ctx.api(`/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ tags: newTags }) });
        form.remove();
        const idx = _boardFiles.findIndex(f => f.id === file.id);
        if (idx >= 0) _boardFiles[idx].tags = newTags;
        _renderBoard();
        await _ctx.loadAllTags();
    };
    form.appendChild(saveBtn);
    el.appendChild(form);
    input.focus();
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
    });
}

// ------------------------------------------------------------------
// Input handlers
// ------------------------------------------------------------------

function _handlePinInput() {
    const val = _inputEl.value.trim();
    if (!val) return;
    const tagRegex = /#([a-zA-Z0-9-]+)/g;
    const extractedTags = [];
    let match;
    while ((match = tagRegex.exec(val)) !== null) {
        extractedTags.push(match[1].toLowerCase());
    }
    const text = val.replace(/#[a-zA-Z0-9-]+/g, "").trim();
    if (!text) { _inputEl.value = ""; _autoResize(); return; }
    const type = /^https?:\/\/\S+$/.test(text) ? "link" : "text";
    createPin(type, text, { tags: extractedTags });
    _inputEl.value = "";
    _autoResize();
}

function _autoResize() {
    if (!_inputEl) return;
    _inputEl.style.height = "auto";
    _inputEl.style.height = Math.min(_inputEl.scrollHeight, 200) + "px";
}

async function _handleDrop(e) {
    e.preventDefault();
    _container.classList.remove("dragover");
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
            await _loadBoard();
            await _ctx.loadAllTags();
        }
        return;
    }
    const text = e.dataTransfer.getData("text/plain");
    if (text) {
        const type = /^https?:\/\/\S+$/.test(text) ? "link" : "text";
        createPin(type, text);
    }
}

function _handlePaste(e) {
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
    if (document.activeElement === _inputEl) return;
    const text = e.clipboardData.getData("text/plain");
    if (text) {
        e.preventDefault();
        const type = /^https?:\/\/\S+$/.test(text.trim()) ? "link" : "text";
        createPin(type, text.trim());
    }
}

// ------------------------------------------------------------------
// Cross-column event handlers
// ------------------------------------------------------------------

function _handlePinMessage(e) {
    const { text, conversationId, messageId } = e.detail;
    createPin("message", text, {
        source: "chat",
        conversation_id: conversationId,
        message_id: messageId,
    });
}

function _handleRefresh(e) {
    if (e.detail?.source === "pins" || e.detail?.source === "files" || !e.detail?.source) {
        _loadBoard();
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function _formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k tok";
    return n + " tok";
}
