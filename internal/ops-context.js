/* ABUD FUN Company OS V6 — النطاق والخصوصية (System → الأمان): which folders the company may look at, what is refused
 * for good, what each employee actually read, and what left the machine toward model providers. Paths are never shown;
 * only the owner-chosen label is. Scope changes are owner-guarded and audited by the bridge. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O) return;
  const { h, fill, fmt, notice, panel, empty, button, act, mutate, icon } = O;
  const ui = { data: null, error: null, box: null };
  const STATUS_AR = { succeeded: "نجح", failed: "فشل", denied: "رُفض", timeout: "انتهت المهلة", cancelled: "أُلغي", running: "يعمل" };
  const load = async () => {
    try {
      const response = await fetch("/local-api/company/context", { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "تعذر التحميل");
      ui.data = await response.json(); ui.error = null;
    } catch (error) { ui.error = error.message; }
    draw();
  };
  const toolName = (id) => (O.peek("co:catalog")?.data?.tools || []).find((t) => t.id === id)?.ar || id;
  const agentName = (id) => C?.agentDef?.(id)?.name || String(id).toUpperCase();

  function addForm(managedByEnv) {
    const path = h("input", { class: "ops-input", type: "text", dir: "ltr", placeholder: "D:\\Work\\Clients", "aria-label": "مسار المجلد", required: true, disabled: managedByEnv ? true : null });
    const label = h("input", { class: "ops-input", type: "text", maxlength: 60, placeholder: "اسم يظهر في الواجهة (اختياري)", "aria-label": "اسم المجلد" });
    const personal = h("input", { type: "checkbox" });
    return h("form", { class: "cx-add", onsubmit: async (event) => {
      event.preventDefault();
      const result = await act(event.currentTarget.querySelector("button[type=submit]"), () => mutate("POST", "/context/scopes", { path: path.value, label: label.value, personal: personal.checked }), "صُرّح بالمجلد");
      if (result) { ui.data = result; path.value = ""; label.value = ""; personal.checked = false; draw(); }
    } }, h("div", { class: "co-form-row" }, path, label),
      h("label", { class: "co-check-field" }, personal, h("span", null, h("strong", null, "مجلد شخصي أصرّح به صراحةً"), h("small", null, "لازم لمجلدات مثل المستندات والتنزيلات. المواقع الحساسة (مفاتيح، متصفح، نظام) ترفض دائمًا حتى مع التأكيد."))),
      h("button", { type: "submit", class: "btn btn-primary", disabled: managedByEnv ? true : null }, "تصريح بالمجلد"));
  }
  function draw() {
    const box = ui.box;
    if (!box) return;
    const d = ui.data;
    if (!d) return fill(box, ui.error ? notice("bad", "تعذر تحميل النطاق والخصوصية", ui.error) : h("p", { class: "ops-dim" }, "يحمّل…"));
    const managedByEnv = d.scopes.source === "environment";
    fill(box,
      ui.error ? notice("bad", "تعذر التحديث", ui.error) : null,
      panel("المجلدات المصرّح بها", "الشركة لا تفحص إلا هذه المجلدات، قراءةً فقط. لا يُمسح أي مجلد شخصي تلقائيًا.",
        managedByEnv ? notice("info", "المجلدات محددة بمتغير بيئة", "عدّلها من إعداد التشغيل؛ لا تُدار من هنا.") : null,
        d.scopes.roots.length ? h("ul", { class: "cx-list" }, d.scopes.roots.map((r) => h("li", null, icon("shield", 16), h("strong", null, r.label), r.personal ? h("span", { class: "ops-chip" }, "شخصي") : null,
          managedByEnv ? null : button("سحب التصريح", async (e) => { if (!await O.confirmDialog({ title: `سحب تصريح «${r.label}»؟`, body: "لن تقرأ الشركة هذا المجلد بعد الآن. لا يُحذف أي ملف.", confirm: "سحب", tone: "danger" })) return; const result = await act(e.currentTarget, () => mutate("DELETE", `/context/scopes/${r.id}`), "سُحب التصريح"); if (result) { ui.data = result; draw(); } }, { kind: "secondary" })))) : empty("لا توجد مجلدات مصرّح بها بعد."),
        d.scopes.rejected?.length ? h("div", { class: "cx-rejected" }, h("strong", null, "مجلدات مرفوضة"), h("ul", null, d.scopes.rejected.map((r) => h("li", null, `${r.label}: ${r.reasonAr}`)))) : null,
        addForm(managedByEnv)),
      panel("محمي دائمًا", "لا يمكن التصريح بهذه المواقع ولا تقرأها أي أداة، حتى لو طلبتَ ذلك.", h("ul", { class: "cx-chips" }, d.protected.map((x) => h("li", { class: "ops-chip" }, x)))),
      panel("ما يخرج من جهازك وما يبقى", "OmniRoute يستقبل الحد الأدنى من السياق فقط. الصوت لا يُرسل أبدًا.", h("div", { class: "cx-flow" },
        h("section", null, h("h4", null, "يبقى على الجهاز"), h("ul", null, d.dataFlow.staysLocal.map((x) => h("li", null, x)))),
        h("section", null, h("h4", null, "يُرسل لمزوّد النموذج (بحدود)"), h("ul", null, d.dataFlow.sentToInference.map((x) => h("li", null, x)))),
        h("section", null, h("h4", null, "لا يُرسل أبدًا"), h("ul", null, d.dataFlow.neverSent.map((x) => h("li", null, x)))))),
      panel("المُرسَل فعليًا آخر 7 أيام", "قياس من سجل الاستخدام: عدد الطلبات والرموز لكل مزوّد ونموذج، بلا محتوى.",
        d.outbound.byModel.length ? h("div", { class: "ops-table-wrap" }, h("table", { class: "ops-table" }, h("thead", null, h("tr", null, ["المزوّد", "النموذج", "الطلبات", "رموز المُدخل", "رموز المُخرج"].map((t) => h("th", null, t)))),
          h("tbody", null, d.outbound.byModel.map((r) => h("tr", null, h("td", { dir: "ltr" }, r.provider), h("td", { dir: "ltr" }, r.model), h("td", null, fmt.num(r.requests)), h("td", null, fmt.num(r.promptTokens)), h("td", null, fmt.num(r.completionTokens))))))) : empty("لم يُرسل شيء لأي مزوّد خلال الفترة.")),
      panel("سجل الوصول: ماذا قرأ الموظفون", "من سجل تدقيق الأدوات: من استخدم أي أداة قراءة، على أي مشروع، ومتى.",
        d.access.length ? h("ul", { class: "cx-access" }, d.access.map((a) => h("li", null, h("strong", null, agentName(a.agentId)), ` — ${toolName(a.toolId)}`, a.projectId ? ` · ${C?.projectName?.(a.projectId) || a.projectId}` : "", h("span", { class: `ops-chip` }, STATUS_AR[a.status] || a.status), h("time", null, fmt.when(a.at))))) : empty("لم تُستخدم أدوات قراءة بعد.")),
      button("تحديث", load, { icon: "refresh" }));
  }
  window.AbudContext = { render() { if (!ui.box) ui.box = h("div", { class: "cx-root" }); if (!ui.at || Date.now() - ui.at > 5000) { ui.at = Date.now(); load(); } else draw(); return ui.box; } };
})();
