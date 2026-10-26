/* ABUD FUN Company OS V6 — مركز الاجتماعات: owner meetings with one or more AI employees. The bridge's Meeting
 * Orchestrator decides who speaks (one at a time); this view shows the room, the speaking queue, the budget and the
 * transcript, and lets the owner talk, interrupt, pause and end. Outcomes are proposals until the owner confirms each
 * one. In voice or hybrid meetings each new agent turn is spoken through the single voice queue (no overlap). */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, notice, panel, empty, button, select, toast, act, mutate, href } = O;
  const ui = { list: null, current: null, error: null, poll: null, stream: null, spokenSeq: new Map(), root: null, draft: "", prefill: null };
  const STATUS_AR = { scheduled: "مجدول", active: "جارٍ", paused: "متوقف مؤقتًا", ending: "يستخرج النتائج", ended: "انتهى" };
  const MODE_AR = { text: "نصي", voice: "صوتي", hybrid: "نصي وصوتي" };
  const TYPE_AR = { decision: "قرار مقترح", action_item: "مهمة مقترحة", open_question: "سؤال مفتوح", disagreement: "خلاف مسجّل", follow_up: "متابعة" };
  const agents = () => (O.peek("co:agents")?.data?.agents || C.agentsDef()).filter((a) => a.active !== false && a.enabled !== false);
  const api = (path) => fetch(`/local-api/company${path}`, { cache: "no-store", headers: { Accept: "application/json" } }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d?.message || "تعذر التحميل"); return d; });
  async function sendLiveTurn(id, text) {
    try {
      const r = await mutate("POST", `/meetings/${id}/messages`, { content: text, clientMessageId: `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
      ui.current = r; draw(); schedulePoll(); return true;
    } catch (error) { toast(error.message, "bad"); return false; }
  }

  async function loadList() {
    try { ui.list = (await api("/meetings")).meetings; ui.error = null; } catch (error) { ui.error = error.message; }
    draw();
  }
  async function loadMeeting(id, { quiet = false } = {}) {
    try {
      const next = await api(`/meetings/${encodeURIComponent(id)}`);
      speakNew(next);
      // Polling redraws only when something changed, so the owner's typing and scroll position are left alone.
      const changed = JSON.stringify(next) !== JSON.stringify(ui.current) || ui.error;
      ui.current = next; ui.error = null;
      if (changed) draw();
      watchSpeaker(next);
    } catch (error) { if (!quiet) { ui.error = error.message; draw(); } }
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(ui.poll);
    const m = ui.current;
    if (!m || !["active", "ending"].includes(m.status)) return;
    ui.poll = setTimeout(() => { if (document.hidden || O.state.tab !== "meetings") return schedulePoll(); loadMeeting(m.id, { quiet: true }); }, m.currentSpeaker || m.queue.length || m.status === "ending" ? 1200 : 4000);
  }
  function watchSpeaker(m) {
    const turn = m.turns.find((item) => item.status === "in-flight" && item.runId);
    if (!turn || ui.stream?.runId === turn.runId) return;
    ui.stream?.source.close();
    ui.stream = null;
    const source = new EventSource(`/local-api/company/meetings/${encodeURIComponent(m.id)}/runs/${encodeURIComponent(turn.runId)}/events`);
    ui.stream = { source, runId: turn.runId };
    source.onmessage = (event) => {
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === "content") {
        window.AbudVoice?.feedStream(`meeting:${m.id}`, turn.runId, turn.speaker, data.content);
        const target = ui.root?.querySelector(`[data-meeting-run="${turn.runId}"] .co-chat-text`);
        if (target) target.textContent = data.content;
      } else if (data.type === "done" || (data.type === "snapshot" && !["queued", "running"].includes(data.run?.status))) {
        window.AbudVoice?.feedStream(`meeting:${m.id}`, turn.runId, turn.speaker, data.run?.output || "", true);
        source.close(); ui.stream = null; loadMeeting(m.id, { quiet: true });
      }
    };
    source.onerror = () => { source.close(); ui.stream = null; };
  }
  /** Voice meetings: speak each agent turn that completes while the room is open, in transcript order. */
  function speakNew(next) {
    if (!["voice", "hybrid"].includes(next.mode) || !window.AbudVoice) return;
    const done = next.turns.filter((t) => t.status === "completed" && !["owner", "system"].includes(t.speaker) && t.content);
    const seen = ui.spokenSeq.get(next.id);
    if (seen === undefined) { ui.spokenSeq.set(next.id, done.at(-1)?.seq ?? 0); return; }
    for (const turn of done.filter((t) => t.seq > seen)) {
      if (window.AbudVoice.isLive(`meeting:${next.id}`)) window.AbudVoice.feedStream(`meeting:${next.id}`, turn.runId, turn.speaker, turn.content, true);
      else window.AbudVoice.speak(turn.speaker, turn.content);
    }
    if (done.length) ui.spokenSeq.set(next.id, Math.max(seen, done.at(-1).seq));
    if (next.turns.some((t) => t.seq > seen && !["owner", "system"].includes(t.speaker) && ["completed", "failed", "interrupted"].includes(t.status))) window.AbudVoice.liveResponse(`meeting:${next.id}`);
  }

  // ------------------------------------------------------------------ list + create
  function createForm() {
    const list = agents();
    // A shortcut's preselection survives the list redraw that follows loading; it ends when the meeting is created or the tab is left.
    const pre = ui.prefill;
    const title = h("input", { class: "ops-input", name: "title", maxlength: 200, required: true, placeholder: "مثال: مراجعة أولويات الأسبوع", "aria-label": "عنوان الاجتماع", value: pre?.title || null });
    const project = select("projectId", [["", "بدون مشروع"], ...C.projectOptions(false)], "", { "aria-label": "المشروع" });
    const mode = select("mode", Object.entries(MODE_AR), pre?.mode || "voice", { "aria-label": "نوع الاجتماع" });
    const picks = list.map((a) => h("label", { class: "mt-pick" }, h("input", { type: "checkbox", name: "participants", value: a.id, checked: (pre ? pre.all || pre.participants?.includes(a.id) : a.id === "ori") ? true : null }), C.avatar(a.id, "sm"), h("span", null, a.name)));
    const chair = select("chair", list.map((a) => [a.id, a.name]), list.some((a) => a.id === "ori") ? "ori" : list[0]?.id, { "aria-label": "رئيس الاجتماع" });
    const agenda = h("textarea", { class: "ops-input", name: "agenda", rows: 3, maxlength: 3000, placeholder: "بند في كل سطر (اختياري)", "aria-label": "جدول الأعمال" });
    const all = button("كل الفريق", () => picks.forEach((p) => { p.querySelector("input").checked = true; }), { kind: "secondary" });
    return h("form", { class: "mt-create", onsubmit: async (event) => {
      event.preventDefault();
      const participants = picks.map((p) => p.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
      if (!participants.includes(chair.value)) participants.unshift(chair.value);
      const created = await act(event.currentTarget.querySelector("button[type=submit]"), async () => {
        const m = await mutate("POST", "/meetings", { title: title.value, projectId: project.value || null, mode: mode.value, chair: chair.value, participants, agenda: agenda.value.split("\n") });
        return mutate("POST", `/meetings/${m.id}/start`, {});
      }, "بدأ الاجتماع");
      if (created) {
        ui.prefill = null; O.go("agents", "meetings", created.id);
        if (["voice", "hybrid"].includes(created.mode) && window.AbudVoice) {
          window.AbudVoice.startLive({ key: `meeting:${created.id}`, agentId: created.chair, onTurn: (text) => sendLiveTurn(created.id, text) });
        }
      }
    } },
      h("div", { class: "co-form-row" }, title, project, mode),
      h("fieldset", { class: "mt-picks" }, h("legend", null, "المشاركون"), ...picks, all),
      h("div", { class: "co-form-row" }, h("label", { class: "mt-inline" }, "رئيس الاجتماع ", chair)),
      agenda,
      h("button", { type: "submit", class: "btn btn-primary" }, "ابدأ الاجتماع"));
  }
  function meetingRow(m) {
    return h("a", { class: "mt-row", href: href("agents", "meetings", m.id) },
      h("strong", null, m.title), h("span", { class: `ops-chip mt-status-${m.status}` }, STATUS_AR[m.status] || m.status),
      h("span", { class: "mt-row-people" }, m.participants.slice(0, 7).map((p) => C.avatar(p.agentId, "xs"))),
      h("small", { class: "ops-dim" }, `${MODE_AR[m.mode]} · ${fmt.when(m.updatedAt)}${m.projectId ? ` · ${C.projectName(m.projectId) || "مشروع"}` : ""}`));
  }
  function drawList(root) {
    fill(root,
      O.sectionShell({ id: "meetings", title: "مركز الاجتماعات", subtitle: "اجتماعات فردية أو جماعية مع الموظفين. يتكلم واحد في كل مرة، والقرارات تبقى مقترحات حتى تؤكدها." }),
      ui.error ? notice("bad", "تعذر تحميل الاجتماعات", ui.error) : null,
      panel("اجتماع جديد", "اختر المشاركين وجدول الأعمال؛ لا حاجة لضبط نماذج أو أصوات.", createForm()),
      panel("الاجتماعات", null, ui.list == null ? h("p", { class: "ops-dim" }, "يحمّل…") : ui.list.length ? h("div", { class: "mt-list" }, ui.list.map(meetingRow)) : empty("لا توجد اجتماعات بعد.")));
  }

  // ------------------------------------------------------------------ room
  function participant(m, p) {
    const speaking = m.currentSpeaker === p.agentId;
    const waiting = m.queue.includes(p.agentId);
    const voiceState = window.AbudVoice?.override(p.agentId);
    return h("li", { class: `mt-seat${speaking ? " is-speaking" : ""}${waiting ? " is-waiting" : ""}`, "aria-current": speaking ? "true" : null },
      C.avatar(p.agentId, "lg", { state: voiceState || (speaking ? "thinking" : "idle") }),
      h("strong", null, p.name), h("small", null, p.role === "chair" ? "رئيس الاجتماع" : speaking ? "يتحدث الآن" : waiting ? "في الانتظار" : `${p.turns} مداخلة`));
  }
  function turnView(t) {
    if (t.kind === "system") return h("div", { class: "co-chat-system" }, h("span", null, t.content), h("time", null, fmt.when(t.createdAt)));
    const pending = t.status === "queued" || t.status === "in-flight";
    return h("article", { class: `co-chat-message ${t.speaker === "owner" ? "co-chat-owner" : "co-chat-assistant"} mt-turn-${t.status}`, "data-meeting-run": t.runId || "" },
      h("div", { class: "co-chat-meta" }, C.avatar(t.speaker === "owner" ? "owner" : t.speaker, "sm"), h("strong", null, t.speaker === "owner" ? "أنت" : t.speakerName), h("time", null, fmt.when(t.createdAt)),
        t.kind === "summary" ? h("span", { class: "ops-chip" }, "ملخص الرئيس") : null),
      h("div", { class: "co-chat-text", dir: "auto" }, pending ? (t.status === "queued" ? "ينتظر دوره…" : "يفكر ويجمع الأدلة…") : t.status === "interrupted" ? "قوطع قبل أن يكمل." : t.status === "failed" ? "تعذر إكمال المداخلة." :
        window.AbudWorkforce?.renderMarkdown ? window.AbudWorkforce.renderMarkdown(t.content) : t.content));
  }
  function outcomeView(m, o) {
    const decide = (verdict, trigger) => act(trigger, () => mutate("POST", `/meetings/${m.id}/outcomes/${o.id}/${verdict}`, {}), verdict === "confirm" ? "تم التأكيد" : "تم الرفض").then((r) => { if (r) { ui.current = r; draw(); O.invalidate("tasks", "summary"); } });
    return h("li", { class: `mt-outcome mt-outcome-${o.status}` },
      h("span", { class: "ops-chip" }, TYPE_AR[o.type] || o.type), h("p", { dir: "auto" }, o.content),
      h("small", { class: "ops-dim" }, [o.responsibleAgent ? `المسؤول: ${C.agentDef(o.responsibleAgent)?.name || o.responsibleAgent}` : null, o.dueDate ? `الموعد: ${o.dueDate}` : null,
        o.status === "confirmed" ? "مؤكد" : o.status === "rejected" ? "مرفوض" : "بانتظار قرارك"].filter(Boolean).join(" · ")),
      o.taskId ? h("a", { class: "btn btn-secondary", href: href("work", "tasks", o.taskId) }, "فتح المهمة") : null,
      o.status === "proposed" ? h("div", { class: "ops-actions" }, button("تأكيد", (e) => decide("confirm", e.currentTarget), { kind: "primary" }), button("رفض", (e) => decide("reject", e.currentTarget), { kind: "secondary" })) : null);
  }
  function drawRoom(root, m) {
    const typing = document.activeElement?.matches?.(".mt-compose textarea");
    const live = m.status === "active";
    const busy = Boolean(m.currentSpeaker || m.queue.length);
    window.AbudVoice?.updateLive(`meeting:${m.id}`, { busy, active: live && !m.budgetExhausted && ["voice", "hybrid"].includes(m.mode) });
    const control = (label, path, ok, kind = "secondary") => ok ? button(label, async (e) => { const r = await act(e.currentTarget, () => mutate("POST", `/meetings/${m.id}/${path}`, {}), null); if (r) { if (path === "interrupt") window.AbudVoice?.liveResponse(`meeting:${m.id}`); if (path === "interrupt" || path === "end") window.AbudVoice?.stopPlayback(); ui.current = r; draw(); schedulePoll(); } }, { kind }) : null;
    const input = h("textarea", { class: "ops-input", rows: 2, maxlength: 4000, placeholder: "تكلّم مع الفريق… وجّه السؤال لموظف بذكر اسمه أول الرسالة (مثال: NEX، ايه رأيك؟)", "aria-label": "رسالتك في الاجتماع",
      oninput: (event) => { ui.draft = event.currentTarget.value; },
      onkeydown: (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } } });
    input.value = ui.draft;
    const composer = live ? h("form", { class: "co-chat-compose mt-compose", onsubmit: async (event) => {
      event.preventDefault();
      const content = input.value.trim(); if (!content) return;
      const r = await act(event.currentTarget.querySelector("button[type=submit]"), () => mutate("POST", `/meetings/${m.id}/messages`, { content, clientMessageId: `mtg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }), null);
      if (r) { input.value = ""; ui.draft = ""; ui.current = r; draw(); schedulePoll(); }
    } }, h("div", { class: "co-chat-compose-main" }, input),
      ["voice", "hybrid"].includes(m.mode) ? window.AbudVoice?.controls({ agentId: m.chair, liveKey: `meeting:${m.id}`, liveLabel: "اجتماع لايف", liveBlocked: busy || m.budgetExhausted, onTurn: (text) => sendLiveTurn(m.id, text), onText: (text) => { const box = ui.root?.querySelector(".mt-compose textarea") || input; box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text; ui.draft = box.value; box.focus(); } }) : null,
      h("button", { type: "submit", class: "btn btn-primary", disabled: busy ? true : null, title: busy ? "انتظر المتحدث الحالي أو قاطِع النقاش" : null }, "إرسال")) : null;
    const usage = m.usage, budget = m.budget;
    fill(root,
      h("header", { class: "mt-head" },
        h("a", { class: "btn btn-secondary", href: href("agents", "meetings") }, "كل الاجتماعات"),
        h("div", null, h("h2", null, m.title), h("p", { class: "ops-dim" }, `${STATUS_AR[m.status]} · ${MODE_AR[m.mode]}${m.projectId ? ` · ${C.projectName(m.projectId) || "مشروع"}` : ""}`)),
        h("div", { class: "ops-actions" },
          control("قاطِع النقاش", "interrupt", live && busy), control("إيقاف مؤقت", "pause", live), control("استئناف", "resume", m.status === "paused", "primary"),
          control("إنهاء واستخراج النتائج", "end", ["active", "paused"].includes(m.status), "primary"),
          h("a", { class: "btn btn-secondary", href: `/local-api/company/meetings/${m.id}/export`, download: "" }, "تصدير المحضر"))),
      ui.error ? notice("bad", "تعذر التحديث", ui.error) : null,
      m.budgetExhausted && live ? notice("warn", "بلغ الاجتماع حد الميزانية", "أنهِ الاجتماع لاستخراج النتائج.") : null,
      h("ul", { class: "mt-seats", "aria-label": "المشاركون" }, m.participants.map((p) => participant(m, p))),
      h("div", { class: "mt-layout" },
        h("section", { class: "mt-transcript-wrap" },
          h("div", { class: "co-chat-transcript mt-transcript", role: "log", "aria-live": "polite", "aria-label": "محضر الاجتماع" }, m.turns.length ? m.turns.map(turnView) : empty("ابدأ النقاش بكتابة سؤالك أو موضوعك.")),
          composer),
        h("aside", { class: "mt-side" },
          m.agenda.length ? panel("جدول الأعمال", null, h("ol", null, m.agenda.map((a) => h("li", null, a)))) : null,
          panel("الموارد", null, h("dl", { class: "mt-budget" },
            h("dt", null, "المداخلات"), h("dd", null, `${usage.turns} / ${budget.maxTurns}`),
            h("dt", null, "جولات النقاش"), h("dd", null, `${usage.rounds} / ${budget.maxRounds}`),
            h("dt", null, "الرموز (تقديري)"), h("dd", null, `${fmt.num(usage.tokens)} / ${fmt.num(budget.maxTokens)}`))),
          m.summary ? panel("الملخص", null, h("p", { dir: "auto" }, m.summary)) : null,
          m.outcomes.length ? panel("النتائج", "لا يُعتمد شيء دون تأكيدك. تأكيد المهمة ينشئها في العمل، وتأكيد القرار يحفظه في ذاكرة المشروع.", h("ul", { class: "mt-outcomes" }, m.outcomes.map((o) => outcomeView(m, o)))) : null)));
    const log = root.querySelector(".mt-transcript");
    if (log) log.scrollTop = log.scrollHeight;
    if (typing) { const box = root.querySelector(".mt-compose textarea"); box?.focus(); box?.setSelectionRange(box.value.length, box.value.length); }
  }

  function draw() {
    const root = ui.root;
    if (!root || O.state.view !== "agents" || O.state.tab !== "meetings") return;
    O.setHead("agents", null);
    if (ui.current && O.state.rest[0] === ui.current.id) return drawRoom(root, ui.current);
    drawList(root);
  }

  window.AbudMeetings = {
    prefill(value) { ui.prefill = value; },
    render(root) { ui.root = root; draw(); },
    reload(rest) {
      clearTimeout(ui.poll);
      ui.stream?.source.close(); ui.stream = null;
      const id = rest?.[0];
      if (id) { if (ui.current?.id !== id) ui.current = null; loadMeeting(id); } else { ui.current = null; loadList(); }
    },
    stop() { clearTimeout(ui.poll); ui.stream?.source.close(); ui.stream = null; ui.prefill = null; window.AbudVoice?.stopLive(); }
  };
})();
