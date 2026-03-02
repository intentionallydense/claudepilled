/**
 * Task list page — fetches tasks from /api/tasks, renders sorted by urgency,
 * handles CRUD actions inline. Brain dump redirects to chat with a special mode.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allTasks = [];
let completedTasks = [];
let currentFilter = "all";
let currentProject = "";
let currentTag = "";
let expandedTaskId = null;
let completedVisible = false;
let knownProjects = [];
let knownTags = [];

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return res.json();
}

// ---------------------------------------------------------------------------
// Load & render
// ---------------------------------------------------------------------------
async function loadTasks() {
    const params = new URLSearchParams();
    if (currentProject) params.set("project", currentProject);
    if (currentTag) params.set("tag", currentTag);
    if (currentFilter === "active") params.set("status", "active");
    if (currentFilter === "waiting") params.set("include_waiting", "true");

    const tasks = await api("GET", `/api/tasks?${params}`);
    allTasks = tasks.filter(t => t.status !== "completed");
    completedTasks = tasks.filter(t => t.status === "completed");

    // If not filtering by status, also fetch completed separately
    if (currentFilter !== "active") {
        const completed = await api("GET", "/api/tasks?status=completed");
        completedTasks = completed;
    }

    renderTasks();
    await loadFilters();
}

async function loadFilters() {
    const [projects, tags] = await Promise.all([
        api("GET", "/api/tasks/projects"),
        api("GET", "/api/tasks/tags"),
    ]);
    knownProjects = projects;
    knownTags = tags;

    const projectSelect = document.getElementById("project-filter");
    const tagSelect = document.getElementById("tag-filter");

    // Rebuild filter dropdowns
    projectSelect.innerHTML = '<option value="">project</option>';
    projects.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        if (p === currentProject) opt.selected = true;
        projectSelect.appendChild(opt);
    });

    tagSelect.innerHTML = '<option value="">tag</option>';
    tags.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = `#${t}`;
        if (t === currentTag) opt.selected = true;
        tagSelect.appendChild(opt);
    });

    // Rebuild add-form project dropdown
    const newProjectSel = document.getElementById("new-project");
    if (newProjectSel) {
        newProjectSel.innerHTML = '<option value="">project</option>';
        projects.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            newProjectSel.appendChild(opt);
        });
        const newOpt = document.createElement("option");
        newOpt.value = "__new__";
        newOpt.textContent = "+ new project";
        newProjectSel.appendChild(newOpt);
    }

}

function renderTasks() {
    const list = document.getElementById("task-list");
    const empty = document.getElementById("empty-state");
    const compSection = document.getElementById("completed-section");
    const compList = document.getElementById("completed-list");

    list.innerHTML = "";

    // Filter waiting tasks out unless filter is "waiting"
    let visible = allTasks;
    if (currentFilter === "waiting") {
        // Show everything including waiting
    }

    if (visible.length === 0 && completedTasks.length === 0) {
        empty.style.display = "block";
    } else {
        empty.style.display = "none";
    }

    visible.forEach(task => list.appendChild(createTaskItem(task)));

    // Completed section
    if (completedTasks.length > 0) {
        compSection.style.display = "block";
        compList.innerHTML = "";
        completedTasks.forEach(task => compList.appendChild(createTaskItem(task, true)));
        compList.style.display = completedVisible ? "block" : "none";
    } else {
        compSection.style.display = "none";
    }
}

// ---------------------------------------------------------------------------
// Task item rendering
// ---------------------------------------------------------------------------
function createTaskItem(task, isCompleted = false) {
    const li = document.createElement("li");
    li.className = "task-item" + (isCompleted ? " completed" : "");
    if (task.id === expandedTaskId) li.className += " expanded";

    const urgency = task.urgency || 0;
    const barClass = urgency >= 12 ? "high" : urgency >= 5 ? "medium" : "low";

    li.innerHTML = `
        <div class="task-row">
            <div class="urgency-bar ${barClass}"></div>
            <div class="task-main">
                <div class="task-title-row">
                    <span class="task-title">${esc(task.title)}</span>
                    <span class="task-urgency">${urgency.toFixed(1)}</span>
                </div>
                <div class="task-meta">
                    ${task.project ? `<span>project:${esc(task.project)}</span>` : ""}
                    ${task.priority ? `<span>priority:${task.priority}</span>` : ""}
                    ${task.due ? `<span class="task-due ${dueClass(task.due)}">${formatDue(task.due)}</span>` : ""}
                    ${(task.tags || []).map(t => `<span class="task-tag">#${esc(t)}</span>`).join("")}
                    ${task.status === "active" ? '<span style="color:#e8a838">active</span>' : ""}
                </div>
            </div>
        </div>
        <div class="task-detail">
            ${task.description ? `<div class="task-description">${esc(task.description)}</div>` : ""}
            ${renderAnnotations(task.annotations || [], task.id)}
            <div class="task-actions">
                ${!isCompleted ? `<button class="text-btn" data-action="complete">complete</button>` : ""}
                ${task.status === "pending" ? `<button class="text-btn" data-action="start">start</button>` : ""}
                ${task.status === "active" ? `<button class="text-btn" data-action="stop">stop</button>` : ""}
                <button class="text-btn" data-action="edit">edit</button>
                <button class="text-btn" data-action="annotate">annotate</button>
                <button class="text-btn danger" data-action="delete">delete</button>
            </div>
            <div class="annotate-form" style="display:none;">
                <input class="form-input" placeholder="add a note..." />
                <button class="text-btn" data-action="save-annotation">save</button>
            </div>
            <div class="edit-task-form" style="display:none;"></div>
        </div>
    `;

    // Toggle expand on click
    li.querySelector(".task-row").addEventListener("click", () => {
        expandedTaskId = expandedTaskId === task.id ? null : task.id;
        renderTasks();
    });

    // Action buttons — pass the button element for actions that need data-index
    li.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            handleAction(btn.dataset.action, task, li, btn);
        });
    });

    return li;
}

function renderAnnotations(annotations, taskId) {
    if (!annotations || annotations.length === 0) return "";
    const items = annotations.map((a, i) =>
        `<div class="annotation" data-index="${i}">
            <span class="annotation-time">${formatTime(a.timestamp)}</span>
            <span class="annotation-text">${esc(a.text)}</span>
            <button class="text-btn annotation-edit-btn" data-action="edit-annotation" data-index="${i}">edit</button>
            <button class="text-btn danger annotation-delete-btn" data-action="delete-annotation" data-index="${i}">×</button>
        </div>`
    ).join("");
    return `<div class="task-annotations">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function handleAction(action, task, li, btn) {
    if (action === "complete") {
        await api("POST", `/api/tasks/${task.id}/complete`);
        loadTasks();
    } else if (action === "start") {
        await api("POST", `/api/tasks/${task.id}/start`);
        loadTasks();
    } else if (action === "stop") {
        await api("POST", `/api/tasks/${task.id}/stop`);
        loadTasks();
    } else if (action === "delete") {
        await api("DELETE", `/api/tasks/${task.id}`);
        loadTasks();
    } else if (action === "annotate") {
        const form = li.querySelector(".annotate-form");
        form.style.display = form.style.display === "none" ? "flex" : "none";
        if (form.style.display === "flex") form.querySelector("input").focus();
    } else if (action === "save-annotation") {
        const input = li.querySelector(".annotate-form input");
        const text = input.value.trim();
        if (!text) return;
        await api("POST", `/api/tasks/${task.id}/annotate`, { text });
        loadTasks();
    } else if (action === "edit-annotation") {
        const index = btn.dataset.index;
        const annDiv = btn.closest(".annotation");
        const textSpan = annDiv.querySelector(".annotation-text");
        const oldText = textSpan.textContent;

        // Replace text span with inline edit input
        const input = document.createElement("input");
        input.className = "form-input";
        input.value = oldText;
        input.style.flex = "1";
        textSpan.replaceWith(input);
        input.focus();

        // Replace edit button with save button
        const saveBtn = document.createElement("button");
        saveBtn.className = "text-btn";
        saveBtn.textContent = "save";
        btn.replaceWith(saveBtn);

        saveBtn.addEventListener("click", async () => {
            const newText = input.value.trim();
            if (newText && newText !== oldText) {
                await api("PATCH", `/api/tasks/${task.id}/annotations/${index}`, { text: newText });
            }
            loadTasks();
        });

        input.addEventListener("keydown", e => {
            if (e.key === "Enter") saveBtn.click();
            if (e.key === "Escape") loadTasks();
        });
    } else if (action === "delete-annotation") {
        const index = btn.dataset.index;
        await api("DELETE", `/api/tasks/${task.id}/annotations/${index}`);
        loadTasks();
    } else if (action === "edit") {
        showEditForm(task, li);
    }
}

function showEditForm(task, li) {
    const container = li.querySelector(".edit-task-form");
    if (container.style.display !== "none") {
        container.style.display = "none";
        container.innerHTML = "";
        return;
    }

    // Build project options
    let projectOptions = '<option value="">none</option>';
    knownProjects.forEach(p => {
        projectOptions += `<option value="${esc(p)}" ${task.project === p ? "selected" : ""}>${esc(p)}</option>`;
    });
    if (task.project && !knownProjects.includes(task.project)) {
        projectOptions += `<option value="${esc(task.project)}" selected>${esc(task.project)}</option>`;
    }
    projectOptions += '<option value="__new__">+ new project</option>';

    const dueVal = task.due ? toDateValue(task.due) : "";
    const timeVal = task.due ? toTimeValue(task.due) : "";

    container.innerHTML = `
        <div class="task-form" style="margin-top:0.5rem;">
            <div class="form-row">
                <input class="form-input edit-title" value="${esc(task.title)}" />
                <select class="form-select edit-priority">
                    <option value="">priority</option>
                    <option value="H" ${task.priority === "H" ? "selected" : ""}>high</option>
                    <option value="M" ${task.priority === "M" ? "selected" : ""}>medium</option>
                    <option value="L" ${task.priority === "L" ? "selected" : ""}>low</option>
                </select>
            </div>
            <textarea class="form-textarea edit-description" rows="2">${esc(task.description || "")}</textarea>
            <div class="form-row">
                <select class="form-select edit-project">${projectOptions}</select>
                <input class="form-input edit-project-custom" placeholder="new project name..." style="display:none;" />
                <div class="tag-picker edit-tag-picker">
                    <div class="tag-chips edit-tag-chips"></div>
                    <input class="tag-search-input edit-tag-input" placeholder="tags..." autocomplete="off" />
                    <div class="tag-dropdown edit-tag-dropdown"></div>
                </div>
                <input class="form-input edit-due" type="date" value="${dueVal}" />
                <input class="form-input edit-due-time" type="time" value="${timeVal}" />
            </div>
            <div class="form-actions">
                <button class="btn-dark edit-save-btn">save</button>
                <button class="text-btn edit-cancel-btn">cancel</button>
            </div>
        </div>
    `;
    container.style.display = "block";

    // Init tag picker for edit form, pre-populated with task's tags
    const editTagPicker = createTagPicker(
        container.querySelector(".edit-tag-chips"),
        container.querySelector(".edit-tag-input"),
        container.querySelector(".edit-tag-dropdown"),
    );
    editTagPicker.setTags(task.tags || []);

    // Show custom project input when "+ new" selected
    const projSel = container.querySelector(".edit-project");
    const projCustom = container.querySelector(".edit-project-custom");
    projSel.addEventListener("change", () => {
        if (projSel.value === "__new__") {
            projCustom.style.display = "";
            projCustom.focus();
        } else {
            projCustom.style.display = "none";
        }
    });

    container.querySelector(".edit-cancel-btn").onclick = () => {
        container.style.display = "none";
        container.innerHTML = "";
    };

    container.querySelector(".edit-save-btn").onclick = async () => {
        const updates = {};
        const title = container.querySelector(".edit-title").value.trim();
        const desc = container.querySelector(".edit-description").value.trim();
        const priority = container.querySelector(".edit-priority").value;
        const dueDate = container.querySelector(".edit-due").value;
        const dueTime = container.querySelector(".edit-due-time").value;

        let project = projSel.value;
        if (project === "__new__") project = projCustom.value.trim();

        const tags = editTagPicker.getSelectedTags();

        if (title !== task.title) updates.title = title;
        if (desc !== (task.description || "")) updates.description = desc;
        if (priority !== (task.priority || "")) updates.priority = priority || null;
        if (project !== (task.project || "")) updates.project = project || null;
        if (dueDate) {
            updates.due = dueTime ? `${dueDate}T${dueTime}` : dueDate;
        } else if (task.due) {
            updates.due = null;
        }
        // Always send tags to handle removals
        updates.tags = tags;

        if (Object.keys(updates).length > 0) {
            await api("PATCH", `/api/tasks/${task.id}`, updates);
        }
        loadTasks();
    };
}

function toDateValue(isoStr) {
    // Convert ISO string to date input value (YYYY-MM-DD)
    try {
        const d = new Date(isoStr);
        const pad = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } catch (e) { return ""; }
}

function toTimeValue(isoStr) {
    // Extract time from ISO string (HH:MM) — returns "" if midnight (date-only due)
    try {
        const d = new Date(isoStr);
        if (d.getHours() === 0 && d.getMinutes() === 0) return "";
        const pad = n => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (e) { return ""; }
}

// ---------------------------------------------------------------------------
// Tag picker — search-to-select with chips
// ---------------------------------------------------------------------------
function createTagPicker(chipsEl, inputEl, dropdownEl) {
    let selected = new Set();

    function renderChips() {
        chipsEl.innerHTML = "";
        for (const tag of selected) {
            const chip = document.createElement("span");
            chip.className = "tag-chip";
            chip.innerHTML = `#${esc(tag)} <span class="tag-chip-remove">\u00d7</span>`;
            chip.querySelector(".tag-chip-remove").addEventListener("click", e => {
                e.stopPropagation();
                selected.delete(tag);
                renderChips();
            });
            chipsEl.appendChild(chip);
        }
    }

    function showDropdown() {
        const query = inputEl.value.trim().toLowerCase();
        const matches = knownTags.filter(t =>
            !selected.has(t) && t.toLowerCase().includes(query)
        );

        dropdownEl.innerHTML = "";
        matches.forEach(t => {
            const item = document.createElement("div");
            item.className = "tag-dropdown-item";
            item.textContent = `#${t}`;
            item.addEventListener("click", () => {
                selected.add(t);
                inputEl.value = "";
                renderChips();
                hideDropdown();
            });
            dropdownEl.appendChild(item);
        });

        // Offer to create new tag if query doesn't match existing
        if (query && !knownTags.includes(query) && !selected.has(query)) {
            const item = document.createElement("div");
            item.className = "tag-dropdown-item create-new";
            item.textContent = `+ create "${query}"`;
            item.addEventListener("click", () => {
                selected.add(query);
                inputEl.value = "";
                renderChips();
                hideDropdown();
            });
            dropdownEl.appendChild(item);
        }

        dropdownEl.classList.toggle("visible", dropdownEl.children.length > 0);
    }

    function hideDropdown() {
        dropdownEl.classList.remove("visible");
    }

    inputEl.addEventListener("input", showDropdown);
    inputEl.addEventListener("focus", showDropdown);
    inputEl.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            const query = inputEl.value.trim();
            if (query) {
                selected.add(query);
                inputEl.value = "";
                renderChips();
                hideDropdown();
            }
        }
        if (e.key === "Backspace" && !inputEl.value && selected.size > 0) {
            const tags = [...selected];
            selected.delete(tags[tags.length - 1]);
            renderChips();
        }
    });

    // Hide dropdown when clicking outside the picker
    document.addEventListener("click", e => {
        if (!chipsEl.closest(".tag-picker").contains(e.target)) {
            hideDropdown();
        }
    });

    return {
        getSelectedTags: () => [...selected],
        setTags: (tags) => { selected = new Set(tags); renderChips(); },
        clear: () => { selected.clear(); renderChips(); inputEl.value = ""; },
    };
}

// Persistent tag picker instance for the add form
let addFormTagPicker = null;

// ---------------------------------------------------------------------------
// Add task form
// ---------------------------------------------------------------------------
function setupAddForm() {
    const addBtn = document.getElementById("add-task-btn");
    const form = document.getElementById("add-form");
    const saveBtn = document.getElementById("save-task-btn");
    const cancelBtn = document.getElementById("cancel-task-btn");
    const projectSel = document.getElementById("new-project");
    const projectCustom = document.getElementById("new-project-custom");
    const prioritySel = document.getElementById("new-priority");

    // Init tag picker for add form
    addFormTagPicker = createTagPicker(
        document.getElementById("new-tag-chips"),
        document.getElementById("new-tag-input"),
        document.getElementById("new-tag-dropdown"),
    );

    addBtn.addEventListener("click", () => {
        form.style.display = form.style.display === "none" ? "block" : "none";
        if (form.style.display === "block") {
            document.getElementById("new-title").focus();
        }
    });

    // Show custom input when "+ new project" is selected
    projectSel.addEventListener("change", () => {
        if (projectSel.value === "__new__") {
            projectCustom.style.display = "";
            projectCustom.focus();
        } else {
            projectCustom.style.display = "none";
            projectCustom.value = "";
        }
    });

    // Clear required-missing indicator when priority is selected
    prioritySel.addEventListener("change", () => {
        prioritySel.classList.remove("required-missing");
    });

    cancelBtn.addEventListener("click", () => {
        form.style.display = "none";
        clearForm();
    });

    saveBtn.addEventListener("click", async () => {
        const title = document.getElementById("new-title").value.trim();
        if (!title) return;

        // Require priority
        const priority = prioritySel.value;
        if (!priority) {
            prioritySel.classList.add("required-missing");
            prioritySel.focus();
            return;
        }

        const body = { title, priority };
        const desc = document.getElementById("new-description").value.trim();
        const dueDate = document.getElementById("new-due").value;
        const dueTime = document.getElementById("new-due-time").value;

        // Project: use custom input if "+ new" was selected
        let project = projectSel.value;
        if (project === "__new__") project = projectCustom.value.trim();
        if (project === "") project = null;

        // Tags from tag picker
        const tags = addFormTagPicker.getSelectedTags();

        if (desc) body.description = desc;
        if (project) body.project = project;
        if (tags.length) body.tags = tags;
        if (dueDate) body.due = dueTime ? `${dueDate}T${dueTime}` : dueDate;

        await api("POST", "/api/tasks", body);
        form.style.display = "none";
        clearForm();
        loadTasks();
    });
}

function clearForm() {
    document.getElementById("new-title").value = "";
    document.getElementById("new-description").value = "";
    document.getElementById("new-priority").value = "";
    document.getElementById("new-priority").classList.remove("required-missing");
    document.getElementById("new-project").value = "";
    document.getElementById("new-project-custom").value = "";
    document.getElementById("new-project-custom").style.display = "none";
    if (addFormTagPicker) addFormTagPicker.clear();
    document.getElementById("new-due").value = "";
    document.getElementById("new-due-time").value = "";
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function setupFilters() {
    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentFilter = btn.dataset.filter;
            loadTasks();
        });
    });

    document.getElementById("project-filter").addEventListener("change", e => {
        currentProject = e.target.value;
        loadTasks();
    });

    document.getElementById("tag-filter").addEventListener("change", e => {
        currentTag = e.target.value;
        loadTasks();
    });
}

// ---------------------------------------------------------------------------
// Completed toggle
// ---------------------------------------------------------------------------
function setupCompleted() {
    document.getElementById("completed-toggle").addEventListener("click", () => {
        completedVisible = !completedVisible;
        const list = document.getElementById("completed-list");
        list.style.display = completedVisible ? "block" : "none";
    });
}

// ---------------------------------------------------------------------------
// Brain dump — redirects to chat with brain-dump mode
// ---------------------------------------------------------------------------
function setupBrainDump() {
    document.getElementById("brain-dump-btn").addEventListener("click", async () => {
        // Uses the seeded "Brain dump" prompt via the saved-prompt system
        // init=1 tells the chat page to trigger model-speaks-first
        const conv = await api("POST", "/api/conversations", {
            title: "Brain dump",
            prompt_id: "brain_dump",
        });
        window.location.href = `/?c=${conv.id}&init=1`;
    });
}

// ---------------------------------------------------------------------------
// Date formatting helpers
// ---------------------------------------------------------------------------
function formatDue(isoStr) {
    const due = new Date(isoStr);
    const now = new Date();
    const diffMs = due - now;
    const diffDays = Math.round(diffMs / 86400000);

    if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`;
    if (diffDays === -1) return "yesterday";
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "tomorrow";
    if (diffDays <= 7) return `in ${diffDays}d`;
    if (diffDays <= 14) return `in ${Math.round(diffDays / 7)}w`;
    return due.toLocaleDateString();
}

function dueClass(isoStr) {
    const diffMs = new Date(isoStr) - new Date();
    const diffDays = diffMs / 86400000;
    if (diffDays < 0) return "overdue";
    if (diffDays <= 2) return "soon";
    return "";
}

function formatTime(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function esc(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    setupAddForm();
    setupFilters();
    setupCompleted();
    setupBrainDump();
    loadTasks();
});
