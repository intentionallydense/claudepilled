// ---------------------------------------------------------------------------
// settings.js — Settings page: model defaults, prompt library, seat suffixes.
// Loaded by settings.html after style.css + settings.css.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const modelSelect = document.getElementById("default-model");
const universalPromptSelect = document.getElementById("universal-prompt-select");
const form = document.getElementById("settings-form");
const saveStatus = document.getElementById("save-status");
const promptsList = document.getElementById("prompts-list");
const backroomsPromptsList = document.getElementById("backrooms-prompts-list");

// ---------------------------------------------------------------------------
// Load models into select
// ---------------------------------------------------------------------------
async function loadModels() {
    const res = await fetch("/api/models");
    const models = await res.json();
    modelSelect.innerHTML = "";
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "(none)";
    modelSelect.appendChild(emptyOpt);
    // Group by provider
    const byProvider = {};
    for (const m of models) {
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
            optgroup.appendChild(opt);
        }
        modelSelect.appendChild(optgroup);
    }
}

// ---------------------------------------------------------------------------
// Populate universal prompt dropdown from saved chat prompts
// ---------------------------------------------------------------------------
async function loadUniversalPromptOptions() {
    const res = await fetch("/api/prompts?category=chat");
    const prompts = await res.json();
    // Keep the "(none)" option, clear the rest
    universalPromptSelect.innerHTML = '<option value="">(none)</option>';
    for (const p of prompts) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        universalPromptSelect.appendChild(opt);
    }
}

// ---------------------------------------------------------------------------
// Load current settings (includes seat suffixes)
// ---------------------------------------------------------------------------
async function loadSettings() {
    const res = await fetch("/api/settings");
    const settings = await res.json();
    if (settings.default_model) modelSelect.value = settings.default_model;
    if (settings.universal_prompt_id) universalPromptSelect.value = settings.universal_prompt_id;
    const suffix1 = document.getElementById("seat-1-suffix");
    const suffix2 = document.getElementById("seat-2-suffix");
    if (suffix1 && settings.backrooms_seat_1_suffix) suffix1.value = settings.backrooms_seat_1_suffix;
    if (suffix2 && settings.backrooms_seat_2_suffix) suffix2.value = settings.backrooms_seat_2_suffix;
}

// ---------------------------------------------------------------------------
// Save settings
// ---------------------------------------------------------------------------
async function saveSettings(e) {
    e.preventDefault();
    await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            default_model: modelSelect.value,
            universal_prompt_id: universalPromptSelect.value,
        }),
    });
    saveStatus.textContent = "saved";
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
}

// ---------------------------------------------------------------------------
// Collapsible add-prompt forms
// ---------------------------------------------------------------------------
function toggleAddForm(category, show) {
    const formId = category === "backrooms" ? "add-backrooms-prompt-form" : "add-prompt-form";
    const btnId = category === "backrooms" ? "add-backrooms-prompt-btn" : "add-prompt-btn";
    const formEl = document.getElementById(formId);
    const btnEl = document.getElementById(btnId);
    if (!formEl || !btnEl) return;

    if (show) {
        formEl.classList.add("open");
        btnEl.style.display = "none";
        // Focus the name input
        const nameInput = formEl.querySelector(".form-input");
        if (nameInput) nameInput.focus();
    } else {
        formEl.classList.remove("open");
        btnEl.style.display = "";
        // Clear inputs
        formEl.querySelectorAll(".form-input").forEach(el => { el.value = ""; });
        formEl.querySelectorAll(".form-textarea").forEach(el => { el.value = ""; });
    }
}

// ---------------------------------------------------------------------------
// Prompts library — shared renderer for both chat and backrooms sections
// ---------------------------------------------------------------------------
function renderPromptList(listEl, prompts, category) {
    listEl.innerHTML = "";
    if (prompts.length === 0) {
        listEl.innerHTML = '<div class="prompts-empty">no saved prompts yet.</div>';
        return;
    }
    for (const p of prompts) {
        const item = document.createElement("div");
        item.className = "prompt-item";
        item.dataset.id = p.id;

        const header = document.createElement("div");
        header.className = "prompt-header";

        const name = document.createElement("span");
        name.className = "prompt-name";
        name.textContent = p.name;
        header.appendChild(name);

        const actions = document.createElement("div");
        actions.className = "prompt-actions";

        const editBtn = document.createElement("button");
        editBtn.className = "text-btn";
        editBtn.textContent = "edit";
        editBtn.onclick = () => startPromptEdit(listEl, p.id, p, category);
        actions.appendChild(editBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "text-btn";
        delBtn.textContent = "delete";
        delBtn.onclick = async () => {
            await fetch(`/api/prompts/${p.id}`, { method: "DELETE" });
            loadAllPrompts();
        };
        actions.appendChild(delBtn);

        header.appendChild(actions);
        item.appendChild(header);

        const preview = document.createElement("div");
        preview.className = "prompt-preview";
        preview.textContent = p.content.substring(0, 120) + (p.content.length > 120 ? "..." : "");
        item.appendChild(preview);

        listEl.appendChild(item);
    }
}

async function loadAllPrompts() {
    const [chatPrompts, backroomsPrompts] = await Promise.all([
        fetch("/api/prompts?category=chat").then(r => r.json()),
        fetch("/api/prompts?category=backrooms").then(r => r.json()),
    ]);
    renderPromptList(promptsList, chatPrompts, "chat");
    renderPromptList(backroomsPromptsList, backroomsPrompts, "backrooms");
    // Keep universal prompt dropdown in sync with chat prompts
    const currentVal = universalPromptSelect.value;
    await loadUniversalPromptOptions();
    universalPromptSelect.value = currentVal;
}

function startPromptEdit(listEl, id, prompt, category) {
    const item = listEl.querySelector(`[data-id="${id}"]`);
    if (!item) return;

    item.innerHTML = "";

    const nameInput = document.createElement("input");
    nameInput.className = "form-input";
    nameInput.value = prompt.name;
    item.appendChild(nameInput);

    const contentArea = document.createElement("textarea");
    contentArea.className = "form-textarea";
    contentArea.rows = 4;
    contentArea.value = prompt.content;
    item.appendChild(contentArea);

    const actions = document.createElement("div");
    actions.className = "prompt-edit-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "text-btn";
    cancelBtn.textContent = "cancel";
    cancelBtn.onclick = () => loadAllPrompts();
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-dark";
    saveBtn.textContent = "save";
    saveBtn.onclick = async () => {
        const newName = nameInput.value.trim();
        if (!newName) return;
        await fetch(`/api/prompts/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: newName, content: contentArea.value }),
        });
        loadAllPrompts();
    };
    actions.appendChild(saveBtn);

    item.appendChild(actions);
    nameInput.focus();
}

async function addPrompt(category) {
    const nameEl = document.getElementById(category === "backrooms" ? "new-backrooms-prompt-name" : "new-prompt-name");
    const contentEl = document.getElementById(category === "backrooms" ? "new-backrooms-prompt-content" : "new-prompt-content");
    const name = nameEl.value.trim();
    const content = contentEl.value;
    if (!name) return;

    await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content, category }),
    });
    toggleAddForm(category, false);
    loadAllPrompts();
}

// ---------------------------------------------------------------------------
// Seat suffixes — saved via the settings API
// ---------------------------------------------------------------------------
async function saveSuffixes() {
    const suffix1 = document.getElementById("seat-1-suffix")?.value || "";
    const suffix2 = document.getElementById("seat-2-suffix")?.value || "";
    const statusEl = document.getElementById("suffix-save-status");
    await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            backrooms_seat_1_suffix: suffix1,
            backrooms_seat_2_suffix: suffix2,
        }),
    });
    if (statusEl) {
        statusEl.textContent = "saved";
        setTimeout(() => { statusEl.textContent = ""; }, 2000);
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
form.addEventListener("submit", saveSettings);

// Collapsible add-form toggles
document.getElementById("add-prompt-btn").onclick = () => toggleAddForm("chat", true);
document.getElementById("add-backrooms-prompt-btn").onclick = () => toggleAddForm("backrooms", true);

// Save/cancel buttons inside the collapsible forms (via data attributes)
document.querySelectorAll("[data-save]").forEach(btn => {
    btn.onclick = () => addPrompt(btn.dataset.save);
});
document.querySelectorAll("[data-cancel]").forEach(btn => {
    btn.onclick = () => toggleAddForm(btn.dataset.cancel, false);
});

document.getElementById("save-suffixes-btn").onclick = saveSuffixes;
Promise.all([loadModels(), loadUniversalPromptOptions(), loadAllPrompts()]).then(loadSettings);
