// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------
const modelSelect = document.getElementById("default-model");
const systemPrompt = document.getElementById("default-system-prompt");
const form = document.getElementById("settings-form");
const saveStatus = document.getElementById("save-status");
const promptsList = document.getElementById("prompts-list");

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
    for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name} ($${m.input_cost}/$${m.output_cost})`;
        modelSelect.appendChild(opt);
    }
}

// ---------------------------------------------------------------------------
// Load current settings
// ---------------------------------------------------------------------------
async function loadSettings() {
    const res = await fetch("/api/settings");
    const settings = await res.json();
    if (settings.default_model) modelSelect.value = settings.default_model;
    if (settings.universal_prompt) systemPrompt.value = settings.universal_prompt;
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
            universal_prompt: systemPrompt.value,
        }),
    });
    saveStatus.textContent = "saved";
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
}

// ---------------------------------------------------------------------------
// Prompts library
// ---------------------------------------------------------------------------
async function loadPrompts() {
    const res = await fetch("/api/prompts");
    const prompts = await res.json();
    promptsList.innerHTML = "";
    if (prompts.length === 0) {
        promptsList.innerHTML = '<div class="prompts-empty">no saved prompts yet.</div>';
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
        editBtn.onclick = () => startPromptEdit(p.id, p);
        actions.appendChild(editBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "text-btn";
        delBtn.textContent = "delete";
        delBtn.onclick = async () => {
            await fetch(`/api/prompts/${p.id}`, { method: "DELETE" });
            loadPrompts();
        };
        actions.appendChild(delBtn);

        header.appendChild(actions);
        item.appendChild(header);

        const preview = document.createElement("div");
        preview.className = "prompt-preview";
        preview.textContent = p.content.substring(0, 120) + (p.content.length > 120 ? "..." : "");
        item.appendChild(preview);

        promptsList.appendChild(item);
    }
}

function startPromptEdit(id, prompt) {
    const item = promptsList.querySelector(`[data-id="${id}"]`);
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
    cancelBtn.onclick = () => loadPrompts();
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
        loadPrompts();
    };
    actions.appendChild(saveBtn);

    item.appendChild(actions);
    nameInput.focus();
}

async function addPrompt() {
    const nameEl = document.getElementById("new-prompt-name");
    const contentEl = document.getElementById("new-prompt-content");
    const name = nameEl.value.trim();
    const content = contentEl.value;
    if (!name) return;

    await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
    });
    nameEl.value = "";
    contentEl.value = "";
    loadPrompts();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
form.addEventListener("submit", saveSettings);
document.getElementById("add-prompt-btn").onclick = addPrompt;
loadModels().then(loadSettings);
loadPrompts();
