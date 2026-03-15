/**
 * Dynamic nav loader — fetches plugin nav entries from /api/plugins/nav
 * and inserts them into the <span id="plugin-nav"> placeholder.
 *
 * Each page includes core links (chat, backrooms, settings) inline and
 * a placeholder where plugin entries (tasks, briefing, etc.) appear.
 * Plugin links matching the current page are skipped.
 */
(function () {
    const placeholder = document.getElementById("plugin-nav");
    if (!placeholder) return;

    const currentPath = window.location.pathname;

    fetch("/api/plugins/nav")
        .then(r => r.json())
        .then(entries => {
            for (const entry of entries) {
                // Skip link to current page
                if (entry.href === currentPath || entry.href === currentPath + ".html") continue;
                const a = document.createElement("a");
                a.href = entry.href;
                a.className = "text-btn";
                a.textContent = entry.label.toLowerCase();
                placeholder.appendChild(a);
            }
        })
        .catch(() => {});  // Graceful degradation — core links still work
})();
