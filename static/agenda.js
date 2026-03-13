/**
 * Agenda view — renders a chronological timeline of Google Calendar events
 * interleaved with tasks on the right side of the tasks page.
 *
 * Fetches events from /api/calendar/events and tasks from /api/tasks,
 * merges them by time, and renders day-by-day with a current-time marker.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let agendaStartDate = new Date();
let agendaRangeDays = 7;
let agendaEvents = [];
let agendaTasks = [];
let calendarConnected = false;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function calApi(method, path, body) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return res.json();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function initAgenda() {
    agendaStartDate = _todayMidnight();

    // Check connection status
    const status = await calApi("GET", "/api/calendar/status");
    calendarConnected = status.connected;
    renderAgendaStatus(status);

    // Set up controls
    setupAgendaControls();

    // Load data
    await loadAgenda();

    // Refresh every 5 minutes
    setInterval(loadAgenda, 5 * 60 * 1000);
}

function setupAgendaControls() {
    document.getElementById("agenda-prev").addEventListener("click", () => {
        agendaStartDate.setDate(agendaStartDate.getDate() - agendaRangeDays);
        loadAgenda();
    });
    document.getElementById("agenda-next").addEventListener("click", () => {
        agendaStartDate.setDate(agendaStartDate.getDate() + agendaRangeDays);
        loadAgenda();
    });
    document.getElementById("agenda-today").addEventListener("click", () => {
        agendaStartDate = _todayMidnight();
        loadAgenda();
    });
    document.getElementById("agenda-range").addEventListener("change", (e) => {
        agendaRangeDays = parseInt(e.target.value);
        loadAgenda();
    });
}

// ---------------------------------------------------------------------------
// Status bar — connect / disconnect
// ---------------------------------------------------------------------------
function renderAgendaStatus(status) {
    const el = document.getElementById("agenda-status");
    if (!status.configured) {
        el.innerHTML = `<div style="font-size:0.7rem;color:#888;">
            add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env to enable
        </div>`;
        return;
    }
    if (!status.connected) {
        el.innerHTML = `<button class="btn-dark agenda-connect-btn" id="gcal-connect-btn">connect google calendar</button>`;
        document.getElementById("gcal-connect-btn").addEventListener("click", () => {
            window.location.href = "/api/calendar/auth";
        });
        return;
    }
    el.innerHTML = `<div class="agenda-connected">
        <span>google calendar connected</span>
        <button class="text-btn" id="gcal-disconnect-btn">disconnect</button>
    </div>`;
    document.getElementById("gcal-disconnect-btn").addEventListener("click", async () => {
        await calApi("POST", "/api/calendar/disconnect");
        calendarConnected = false;
        const s = await calApi("GET", "/api/calendar/status");
        renderAgendaStatus(s);
        loadAgenda();
    });
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
async function loadAgenda() {
    const start = agendaStartDate.toISOString();
    const endDate = new Date(agendaStartDate);
    endDate.setDate(endDate.getDate() + agendaRangeDays);
    const end = endDate.toISOString();

    // Fetch events and tasks in parallel
    const [eventsRes, tasksRes] = await Promise.all([
        calApi("GET", `/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&refresh=true`),
        calApi("GET", "/api/tasks"),
    ]);

    agendaEvents = (eventsRes.events || []);
    agendaTasks = tasksRes.filter(t => t.status !== "completed" && t.status !== "deleted");

    renderAgenda();
}

// ---------------------------------------------------------------------------
// Render timeline
// ---------------------------------------------------------------------------
function renderAgenda() {
    const container = document.getElementById("agenda-timeline");
    container.innerHTML = "";

    const now = new Date();

    // Build day-by-day view
    for (let d = 0; d < agendaRangeDays; d++) {
        const dayDate = new Date(agendaStartDate);
        dayDate.setDate(dayDate.getDate() + d);
        const dayStr = _formatDateKey(dayDate);
        const isToday = dayStr === _formatDateKey(now);

        const dayEl = document.createElement("div");
        dayEl.className = "agenda-day";

        // Day header
        const header = document.createElement("div");
        header.className = "agenda-day-header" + (isToday ? " is-today" : "");
        header.textContent = _formatDayHeader(dayDate, isToday);
        dayEl.appendChild(header);

        // Collect items for this day
        const items = _getItemsForDay(dayDate, dayStr);

        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "agenda-empty-day";
            empty.textContent = "nothing scheduled";
            dayEl.appendChild(empty);
        } else {
            const itemsEl = document.createElement("div");
            itemsEl.className = "agenda-items";

            let nowMarkerInserted = false;
            for (const item of items) {
                // Insert now marker at the right position on today
                if (isToday && !nowMarkerInserted && item._sortTime) {
                    const nowMins = now.getHours() * 60 + now.getMinutes();
                    if (item._sortTime >= nowMins) {
                        itemsEl.appendChild(_createNowMarker(now));
                        nowMarkerInserted = true;
                    }
                }
                itemsEl.appendChild(_createAgendaItem(item));
            }

            // Insert now marker at the end if we haven't yet (and it's today)
            if (isToday && !nowMarkerInserted) {
                itemsEl.appendChild(_createNowMarker(now));
            }

            dayEl.appendChild(itemsEl);
        }

        container.appendChild(dayEl);
    }
}

// ---------------------------------------------------------------------------
// Collect and sort items for a given day
// ---------------------------------------------------------------------------
function _getItemsForDay(dayDate, dayStr) {
    const items = [];

    // Events for this day
    for (const ev of agendaEvents) {
        const evStartStr = ev.start_time || "";
        const evDate = evStartStr.slice(0, 10);
        if (evDate !== dayStr) continue;

        const isAllDay = ev.all_day;
        let startMins = 0;
        if (!isAllDay && evStartStr.length > 10) {
            const t = new Date(evStartStr);
            startMins = t.getHours() * 60 + t.getMinutes();
        }

        items.push({
            type: "event",
            title: ev.summary || "(No title)",
            startTime: isAllDay ? null : evStartStr,
            endTime: isAllDay ? null : (ev.end_time || ""),
            allDay: isAllDay,
            location: ev.location,
            calendarName: ev.calendar_name,
            color: ev.color,
            _sortTime: isAllDay ? -1 : startMins,
        });
    }

    // Tasks with due dates on this day
    for (const task of agendaTasks) {
        if (!task.due) continue;
        const taskDate = task.due.slice(0, 10);
        if (taskDate !== dayStr) continue;

        let dueMins = 1440; // end of day default
        if (task.due.length > 10) {
            const t = new Date(task.due);
            const hrs = t.getHours();
            const mins = t.getMinutes();
            if (hrs !== 0 || mins !== 0) {
                dueMins = hrs * 60 + mins;
            }
        }

        const now = new Date();
        items.push({
            type: "task",
            title: task.title,
            taskId: task.id,
            dueTime: task.due,
            priority: task.priority,
            project: task.project,
            tags: task.tags || [],
            overdue: new Date(task.due) < now,
            _sortTime: dueMins,
        });
    }

    // Tasks without due dates: show on today only, at the bottom
    if (dayStr === _formatDateKey(new Date())) {
        for (const task of agendaTasks) {
            if (task.due) continue;
            items.push({
                type: "task",
                title: task.title,
                taskId: task.id,
                priority: task.priority,
                project: task.project,
                tags: task.tags || [],
                overdue: false,
                _sortTime: 9999, // float to bottom
            });
        }
    }

    // Sort: all-day first, then by time
    items.sort((a, b) => a._sortTime - b._sortTime);
    return items;
}

// ---------------------------------------------------------------------------
// Create DOM elements
// ---------------------------------------------------------------------------
function _createAgendaItem(item) {
    const el = document.createElement("div");

    if (item.type === "event") {
        el.className = "agenda-item event" + (item.allDay ? " all-day" : "");

        const time = document.createElement("div");
        time.className = "agenda-time";
        time.textContent = item.allDay ? "all day" : _formatTime(item.startTime);

        const indicator = document.createElement("div");
        indicator.className = "agenda-indicator";
        if (item.color) indicator.style.background = item.color;

        const content = document.createElement("div");
        content.className = "agenda-item-content";

        const title = document.createElement("div");
        title.className = "agenda-item-title";
        // Calendar color dot before title
        if (item.color) {
            title.innerHTML = `<span class="agenda-cal-dot" style="background:${_escHtml(item.color)}"></span>${_escHtml(item.title)}`;
        } else {
            title.textContent = item.title;
        }

        content.appendChild(title);

        // Meta: end time, location, calendar name
        const metaParts = [];
        if (!item.allDay && item.endTime) {
            metaParts.push(`until ${_formatTime(item.endTime)}`);
        }
        if (item.location) metaParts.push(item.location);
        if (item.calendarName) metaParts.push(item.calendarName);
        if (metaParts.length) {
            const meta = document.createElement("div");
            meta.className = "agenda-item-meta";
            meta.textContent = metaParts.join(" · ");
            content.appendChild(meta);
        }

        el.appendChild(time);
        el.appendChild(indicator);
        el.appendChild(content);

    } else {
        // Task
        el.className = "agenda-item task" + (item.overdue ? " overdue" : "");

        const time = document.createElement("div");
        time.className = "agenda-time";
        if (item.dueTime && item.dueTime.length > 10) {
            const t = new Date(item.dueTime);
            if (t.getHours() !== 0 || t.getMinutes() !== 0) {
                time.textContent = _formatTime(item.dueTime);
            }
        }

        const indicator = document.createElement("div");
        indicator.className = "agenda-indicator";

        const content = document.createElement("div");
        content.className = "agenda-item-content";

        const title = document.createElement("div");
        title.className = "agenda-item-title";
        title.textContent = item.title;
        content.appendChild(title);

        const metaParts = [];
        if (item.project) metaParts.push(item.project);
        if (item.priority) metaParts.push(`P:${item.priority}`);
        if (item.tags && item.tags.length) metaParts.push(item.tags.map(t => `#${t}`).join(" "));
        if (metaParts.length) {
            const meta = document.createElement("div");
            meta.className = "agenda-item-meta";
            meta.textContent = metaParts.join(" · ");
            content.appendChild(meta);
        }

        el.appendChild(time);
        el.appendChild(indicator);
        el.appendChild(content);
    }

    return el;
}

function _createNowMarker(now) {
    const el = document.createElement("div");
    el.className = "agenda-now-marker";
    el.innerHTML = `
        <span class="agenda-now-dot"></span>
        <span class="agenda-now-line"></span>
        <span class="agenda-now-time">${_pad(now.getHours())}:${_pad(now.getMinutes())}</span>
    `;
    return el;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function _todayMidnight() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function _formatDateKey(date) {
    // YYYY-MM-DD in local time
    const y = date.getFullYear();
    const m = _pad(date.getMonth() + 1);
    const d = _pad(date.getDate());
    return `${y}-${m}-${d}`;
}

function _formatDayHeader(date, isToday) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayName = days[date.getDay()];
    const monthName = months[date.getMonth()];
    const prefix = isToday ? "Today — " : "";
    return `${prefix}${dayName} ${monthName} ${date.getDate()}`;
}

function _formatTime(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return `${_pad(d.getHours())}:${_pad(d.getMinutes())}`;
}

function _pad(n) {
    return String(n).padStart(2, "0");
}

function _escHtml(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", initAgenda);
