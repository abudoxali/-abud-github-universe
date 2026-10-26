/* ABUD FUN Company OS V6 — الروتين: owner-enabled daily and weekly routines. Everything here is fixed-schedule and
 * read-only (no model calls), and a routine does nothing until the owner switches it on. The history keeps what was
 * executed apart from what was missed because the company was not running at the time. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O) return;
  const { h, fill, fmt, notice, panel, empty, button, act, mutate } = O;
  const ui = { list: null, runs: new Map(), error: null, box: null };
  const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const STATUS = { executed: ["ok", "نُفِّذ"], failed: ["bad", "فشل"], missed: ["warn", "فاته الموعد"] };
  const get = (path) => fetch(`/local-api/company${path}`, { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d?.message || "تعذر التحميل"); return d; });

  async function load() {
    try {
      ui.list = (await get("/routines")).routines;
      await Promise.all(ui.list.map(async (r) => ui.runs.set(r.id, (await get(`/routines/${r.id}/runs?limit=5`)).runs)));
      ui.error = null;
    } catch (error) { ui.error = error.message; }
    draw();
  }
  const patch = (trigger, id, body, ok) => act(trigger, () => mutate("PATCH", `/routines/${id}`, body), ok).then((r) => { if (r) load(); });

  function scheduleControls(r) {
    const time = h("input", { class: "ops-input", type: "time", value: r.schedule.time, "aria-label": `وقت ${r.title}`, required: true });
    const day = r.schedule.type === "weekly" ? h("select", { class: "ops-input", "aria-label": `يوم ${r.title}` }, DAYS.map((name, i) => h("option", { value: i, selected: i === r.schedule.day ? true : null }, name))) : null;
    return h("div", { class: "rt-schedule" }, day, time, button("حفظ الموعد", (e) => patch(e.currentTarget, r.id, { schedule: r.schedule.type === "weekly" ? { type: "weekly", day: Number(day.value), time: time.value } : { type: "daily", time: time.value } }, "حُفظ الموعد"), { kind: "secondary" }));
  }
  function item(r) {
    const runs = ui.runs.get(r.id) || [];
    return h("li", { class: `rt-item${r.enabled ? " is-on" : ""}` },
      h("div", { class: "rt-head" },
        h("label", { class: "co-check-field" }, h("input", { type: "checkbox", checked: r.enabled ? true : null, "aria-label": `تفعيل ${r.title}`, onchange: (e) => patch(e.currentTarget, r.id, { enabled: e.currentTarget.checked }, e.currentTarget.checked ? "فُعّل الروتين" : "أُوقف الروتين") }),
          h("span", null, h("strong", null, r.title), h("small", null, `${r.scheduleAr}${r.enabled && r.nextDueAt ? ` · القادم ${fmt.when(r.nextDueAt)}` : r.enabled ? "" : " · متوقف"}`))),
        button("شغّله الآن", (e) => act(e.currentTarget, () => mutate("POST", `/routines/${r.id}/run`, {}), "تم التشغيل").then((x) => { if (x) load(); }), { kind: "secondary" })),
      scheduleControls(r),
      r.missedCount ? h("p", { class: "rt-missed" }, `فاته الموعد ${r.missedCount} مرة لأن الشركة لم تكن تعمل وقتها.`) : null,
      runs.length ? h("ul", { class: "rt-runs" }, runs.map((run) => {
        const [tone, text] = STATUS[run.status] || ["info", run.status];
        return h("li", null, h("span", { class: `ops-chip rt-${tone}` }, run.trigger === "manual" && run.status === "executed" ? "يدوي" : text), h("span", { dir: "auto" }, run.summary), h("time", null, fmt.when(run.ranAt)),
          run.meetingId ? h("a", { class: "ops-link", href: O.href("agents", "meetings", run.meetingId) }, "فتح الاجتماع") : null);
      })) : h("p", { class: "ops-dim" }, "لم يعمل بعد."));
  }
  function draw() {
    if (!ui.box) return;
    fill(ui.box,
      ui.error ? notice("bad", "تعذر تحميل الروتين", ui.error) : null,
      panel("الروتين اليومي والأسبوعي", "كلها متوقفة حتى تفعّلها. تعمل بمواعيد ثابتة بتوقيت القاهرة وتقرأ بيانات الشركة فقط، دون استهلاك رموز نموذج. النتائج تصلك كتنبيه، وما فاته الموعد بسبب توقف النظام يُسجَّل كفائت ولا يُحسب منفَّذًا.",
        ui.list == null ? h("p", { class: "ops-dim" }, "يحمّل…") : ui.list.length ? h("ul", { class: "rt-list" }, ui.list.map(item)) : empty("لا توجد روتينات.")));
  }
  window.AbudRoutines = { render() { if (!ui.box) ui.box = h("div", { class: "rt-root" }); if (!ui.at || Date.now() - ui.at > 5000) { ui.at = Date.now(); load(); } else draw(); return ui.box; } };
})();
