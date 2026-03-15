/**
 * Column4Manager — manages pluggable panels in column 4.
 *
 * Fetches panel declarations from /api/plugins/panels, renders a tab bar
 * when multiple panels exist, lazy-loads panel JS modules via dynamic
 * import(), and calls render(container, ctx) / destroy() lifecycle hooks.
 *
 * Usage in app.js:
 *   const col4 = new Column4Manager(containerEl, ctx);
 *   await col4.init();
 *
 * ctx must provide: api, loadAllTags, loadContext, getConversationId
 */

class Column4Manager {
    constructor(containerEl, ctx) {
        this._container = containerEl;
        this._ctx = ctx;
        this._panels = [];       // panel declarations from API
        this._modules = {};      // cached loaded modules by name
        this._activePanel = null; // currently active panel name
        this._tabBar = null;
        this._contentEl = null;
    }

    async init() {
        // Build internal structure: tab bar + panel area
        // Panel area is a flex-growing wrapper — the panel module creates
        // its own internal layout (e.g., scrollable content + fixed input).
        this._container.innerHTML = "";

        this._tabBar = document.createElement("div");
        this._tabBar.className = "column4-tabs";
        this._container.appendChild(this._tabBar);

        this._contentEl = document.createElement("div");
        this._contentEl.className = "column4-panel-area";
        this._container.appendChild(this._contentEl);

        // Fetch panel declarations
        try {
            this._panels = await this._ctx.api("/plugins/panels");
        } catch (e) {
            this._panels = [];
        }

        // Render tabs (hidden if only one panel)
        this._renderTabs();

        // Activate default panel
        if (this._panels.length > 0) {
            await this._activate(this._panels[0].name);
        }
    }

    _renderTabs() {
        this._tabBar.innerHTML = "";
        if (this._panels.length <= 1) {
            // Single panel — show label only, no tabs
            if (this._panels.length === 1) {
                const label = document.createElement("span");
                label.className = "section-label";
                label.style.marginBottom = "0";
                label.textContent = this._panels[0].label;
                this._tabBar.appendChild(label);
            }
            return;
        }
        for (const panel of this._panels) {
            const btn = document.createElement("button");
            btn.className = "column4-tab";
            btn.textContent = panel.label;
            btn.dataset.panel = panel.name;
            btn.onclick = () => this._activate(panel.name);
            this._tabBar.appendChild(btn);
        }
        this._updateTabHighlight();
    }

    _updateTabHighlight() {
        for (const btn of this._tabBar.querySelectorAll(".column4-tab")) {
            btn.classList.toggle("active", btn.dataset.panel === this._activePanel);
        }
    }

    async _activate(name) {
        // Deactivate current panel
        if (this._activePanel && this._modules[this._activePanel]) {
            try { this._modules[this._activePanel].destroy(); } catch (e) {}
        }

        this._activePanel = name;
        this._updateTabHighlight();
        this._contentEl.innerHTML = "";

        // Load module if not cached
        if (!this._modules[name]) {
            const panel = this._panels.find(p => p.name === name);
            if (!panel || !panel.js_module) return;
            try {
                this._modules[name] = await import(panel.js_module);
            } catch (e) {
                console.error(`Failed to load panel module: ${panel.js_module}`, e);
                this._contentEl.textContent = `Failed to load ${name} panel.`;
                return;
            }
        }

        // Render
        const mod = this._modules[name];
        if (mod.render) {
            mod.render(this._contentEl, this._ctx);
        }
    }

    /** Get the currently active panel name. */
    get activePanel() {
        return this._activePanel;
    }

    /** Switch to a panel by name. */
    async switchTo(name) {
        if (this._panels.find(p => p.name === name)) {
            await this._activate(name);
        }
    }
}
