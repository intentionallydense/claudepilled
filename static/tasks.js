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

    const projectSelect = document.getElementById("project-filter");
    const tagSelect = document.getElementById("tag-filter");

    // Rebuild project options
    projectSelect.innerHTML = '<option value="">project</option>';
    projects.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        if (p === currentProject) opt.selected = true;
        projectSelect.appendChild(opt);
    });

    // Rebuild tag options
    tagSelect.innerHTML = '<option value="">tag</option>';
    tags.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = `#${t}`;
        if (t === currentTag) opt.selected = true;
        tagSelect.appendChild(opt);
    });
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
            ${renderAnnotations(task.annotations || [])}
            <div class="task-actions">
                ${!isCompleted ? `<button class="text-btn" data-action="complete">complete</button>` : ""}
                ${task.status === "pending" ? `<button class="text-btn" data-action="start">start</button>` : ""}
                ${task.status === "active" ? `<button class="text-btn" data-action="stop">stop</button>` : ""}
                <button class="text-btn" data-action="annotate">annotate</button>
                <button class="text-btn danger" data-action="delete">delete</button>
            </div>
            <div class="annotate-form" style="display:none;">
                <input class="form-input" placeholder="add a note..." />
                <button class="text-btn" data-action="save-annotation">save</button>
            </div>
        </div>
    `;

    // Toggle expand on click
    li.querySelector(".task-row").addEventListener("click", () => {
        expandedTaskId = expandedTaskId === task.id ? null : task.id;
        renderTasks();
    });

    // Action buttons
    li.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", e => {
            e.stopPropagation();
            handleAction(btn.dataset.action, task, li);
        });
    });

    return li;
}

function renderAnnotations(annotations) {
    if (!annotations || annotations.length === 0) return "";
    const items = annotations.map(a =>
        `<div class="annotation">
            <span class="annotation-time">${formatTime(a.timestamp)}</span>
            ${esc(a.text)}
        </div>`
    ).join("");
    return `<div class="task-annotations">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function handleAction(action, task, li) {
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
    }
}

// ---------------------------------------------------------------------------
// Add task form
// ---------------------------------------------------------------------------
function setupAddForm() {
    const addBtn = document.getElementById("add-task-btn");
    const form = document.getElementById("add-form");
    const saveBtn = document.getElementById("save-task-btn");
    const cancelBtn = document.getElementById("cancel-task-btn");

    addBtn.addEventListener("click", () => {
        form.style.display = form.style.display === "none" ? "block" : "none";
        if (form.style.display === "block") {
            document.getElementById("new-title").focus();
        }
    });

    cancelBtn.addEventListener("click", () => {
        form.style.display = "none";
        clearForm();
    });

    saveBtn.addEventListener("click", async () => {
        const title = document.getElementById("new-title").value.trim();
        if (!title) return;

        const body = { title };
        const desc = document.getElementById("new-description").value.trim();
        const priority = document.getElementById("new-priority").value;
        const project = document.getElementById("new-project").value.trim();
        const tags = document.getElementById("new-tags").value.trim();
        const due = document.getElementById("new-due").value;

        if (desc) body.description = desc;
        if (priority) body.priority = priority;
        if (project) body.project = project;
        if (tags) body.tags = tags.split(",").map(t => t.trim()).filter(Boolean);
        if (due) body.due = new Date(due).toISOString();

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
    document.getElementById("new-project").value = "";
    document.getElementById("new-tags").value = "";
    document.getElementById("new-due").value = "";
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
        const conv = await api("POST", "/api/conversations", {
            title: "Brain dump",
            prompt_id: "brain_dump",
        });
        window.location.href = `/?c=${conv.id}`;
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
