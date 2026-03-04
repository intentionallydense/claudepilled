// ---------------------------------------------------------------------------
// backrooms-adapter.js — Adapter that lets chat-core.js drive backrooms
// (N-model) sessions. Handles backrooms-specific streaming events, speaker
// labels, per-seat prompts, speed control, stats, and command notifications.
// Used by app.js when a backrooms conversation is opened.
//
// Relies on global utilities from chat-core.js: renderMarkdown,
// appendStreamingCursor, removeStreamingCursor, escapeHtml, compressImage.
// ---------------------------------------------------------------------------

const BackroomsAdapter = (function () {
    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------
    let sessionMeta = null; // { participants: [{seat, id, label, speaker}, ...] }
    let chatCoreRef = null;
    let statusEl = null;
    let modelNamesEl = null;
    let messagesEl = null;
    let savedPrompts = [];
    let currentSpeed = 1.0;
    let currentIterations = 1;
    let currentStepMode = false;
    let currentNextSpeaker = null;

    // Streaming state (adapter manages its own since turn_start/turn_end
    // don't map to chat-core's single-assistant-message lifecycle)
    let streamingEl = null;
    let streamingTextEl = null;
    let streamingRawText = "";
    let markdownRenderTimer = null;
    const MARKDOWN_DEBOUNCE_MS = 80;

    // -----------------------------------------------------------------------
    // Speaker helpers — generalized for N participants
    // -----------------------------------------------------------------------
    function getParticipants() {
        if (!sessionMeta) return [];
        // v2 format
        if (sessionMeta.participants) return sessionMeta.participants;
        // v1 compat
        const parts = [];
        if (sessionMeta.model_a) {
            parts.push({ seat: 0, id: sessionMeta.model_a.id, label: sessionMeta.model_a.label, speaker: "model_0" });
        }
        if (sessionMeta.model_b) {
            parts.push({ seat: 1, id: sessionMeta.model_b.id, label: sessionMeta.model_b.label, speaker: "model_1" });
        }
        return parts;
    }

    function getModelLabels() {
        const parts = getParticipants();
        // v1 compat return format
        const result = {};
        for (const p of parts) {
            // Support both model_0/model_1 and model_a/model_b
            result[p.speaker] = p.label;
            if (p.seat === 0) result.model_a = p.label;
            if (p.seat === 1) result.model_b = p.label;
        }
        return result;
    }

    function getSpeakerLabel(speaker) {
        const parts = getParticipants();
        // Try direct match on speaker field
        for (const p of parts) {
            if (p.speaker === speaker) return p.label;
        }
        // v1 compat
        if (speaker === "model_a") {
            const a = parts.find(p => p.seat === 0);
            return a ? a.label : "Model A";
        }
        if (speaker === "model_b") {
            const b = parts.find(p => p.seat === 1);
            return b ? b.label : "Model B";
        }
        if (speaker === "curator") return "curator";
        if (speaker === "system") return "";
        return speaker || "";
    }

    function isModelSpeaker(speaker) {
        return speaker && speaker.startsWith("model_");
    }

    /** Get the speaker key from a model label (for turn_start events) */
    function speakerFromLabel(label) {
        const parts = getParticipants();
        for (const p of parts) {
            if (p.label === label) return p.speaker;
        }
        return "model_0";
    }

    /** Get the speaker key from event (prefer speaker field, fall back to label matching) */
    function speakerFromEvent(event) {
        if (event.speaker) return event.speaker;
        if (event.model_label) return speakerFromLabel(event.model_label);
        return "model_0";
    }

    // -----------------------------------------------------------------------
    // Markdown streaming
    // -----------------------------------------------------------------------
    function scheduleRender() {
        if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
        markdownRenderTimer = setTimeout(() => {
            if (streamingTextEl && streamingRawText) {
                streamingTextEl.innerHTML = renderMarkdown(streamingRawText);
                appendStreamingCursor(streamingTextEl);
            }
        }, MARKDOWN_DEBOUNCE_MS);
    }

    // -----------------------------------------------------------------------
    // Message element creation (speaker-aware)
    // -----------------------------------------------------------------------
    function createSpeakerMessageEl(speaker, label, msgId, parentId) {
        const div = document.createElement("div");
        const baseRole = isModelSpeaker(speaker) ? "assistant" : "user";
        div.className = `message ${baseRole} speaker-${speaker}`;
        if (msgId) div.dataset.msgId = msgId;
        if (parentId) div.dataset.parentId = parentId;

        const labelEl = document.createElement("div");
        labelEl.className = "role-label";
        labelEl.textContent = label;
        div.appendChild(labelEl);

        const text = document.createElement("div");
        text.className = "message-text";
        div.appendChild(text);

        const actions = document.createElement("div");
        actions.className = "message-actions";

        if (speaker === "curator" && msgId) {
            const editBtn = document.createElement("button");
            editBtn.className = "edit-btn";
            editBtn.textContent = "edit";
            editBtn.onclick = () => startBackroomsEdit(div);
            actions.appendChild(editBtn);
        }

        if (msgId) {
            if (isModelSpeaker(speaker)) {
                const copyBtn = document.createElement("button");
                copyBtn.className = "msg-action-btn";
                copyBtn.textContent = "copy";
                copyBtn.onclick = () => {
                    const t = div.querySelector(".message-text")?.innerText || "";
                    navigator.clipboard.writeText(t).then(() => {
                        copyBtn.textContent = "copied";
                        setTimeout(() => { copyBtn.textContent = "copy"; }, 1500);
                    });
                };
                actions.appendChild(copyBtn);

                const regenBtn = document.createElement("button");
                regenBtn.className = "msg-action-btn";
                regenBtn.textContent = "regenerate";
                regenBtn.onclick = () => doRegenerate(div);
                actions.appendChild(regenBtn);
            }

            const pinBtn = document.createElement("button");
            pinBtn.className = "msg-action-btn";
            pinBtn.textContent = "pin";
            pinBtn.onclick = () => {
                const t = div.querySelector(".message-text")?.innerText || "";
                if (t.trim() && typeof createPin === "function") {
                    createPin("message", t.trim(), { source: "backrooms" });
                }
            };
            actions.appendChild(pinBtn);
        }

        div.appendChild(actions);
        return div;
    }

    // -----------------------------------------------------------------------
    // Edit (branch from curator message)
    // -----------------------------------------------------------------------
    function startBackroomsEdit(msgEl) {
        if (!chatCoreRef || chatCoreRef.isCurrentlyStreaming()) return;
        messagesEl.querySelectorAll(".edit-form").forEach(f => f.remove());

        const currentText = msgEl.dataset.rawText || msgEl.querySelector(".message-text")?.textContent || "";
        const parentId = msgEl.dataset.parentId || null;

        const form = document.createElement("div");
        form.className = "edit-form";
        const textarea = document.createElement("textarea");
        textarea.className = "edit-textarea";
        textarea.value = currentText;
        form.appendChild(textarea);

        const actions = document.createElement("div");
        actions.className = "edit-actions";
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "cancel";
        cancelBtn.onclick = () => form.remove();
        actions.appendChild(cancelBtn);
        const editSendBtn = document.createElement("button");
        editSendBtn.className = "edit-send";
        editSendBtn.textContent = "send edit";
        editSendBtn.onclick = () => submitBackroomsEdit(parentId, textarea.value.trim(), form);
        actions.appendChild(editSendBtn);
        form.appendChild(actions);
        msgEl.appendChild(form);

        function autoGrow() { textarea.style.height = "0"; textarea.style.height = textarea.scrollHeight + "px"; }
        textarea.addEventListener("input", autoGrow);
        textarea.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitBackroomsEdit(parentId, textarea.value.trim(), form); }
        });
        textarea.focus();
        requestAnimationFrame(autoGrow);
    }

    function submitBackroomsEdit(parentId, newText, formEl) {
        if (!newText || !chatCoreRef || chatCoreRef.isCurrentlyStreaming()) return;
        const editedMsg = formEl.closest(".message");
        formEl.remove();
        if (editedMsg) {
            while (editedMsg.nextSibling) editedMsg.nextSibling.remove();
            editedMsg.remove();
        }

        const curatorEl = createSpeakerMessageEl("curator", "curator");
        curatorEl.querySelector(".message-text").textContent = newText;
        messagesEl.appendChild(curatorEl);
        scrollDown();

        chatCoreRef.setStreaming(true);
        if (statusEl) statusEl.textContent = "running...";
        chatCoreRef.sendRaw({ action: "edit", parent_id: parentId, content: newText, type: "share" });
    }

    // -----------------------------------------------------------------------
    // Regenerate (re-run from a curator message)
    // -----------------------------------------------------------------------
    function doRegenerate(modelMsgEl) {
        if (!chatCoreRef || chatCoreRef.isCurrentlyStreaming()) return;

        let curatorMsgEl = null;
        let el = modelMsgEl.previousElementSibling;
        while (el) {
            if (el.classList.contains("speaker-curator")) { curatorMsgEl = el; break; }
            el = el.previousElementSibling;
        }
        const curatorMsgId = curatorMsgEl?.dataset?.msgId;
        if (!curatorMsgId) return;

        const curatorText = curatorMsgEl.querySelector(".message-text")?.textContent || "";
        const prevSpacer = curatorMsgEl.previousElementSibling;
        while (curatorMsgEl.nextSibling) curatorMsgEl.nextSibling.remove();
        if (prevSpacer && prevSpacer.classList.contains("message-spacer")) prevSpacer.remove();
        curatorMsgEl.remove();

        addSpacer();
        const newCuratorEl = createSpeakerMessageEl("curator", "curator");
        newCuratorEl.querySelector(".message-text").textContent = curatorText;
        messagesEl.appendChild(newCuratorEl);
        scrollDown();

        chatCoreRef.setStreaming(true);
        if (statusEl) statusEl.textContent = "regenerating...";
        chatCoreRef.sendRaw({ action: "regenerate", curator_msg_id: curatorMsgId });
    }

    // -----------------------------------------------------------------------
    // Speed control
    // -----------------------------------------------------------------------
    function renderSpeedControls() {
        let container = document.getElementById("speed-controls");
        if (!container) {
            container = document.createElement("span");
            container.id = "speed-controls";
            container.className = "speed-controls";
            // Insert after status indicator
            if (statusEl && statusEl.parentElement) {
                statusEl.parentElement.insertBefore(container, statusEl.nextSibling);
            }
        }
        container.innerHTML = "";
        const speeds = [0.5, 1, 2, 5];
        for (const s of speeds) {
            const btn = document.createElement("button");
            btn.className = "speed-btn" + (currentSpeed === s ? " active" : "");
            btn.textContent = s + "x";
            btn.onclick = () => {
                currentSpeed = s;
                chatCoreRef?.sendRaw({ action: "set_speed", speed: s });
                renderSpeedControls();
            };
            container.appendChild(btn);
        }
    }

    // -----------------------------------------------------------------------
    // Iteration count control
    // -----------------------------------------------------------------------
    function renderIterationControls() {
        let container = document.getElementById("iteration-controls");
        if (!container) {
            container = document.createElement("span");
            container.id = "iteration-controls";
            container.className = "iteration-controls";
            const speedEl = document.getElementById("speed-controls");
            if (speedEl && speedEl.parentElement) {
                speedEl.parentElement.insertBefore(container, speedEl.nextSibling);
            }
        }
        container.innerHTML = "";
        const label = document.createElement("span");
        label.className = "control-label";
        label.textContent = "rounds:";
        container.appendChild(label);
        const sel = document.createElement("select");
        sel.className = "iteration-select";
        for (let i = 1; i <= 10; i++) {
            const opt = document.createElement("option");
            opt.value = i;
            opt.textContent = i;
            if (i === currentIterations) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.onchange = () => {
            currentIterations = parseInt(sel.value, 10);
            chatCoreRef?.sendRaw({ action: "set_iterations", iterations: currentIterations });
        };
        container.appendChild(sel);
    }

    // -----------------------------------------------------------------------
    // Step mode toggle
    // -----------------------------------------------------------------------
    function renderStepModeToggle() {
        let container = document.getElementById("step-mode-controls");
        if (!container) {
            container = document.createElement("span");
            container.id = "step-mode-controls";
            container.className = "step-mode-controls";
            const iterEl = document.getElementById("iteration-controls");
            if (iterEl && iterEl.parentElement) {
                iterEl.parentElement.insertBefore(container, iterEl.nextSibling);
            }
        }
        container.innerHTML = "";
        const btn = document.createElement("button");
        btn.className = "speed-btn" + (currentStepMode ? " active" : "");
        btn.textContent = "step";
        btn.title = "Step mode: advance one turn at a time";
        btn.onclick = () => {
            currentStepMode = !currentStepMode;
            chatCoreRef?.sendRaw({ action: "set_step_mode", step_mode: currentStepMode });
            renderStepModeToggle();
        };
        container.appendChild(btn);
    }

    // -----------------------------------------------------------------------
    // Next-turn override
    // -----------------------------------------------------------------------
    function renderNextSpeakerControl() {
        let container = document.getElementById("next-speaker-controls");
        if (!container) {
            container = document.createElement("span");
            container.id = "next-speaker-controls";
            container.className = "next-speaker-controls";
            const stepEl = document.getElementById("step-mode-controls");
            if (stepEl && stepEl.parentElement) {
                stepEl.parentElement.insertBefore(container, stepEl.nextSibling);
            }
        }
        container.innerHTML = "";
        const label = document.createElement("span");
        label.className = "control-label";
        label.textContent = "next:";
        container.appendChild(label);
        const sel = document.createElement("select");
        sel.className = "next-speaker-select";
        const autoOpt = document.createElement("option");
        autoOpt.value = "";
        autoOpt.textContent = "auto";
        sel.appendChild(autoOpt);
        const parts = getParticipants();
        for (const p of parts) {
            const opt = document.createElement("option");
            opt.value = p.speaker;
            opt.textContent = p.label;
            sel.appendChild(opt);
        }
        sel.value = currentNextSpeaker || "";
        sel.onchange = () => {
            currentNextSpeaker = sel.value || null;
            chatCoreRef?.sendRaw({ action: "set_next_speaker", speaker: currentNextSpeaker });
        };
        container.appendChild(sel);
    }

    // -----------------------------------------------------------------------
    // Stats display
    // -----------------------------------------------------------------------
    function renderStats(stats) {
        let container = document.getElementById("backrooms-stats");
        if (!container) {
            container = document.createElement("div");
            container.id = "backrooms-stats";
            container.className = "backrooms-stats collapsed";
            if (messagesEl && messagesEl.parentElement) {
                // Insert before input area
                const inputArea = document.getElementById("input-area");
                if (inputArea) {
                    inputArea.parentElement.insertBefore(container, inputArea);
                }
            }
        }

        const parts = getParticipants();
        let html = '<div class="stats-toggle" onclick="this.parentElement.classList.toggle(\'collapsed\')">stats</div>';
        html += '<div class="stats-body">';
        for (const p of parts) {
            const turns = stats.turns?.[p.speaker] || 0;
            const inputTok = stats.tokens?.[p.speaker]?.input || 0;
            const outputTok = stats.tokens?.[p.speaker]?.output || 0;
            const times = stats.response_times?.[p.speaker] || [];
            const avgTime = times.length > 0 ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : "-";
            html += `<div class="stats-row"><strong>${p.label}</strong>: ${turns} turns, ${inputTok + outputTok} tokens, avg ${avgTime}s</div>`;
        }
        if (stats.commands_used && Object.keys(stats.commands_used).length > 0) {
            const cmds = Object.entries(stats.commands_used).map(([k, v]) => `${k}(${v})`).join(", ");
            html += `<div class="stats-row">commands: ${cmds}</div>`;
        }
        html += '</div>';
        container.innerHTML = html;
        container.style.display = "";
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function scrollDown() { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; }
    function maybeScroll() { if (messagesEl && messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 150) scrollDown(); }
    function addSpacer() {
        if (messagesEl.children.length > 0) {
            const s = document.createElement("div");
            s.className = "message-spacer";
            messagesEl.appendChild(s);
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Set session metadata and DOM references. Call before creating chatCore.
         */
        init(meta, elements) {
            sessionMeta = meta;
            statusEl = elements.statusIndicator;
            modelNamesEl = elements.modelNames;
            messagesEl = elements.messages;
            currentSpeed = meta?.speed || 1.0;
            currentIterations = meta?.iterations || 1;
            currentStepMode = meta?.step_mode || false;
            currentNextSpeaker = null;
        },

        /** Set the chatCore reference after it's created. */
        setChatCore(cc) { chatCoreRef = cc; },

        /** Get the current model labels. */
        getModelLabels,

        /** Get participants array. */
        getParticipants,

        /** Render all pacing controls after chatCore is ready. */
        renderSpeedControls() {
            renderSpeedControls();
            renderIterationControls();
            renderStepModeToggle();
            renderNextSpeakerControl();
        },

        /**
         * Returns chat-core config overrides for backrooms mode.
         */
        getChatCoreConfig() {
            return {
                wsUrlPrefix: "/api/backrooms/",
                costUrlPrefix: "/api/backrooms/sessions/",

                // Intercept all streaming events for backrooms
                onStreamEvent(event) {
                    switch (event.type) {
                        case "backrooms_turn_start": {
                            const speaker = speakerFromEvent(event);
                            addSpacer();
                            streamingEl = createSpeakerMessageEl(speaker, event.model_label);
                            streamingTextEl = streamingEl.querySelector(".message-text");
                            streamingRawText = "";
                            messagesEl.appendChild(streamingEl);
                            if (statusEl) statusEl.textContent = `${event.model_label} is talking...`;
                            scrollDown();
                            return true;
                        }

                        case "text_delta":
                            if (streamingTextEl) {
                                streamingRawText += event.text;
                                scheduleRender();
                                maybeScroll();
                            }
                            return true;

                        case "backrooms_turn_end":
                            if (markdownRenderTimer) clearTimeout(markdownRenderTimer);
                            if (streamingTextEl) {
                                const finalText = (event.text != null) ? event.text : streamingRawText;
                                streamingTextEl.innerHTML = renderMarkdown(finalText);
                                removeStreamingCursor(streamingTextEl);
                            }
                            streamingRawText = "";
                            markdownRenderTimer = null;
                            streamingEl = null;
                            streamingTextEl = null;
                            return true;

                        case "backrooms_command": {
                            // Render command notification as a styled system message
                            addSpacer();
                            const cmdEl = createSpeakerMessageEl("system", "");
                            cmdEl.classList.add("speaker-command");
                            const cmdText = event.command_result || `[${event.command_name}]`;
                            cmdEl.querySelector(".message-text").textContent = cmdText;
                            messagesEl.appendChild(cmdEl);
                            maybeScroll();
                            return true;
                        }

                        case "backrooms_stats":
                            if (event.stats) renderStats(event.stats);
                            return true;

                        case "backrooms_status":
                            if (statusEl) statusEl.textContent = "...";
                            return true;

                        case "backrooms_paused": {
                            addSpacer();
                            const pauseEl = createSpeakerMessageEl("system", "");
                            pauseEl.querySelector(".message-text").textContent = "waiting for something new...";
                            messagesEl.appendChild(pauseEl);
                            maybeScroll();
                            if (statusEl) statusEl.textContent = "ready for more";
                            // Reset next-speaker override after each run
                            currentNextSpeaker = null;
                            const nsSel = document.querySelector(".next-speaker-select");
                            if (nsSel) nsSel.value = "";
                            return true;
                        }

                        case "speed_updated":
                            currentSpeed = event.speed || 1.0;
                            renderSpeedControls();
                            return true;

                        case "iterations_updated":
                            currentIterations = event.iterations || 1;
                            renderIterationControls();
                            return true;

                        case "step_mode_updated":
                            currentStepMode = !!event.step_mode;
                            renderStepModeToggle();
                            return true;

                        case "next_speaker_updated":
                            currentNextSpeaker = event.speaker || null;
                            renderNextSpeakerControl();
                            return true;

                        case "message_done":
                            streamingEl = null;
                            streamingTextEl = null;
                            if (chatCoreRef) {
                                chatCoreRef.setStreaming(false);
                                chatCoreRef.fetchAndUpdateCost();
                                chatCoreRef.loadTree();
                            }
                            if (statusEl) statusEl.textContent = "ready";
                            scrollDown();
                            return false; // fall through so chat-core fires onMessageDone

                        case "usage":
                            return false; // let chat-core handle

                        case "context_update":
                            return false; // let chat-core handle

                        case "error":
                            if (statusEl) statusEl.textContent = "error";
                            return false; // let chat-core handle error display

                        default:
                            return false;
                    }
                },

                // Build backrooms send payload: { type: "share", content, inject_tags }
                buildSendPayload(rawText, images) {
                    const tagRegex = /#([a-zA-Z0-9-]+)/g;
                    const injectTags = [];
                    let match;
                    while ((match = tagRegex.exec(rawText)) !== null) {
                        injectTags.push(match[1].toLowerCase());
                    }
                    const text = rawText.replace(/#[a-zA-Z0-9-]+/g, "").trim();

                    // Tag-only message
                    if (!text && images.length === 0 && injectTags.length > 0) {
                        const payload = { type: "share", content: "", inject_tags: injectTags };
                        return { _backroomsRaw: payload, _tagOnly: true };
                    }

                    let contentPayload;
                    if (images.length > 0) {
                        const blocks = [];
                        if (text) blocks.push({ type: "text", text });
                        blocks.push(...images);
                        contentPayload = blocks;
                    } else {
                        contentPayload = text;
                    }

                    const payload = { type: "share", content: contentPayload };
                    if (injectTags.length > 0) payload.inject_tags = injectTags;

                    return {
                        ...payload,
                        _displayText: `[shared: ${text}]`,
                        _backroomsRaw: payload,
                    };
                },

                // No action buttons from chat-core — the adapter creates them
                // in createSpeakerMessageEl instead.
                createMessageActions() {},
            };
        },

        /**
         * Render existing messages with speaker labels. Called when opening
         * a backrooms session (instead of chatCore.renderConversationMessages).
         */
        renderMessages(messages) {
            if (!messagesEl) return;
            messagesEl.innerHTML = "";
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                const speaker = msg.speaker || msg.role;
                const label = getSpeakerLabel(speaker);
                const el = createSpeakerMessageEl(speaker, label, msg.id, msg.parent_id);
                const textEl = el.querySelector(".message-text");

                // Detect whisper messages
                const content = msg.content;
                const isWhisper = typeof content === "string" && content.startsWith("[whisper to ");
                if (isWhisper) {
                    el.classList.add("speaker-whisper");
                }

                const useMarkdown = isModelSpeaker(speaker);

                if (typeof content === "string") {
                    el.dataset.rawText = content;
                    textEl.innerHTML = useMarkdown ? renderMarkdown(content) : escapeHtml(content);
                } else if (Array.isArray(content)) {
                    const textParts = [];
                    for (const block of content) {
                        if (block.type === "text" && block.text) {
                            textParts.push(block.text);
                        } else if (block.type === "image" && block.source) {
                            const img = document.createElement("img");
                            img.src = `data:${block.source.media_type};base64,${block.source.data}`;
                            img.className = "message-image";
                            textEl.appendChild(img);
                        }
                    }
                    if (textParts.length > 0) {
                        const fullText = textParts.join("");
                        el.dataset.rawText = fullText;
                        if (useMarkdown) {
                            textEl.innerHTML = renderMarkdown(fullText);
                        } else {
                            textEl.insertBefore(document.createTextNode(fullText), textEl.firstChild);
                        }
                    }
                }

                messagesEl.appendChild(el);
                if (i < messages.length - 1) {
                    const spacer = document.createElement("div");
                    spacer.className = "message-spacer";
                    messagesEl.appendChild(spacer);
                }
            }
        },

        /**
         * Render a curator message into the feed (called by app.js sendMessage
         * override before sending via WS).
         */
        renderCuratorMessage(text, images) {
            addSpacer();
            const el = createSpeakerMessageEl("curator", "curator");
            const textEl = el.querySelector(".message-text");
            textEl.textContent = `[shared: ${text}]`;
            for (const img of (images || [])) {
                const imgEl = document.createElement("img");
                imgEl.src = `data:${img.source.media_type};base64,${img.source.data}`;
                imgEl.className = "message-image";
                textEl.appendChild(imgEl);
            }
            messagesEl.appendChild(el);
            scrollDown();
        },

        // -----------------------------------------------------------------------
        // Prompts modal — generalized for N seats
        // -----------------------------------------------------------------------
        async loadPrompts() {
            try {
                const res = await fetch("/api/prompts?category=backrooms", {
                    headers: { "Content-Type": "application/json" },
                });
                savedPrompts = await res.json();
            } catch (e) { savedPrompts = []; }
        },

        async openPromptsModal(sessionId) {
            if (!sessionId) return;
            const modal = document.getElementById("backrooms-prompts-modal");
            if (!modal) return;

            const parts = getParticipants();
            const modalBody = modal.querySelector(".modal-body");
            if (!modalBody) return;

            // Fetch current prompt IDs
            let promptIds = {};
            try {
                const res = await fetch(`/api/backrooms/sessions/${sessionId}/prompts`, {
                    headers: { "Content-Type": "application/json" },
                });
                const data = await res.json();
                promptIds = data.prompt_ids || {};
                // v1 compat
                if (!promptIds["0"] && data.prompt_id_a) promptIds["0"] = data.prompt_id_a;
                if (!promptIds["1"] && data.prompt_id_b) promptIds["1"] = data.prompt_id_b;
            } catch (e) { /* ignore */ }

            // Dynamically generate seat dropdowns
            // Keep actions row, clear the rest
            const actionsRow = modalBody.querySelector(".prompt-actions");
            const hint = modalBody.querySelector(".prompt-hint");

            // Remove old dynamic seats
            modalBody.querySelectorAll(".dynamic-seat").forEach(el => el.remove());

            // Also remove old static labels/selects for v1
            const oldLabelA = document.getElementById("br-prompt-a-label");
            const oldLabelB = document.getElementById("br-prompt-b-label");
            const oldSelA = document.getElementById("br-prompt-a-select");
            const oldSelB = document.getElementById("br-prompt-b-select");
            if (oldLabelA) oldLabelA.style.display = "none";
            if (oldLabelB) oldLabelB.style.display = "none";
            if (oldSelA) oldSelA.style.display = "none";
            if (oldSelB) oldSelB.style.display = "none";

            const insertBefore = hint || actionsRow || null;
            for (const p of parts) {
                const label = document.createElement("label");
                label.className = "form-label dynamic-seat";
                label.textContent = `${p.label} (seat ${p.seat + 1})`;

                const sel = document.createElement("select");
                sel.className = "form-select dynamic-seat";
                sel.dataset.seatIndex = p.seat;
                populatePromptDropdown(sel, promptIds[String(p.seat)] || "");

                if (insertBefore) {
                    modalBody.insertBefore(label, insertBefore);
                    modalBody.insertBefore(sel, insertBefore);
                } else {
                    modalBody.appendChild(label);
                    modalBody.appendChild(sel);
                }
            }

            const saveStatus = document.getElementById("br-prompts-save-status");
            if (saveStatus) saveStatus.textContent = "";
            modal.style.display = "flex";
        },

        async savePrompts(sessionId) {
            if (!sessionId) return;
            const modal = document.getElementById("backrooms-prompts-modal");
            if (!modal) return;

            // Collect from dynamic seats
            const promptIds = {};
            modal.querySelectorAll("select.dynamic-seat").forEach(sel => {
                const idx = sel.dataset.seatIndex;
                promptIds[idx] = sel.value || "";
            });

            // Also check v1 selects if dynamic seats don't exist
            if (Object.keys(promptIds).length === 0) {
                const selA = document.getElementById("br-prompt-a-select");
                const selB = document.getElementById("br-prompt-b-select");
                if (selA) promptIds["0"] = selA.value || "";
                if (selB) promptIds["1"] = selB.value || "";
            }

            try {
                await fetch(`/api/backrooms/sessions/${sessionId}/prompts`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt_ids: promptIds }),
                });
                const saveStatus = document.getElementById("br-prompts-save-status");
                if (saveStatus) { saveStatus.textContent = "saved"; setTimeout(() => { saveStatus.textContent = ""; }, 2000); }
            } catch (e) {
                const saveStatus = document.getElementById("br-prompts-save-status");
                if (saveStatus) saveStatus.textContent = "error saving";
            }
        },

        async resetPrompts(sessionId) {
            if (!sessionId) return;
            const parts = getParticipants();
            const promptIds = {};
            for (const p of parts) {
                promptIds[String(p.seat)] = "";
            }
            await fetch(`/api/backrooms/sessions/${sessionId}/prompts`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt_ids: promptIds, prompt_a: "", prompt_b: "" }),
            });
            // Reset dropdowns
            const modal = document.getElementById("backrooms-prompts-modal");
            if (modal) {
                modal.querySelectorAll("select.dynamic-seat").forEach(sel => { sel.value = ""; });
            }
            const saveStatus = document.getElementById("br-prompts-save-status");
            if (saveStatus) { saveStatus.textContent = "reset to defaults"; setTimeout(() => { saveStatus.textContent = ""; }, 2000); }
        },
    };

    function populatePromptDropdown(sel, selectedId) {
        if (!sel) return;
        sel.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "(default)";
        sel.appendChild(none);
        for (const p of savedPrompts) {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = p.name;
            sel.appendChild(opt);
        }
        sel.value = selectedId || "";
    }
})();
