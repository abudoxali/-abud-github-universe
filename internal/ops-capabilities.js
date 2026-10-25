/* ABUD FUN Company OS V5 — الأدوات والمهارات (capability library), the owner's tool console, the execution audit, generated
 * files, MIA's template studio (Fabric.js) and result charts (ECharts). Availability, grants and results come only from
 * the bridge: a capability shown as available passed its live dependency check; every run below is a persisted audit
 * row. Browser libraries load on first use from the bridge's pinned dependencies (no CDN). */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, bdi, icon, panel, panelX, empty, button, field, select, toast, act, mutate } = O;

  const CATEGORY_AR = { orchestration: "التنسيق والإدارة العليا", creative: "الإنتاج الإبداعي", telemetry: "القياس والموارد", administration: "الإدارة والمتابعة", research: "البحث والمعرفة", security: "الأمن والحوكمة", company: "بيانات الشركة", infrastructure: "البنية التحتية", routing: "التوجيه" };
  const CATEGORY_ORDER = ["orchestration", "creative", "telemetry", "administration", "research", "security", "company", "infrastructure", "routing"];
  const SIDE_AR = { none: ["muted", "قراءة فقط"], "internal-write": ["warn", "كتابة داخلية"], artifact: ["accent", "ينتج ملفًا"], "external-read": ["info", "قراءة خارجية"], proposal: ["warn", "اقتراح للموافقة"] };
  const AVAIL = { available: ["ok", "متاحة"], unavailable: ["bad", "غير متاحة"], disabled: ["muted", "معطّلة من المالك"] };
  const EXEC_AR = { running: ["info", "قيد التنفيذ"], succeeded: ["ok", "نجح"], failed: ["bad", "فشل"], denied: ["warn", "رُفض"], timeout: ["bad", "انتهت المهلة"], cancelled: ["muted", "أُلغي"] };
  const FIELD_AR = { projectId: "المشروع", format: "الصيغة", theme: "النمط", template: "القالب", title: "العنوان", subtitle: "العنوان الفرعي", agentId: "الوكيل", source: "المصدر", sourceId: "الملف المصدر",
    conversationId: "معرّف المحادثة", maxWidth: "أقصى عرض (بكسل)", quality: "الجودة", range: "الفترة", runId: "معرّف التشغيل", limit: "العدد", assignee: "المسند إليه", rangeDays: "عدد الأيام",
    olderThanHours: "أقدم من (ساعات)", url: "رابط الصفحة المعتمدة", ingest: "أضف النص إلى مكتبة المعرفة", q: "عبارة البحث", maxAgeDays: "أقصى عمر (أيام)", recheckWeb: "أعد جلب صفحات الويب للمقارنة", mode: "نطاق الفحص",
    status: "الحالة", doc: "المستند", taskId: "معرّف المهمة", priority: "الأولوية", hostId: "الخادم", service: "الخدمة", diagnostic: "الفحص", actionId: "معرّف الإجراء", operation: "العملية", reason: "السبب", key: "الإعداد" };
  const VALUE_AR = { png: "PNG", webp: "WebP", jpeg: "JPEG", avif: "AVIF", violet: "بنفسجي", light: "فاتح", announcement: "إعلان داخلي", milestone: "إنجاز مرحلة", "agent-spotlight": "تعريف بوكيل",
    artifact: "ملف ناتج محفوظ", attachment: "مرفق محادثة", "24h": "آخر 24 ساعة", "7d": "آخر 7 أيام", "30d": "آخر 30 يومًا", history: "السجل (آخر 300 Commit)", uncommitted: "التغييرات غير المحفوظة",
    pending: "المعلقة", all: "الكل", high: "عالية", medium: "متوسطة", low: "منخفضة" };
  const ui = { agent: "", category: "", query: "", registry: null, error: "", loading: false, executions: [], execBefore: null, execMore: false, execFilter: { agentId: "", status: "" }, artifacts: [], artFilter: { agentId: "", kind: "" }, section: "library" };
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const get = async (path) => {
    const response = await fetch(`/local-api/company${path}`, { cache: "no-store", headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    return data;
  };
  const agentName = (id) => C.agentDef(id)?.name || String(id || "").toUpperCase();

  // ------------------------------------------------------------------ lazy vendor scripts (bridge-served, pinned)
  const scripts = new Map();
  function vendor(name, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!scripts.has(name)) scripts.set(name, new Promise((resolve, reject) => {
      const node = h("script", { src: `./internal/vendor/${name}.min.js`, async: true });
      node.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${name} لم يُحمّل`)));
      node.onerror = () => { scripts.delete(name); reject(new Error(`تعذر تحميل ${name} من الـ Bridge`)); };
      document.head.append(node);
    }));
    return scripts.get(name);
  }

  // ------------------------------------------------------------------ charts (ECharts, RTL, reduced-motion aware)
  const charts = new Set();
  function sweepCharts() { for (const c of charts) if (!c.el.isConnected) { c.observer.disconnect(); c.chart.dispose(); charts.delete(c); } }
  /** Renders `option` into a fresh container; the chart is disposed automatically once the container leaves the DOM. */
  function chart(option, { height = 260, label: aria } = {}) {
    // Charts are drawn left-to-right internally (dir=ltr) so SVG text anchors stay put; RTL reading order comes from the
    // axis layout (values grow from the right, category labels on the right).
    const el = h("div", { class: "cap-chart", dir: "ltr", style: `block-size:${height}px`, role: "img", "aria-label": aria || "رسم بياني" });
    vendor("echarts", "echarts").then((echarts) => {
      sweepCharts();
      if (!el.isConnected) { requestAnimationFrame(() => { if (el.isConnected) mountChart(echarts, el, option); }); return; }
      mountChart(echarts, el, option);
    }).catch((error) => fill(el, notice("warn", "تعذر عرض الرسم", error.message)));
    return el;
  }
  function mountChart(echarts, el, option) {
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--os-ink").trim() || "#1e1147";
    const instance = echarts.init(el, null, { renderer: "svg" });
    instance.setOption({ animation: !reduced(), textStyle: { fontFamily: "Alexandria, Manrope, system-ui, sans-serif", color: ink }, grid: { left: 12, right: 12, top: 36, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", confine: true }, legend: { top: 0, right: 0, align: "right", textStyle: { color: ink } }, ...option });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    charts.add({ el, chart: instance, observer });
  }
  const PALETTE = ["#7c3aed", "#22c55e", "#ef4444", "#f59e0b", "#2f8bff", "#a35bff"];
  function barChart({ categories, series, horizontal = false, unit = "" }) {
    const value = { type: "value", minInterval: unit ? undefined : 1, axisLabel: { formatter: (v) => `${v}${unit}` }, splitLine: { lineStyle: { opacity: 0.25 } } };
    const cat = { type: "category", data: categories, axisLabel: { interval: 0, overflow: "truncate", width: 110 } };
    return { color: PALETTE, xAxis: horizontal ? { ...value, inverse: true } : cat, yAxis: horizontal ? { ...cat, position: "right" } : value, series: series.map((s) => ({ type: "bar", barMaxWidth: 26, emphasis: { focus: "series" }, ...s })) };
  }

  // ------------------------------------------------------------------ data
  async function loadRegistry(refresh = false) {
    ui.loading = true;
    try { ui.registry = (await get(`/capabilities${refresh ? "?refresh=1" : ""}`)).capabilities; ui.error = ""; }
    catch (error) { ui.error = error.message; }
    ui.loading = false;
  }
  async function loadExecutions(append = false) {
    const f = ui.execFilter;
    const q = new URLSearchParams({ limit: "30", ...(f.agentId ? { agentId: f.agentId } : {}), ...(f.status ? { status: f.status } : {}), ...(append && ui.execBefore ? { before: ui.execBefore } : {}) });
    const rows = (await get(`/executions?${q}`)).executions;
    ui.executions = append ? [...ui.executions, ...rows] : rows;
    ui.execBefore = rows.at(-1)?.startedAt ?? ui.execBefore;
    ui.execMore = rows.length === 30;
  }
  async function loadArtifacts() {
    const f = ui.artFilter;
    const q = new URLSearchParams({ limit: "60", ...(f.agentId ? { agentId: f.agentId } : {}), ...(f.kind ? { kind: f.kind } : {}) });
    ui.artifacts = (await get(`/artifacts?${q}`)).artifacts;
  }

  // ------------------------------------------------------------------ small widgets
  const availBadge = (t) => { const [tone, text] = AVAIL[t.availability] || ["muted", t.availability]; return badge(tone, text, t.health?.reason || t.disabledReason || ""); };
  const execBadge = (status) => { const [tone, text] = EXEC_AR[status] || ["muted", status]; return badge(tone, text); };
  const grantChips = (t) => h("span", { class: "cap-grants" }, t.grants.map((g) => h("span", { class: `cap-grant${g.granted ? "" : " is-revoked"}`, title: `${agentName(g.agentId)}${g.granted ? "" : " — سحبها المالك"}` }, C.avatar(g.agentId, "xs"))));
  function toolMeta(t) {
    const [sideTone, sideText] = SIDE_AR[t.sideEffect] || ["muted", t.sideEffect];
    return h("div", { class: "cap-meta" }, availBadge(t), badge(sideTone, sideText), t.approval === "always" ? badge("warn", "موافقة المالك لكل تشغيل") : null,
      t.network && t.network !== "none" ? badge("info", `شبكة: ${t.network}`) : null, h("small", { class: "ops-dim" }, `v${t.version} · ${t.adapter}`));
  }

  // ------------------------------------------------------------------ tool console (owner runs one capability as a granted agent)
  function inputControl(tool, key, rule, agentId) {
    const name = key;
    if (rule.type === "enum") return select(name, [...(rule.required ? [] : [["", "— افتراضي —"]]), ...rule.values.map((v) => [v, key === "agentId" ? agentName(v) : VALUE_AR[v] || v])], rule.required ? rule.values[0] : "", { "aria-label": FIELD_AR[key] || key });
    if (rule.type === "boolean") return h("input", { type: "checkbox", name, "aria-label": FIELD_AR[key] || key });
    if (rule.type === "integer") return h("input", { class: "ops-input", type: "number", name, min: rule.min, max: rule.max, step: 1, dir: "ltr", placeholder: `${rule.min}–${rule.max}`, "aria-label": FIELD_AR[key] || key });
    if (key === "projectId") return select(name, [...(rule.required ? [] : [["", "بدون مشروع (الشركة)"]]), ...C.projectOptions(false)], "", { "aria-label": "المشروع", required: rule.required ? true : null });
    if (key === "assignee") return select(name, [["", "الكل"], ["owner", "المالك"], ...["ori", "mia", "nex", "luna", "zen", "rex"].map((id) => [id, agentName(id)])], "", { "aria-label": "المسند إليه" });
    if (key === "sourceId" && tool.id === "image.optimize") {
      const sel = select(name, [["", "جارٍ تحميل الصور…"]], "", { "aria-label": "الصورة المصدر", required: true });
      get("/artifacts?limit=60").then((d) => fill(sel, [h("option", { value: "" }, "اختر صورة"), ...d.artifacts.filter((a) => a.mime.startsWith("image/")).map((a) => h("option", { value: a.id }, `${a.title} · ${fmt.when(a.createdAt)}`))])).catch(() => {});
      return sel;
    }
    return h(rule.max > 300 ? "textarea" : "input", { class: "ops-input", name, maxlength: rule.max, required: rule.required ? true : null, dir: rule.type === "url" || /Id$/.test(key) ? "ltr" : "auto", type: rule.type === "url" ? "url" : null, rows: rule.max > 300 ? 3 : null, placeholder: rule.type === "url" ? "https://…" : "", "aria-label": FIELD_AR[key] || key });
  }
  function readInputs(form, tool) {
    const input = {};
    for (const [key, rule] of Object.entries(tool.input)) {
      const el = form.elements.namedItem(key);
      if (!el) continue;
      if (rule.type === "boolean") { if (el.checked) input[key] = true; continue; }
      const raw = String(el.value ?? "").trim();
      if (!raw) continue;
      input[key] = rule.type === "integer" ? Number(raw) : raw;
    }
    return input;
  }
  function openConsole(tool, presetAgent = null) {
    const granted = tool.grants.filter((g) => g.granted).map((g) => g.agentId);
    const d = O.drawer(`تشغيل: ${tool.ar}`, { wide: true });
    if (!granted.length) { fill(d.body, notice("warn", "لا يوجد وكيل يملك هذه الأداة", "الأداة مسحوبة من كل الوكلاء. أعدها من «الأدوات والصلاحيات» في مساحة الوكيل.")); return; }
    const agentSel = select("agentId__runner", granted.map((id) => [id, agentName(id)]), presetAgent && granted.includes(presetAgent) ? presetAgent : granted[0], { "aria-label": "الوكيل المنفّذ" });
    const result = h("div", { class: "cap-result", "aria-live": "polite" });
    const confirmBox = tool.approval === "always" ? h("label", { class: "co-check-field" }, h("input", { type: "checkbox", name: "__confirm" }), h("span", null, h("strong", null, "أوافق على هذا التشغيل"), h("small", null, `${tool.descriptionAr || tool.description} — هذه الموافقة تُسجَّل مع سجل التنفيذ.`))) : null;
    const fields = Object.entries(tool.input).filter(([, rule]) => rule.type !== "base64").map(([key, rule]) => field(`${FIELD_AR[key] || key}${rule.required ? " *" : ""}`, inputControl(tool, key, rule), rule.type === "integer" ? `${rule.min}–${rule.max}` : null));
    const form = h("form", { class: "co-memory-form", onsubmit: async (event) => {
      event.preventDefault();
      if (confirmBox && !form.elements.namedItem("__confirm").checked) { toast("هذه الأداة تحتاج موافقتك الصريحة قبل التشغيل", "bad"); return; }
      const submit = form.querySelector("[type=submit]");
      fill(result, h("div", { class: "cap-running", role: "status" }, h("span", { class: "cap-spinner", "aria-hidden": "true" }), `${agentName(agentSel.value)} ينفّذ ${tool.ar}… (المهلة ${Math.round(tool.timeoutMs / 1000)} ث)`));
      submit.disabled = true;
      try {
        const out = await mutate("POST", `/capabilities/${tool.id}/execute`, { agentId: agentSel.value, input: readInputs(form, tool), confirm: confirmBox ? true : undefined });
        renderResult(result, tool, out);
        toast("اكتمل التنفيذ وحُفظ في سجل التدقيق", "ok");
        loadRegistry().then(() => { if (ui.section === "library") rerender(); });
      } catch (error) {
        fill(result, notice("bad", "لم يكتمل التنفيذ", `${error.code || ""} ${error.message}`.trim(), error.details?.errors ? h("ul", { class: "co-bullets" }, [].concat(error.details.errors).map((x) => h("li", { dir: "ltr" }, x))) : null),
          error.details?.executionId ? h("p", { class: "ops-dim" }, "سُجّل الرفض في سجل التدقيق: ", bdi(error.details.executionId)) : null);
      } finally { submit.disabled = false; }
    } },
      h("p", null, tool.descriptionAr || tool.description), h("p", { class: "ops-dim cap-tech", dir: "ltr" }, tool.description), toolMeta(tool),
      field("الوكيل المنفّذ (تُطبَّق صلاحياته)", agentSel), ...fields, confirmBox,
      h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, icon("play", 18), "تشغيل الآن")));
    fill(d.body, form, result);
  }
  /** Result view: artifacts first, then a role-aware summary (charts for telemetry, findings for security), then JSON. */
  function renderResult(host, tool, { execution, result }) {
    const parts = [h("div", { class: "cap-result-head" }, execBadge(execution.status), h("span", null, `${fmt.ms(execution.durationMs)} · `, bdi(execution.id, "co-tech-soft")))];
    if (result?.artifactIds?.length) parts.push(h("div", { class: "cap-art-grid" }, result.artifactIds.map((id) => artifactCard({ id, ...(result.artifact?.id === id ? result.artifact : {}) }, { compact: true }))));
    const summary = summarize(tool.id, result);
    if (summary) parts.push(summary);
    parts.push(h("details", { class: "ops-panel" }, h("summary", null, "المخرجات الكاملة (JSON)"), h("pre", { class: "co-json", dir: "ltr" }, JSON.stringify(Object.fromEntries(Object.entries(result || {}).filter(([k]) => k !== "artifact")), null, 2).slice(0, 20000))));
    fill(host, ...parts);
  }
  function summarize(toolId, r) {
    if (!r) return null;
    if (toolId === "telemetry.agentStats") {
      const agents = r.agents || [];
      return h("div", null, chart(barChart({ categories: agents.map((a) => agentName(a.agentId)), series: [{ name: "نجح", stack: "s", data: agents.map((a) => a.byStatus.succeeded) }, { name: "فشل", stack: "s", data: agents.map((a) => a.byStatus.failed) }, { name: "متوقف", stack: "s", data: agents.map((a) => a.byStatus.blocked) }] }), { label: "تشغيلات الوكلاء حسب الحالة" }),
        h("p", { class: "ops-dim" }, r.basis));
    }
    if (toolId === "telemetry.toolLatency") {
      const tools = (r.tools || []).slice(0, 12);
      return tools.length ? chart(barChart({ horizontal: true, categories: tools.map((t) => t.toolId), series: [{ name: "p50", data: tools.map((t) => t.latencyMs.p50 ?? 0) }, { name: "p95", data: tools.map((t) => t.latencyMs.p95 ?? 0) }], unit: " م.ث" }), { height: Math.max(220, tools.length * 34), label: "زمن الأدوات" }) : empty("لا تنفيذات في الفترة.");
    }
    if (toolId === "telemetry.providerCompare") {
      const models = (r.models || []).slice(0, 10);
      return models.length ? chart(barChart({ horizontal: true, categories: models.map((m) => m.ref.split("/").slice(-1)[0]), series: [{ name: "نسبة النجاح %", data: models.map((m) => m.successRatePct) }], unit: "%" }), { height: Math.max(200, models.length * 34), label: "مقارنة النماذج" }) : empty("لا محاولات نماذج مسجلة في الفترة.");
    }
    if (toolId === "security.gitleaks") {
      const rows = (r.checkouts || []).flatMap((c) => (c.findings || []).map((f) => [c.rel, f.rule, f.file, f.line, f.commit]));
      const failed = (r.checkouts || []).filter((c) => !c.ok);
      return h("div", null, failed.length ? notice("warn", "لم يكتمل الفحص لبعض النسخ", failed.map((c) => `${c.rel}: ${c.error}`).join(" · ")) : null,
        rows.length ? table(["النسخة", "القاعدة", "الملف", "السطر", "Commit"], rows) : notice("info", "لا أسرار مكتشفة", `${r.method}. لا يعني ذلك غياب الأسرار نهائيًا.`), h("p", { class: "ops-dim" }, "القيم السرية لا تُعرض ولا تُخزَّن."));
    }
    if (toolId === "security.osv") {
      const rows = (r.checkouts || []).flatMap((c) => (c.vulnerable || []).map((v) => [`${v.name}@${v.version}`, v.ecosystem, v.advisories.map((a) => a.id).join("، "), v.advisories.flatMap((a) => a.fixed).join("، ") || "—"]));
      return rows.length ? table(["الحزمة", "النظام", "التنبيهات", "الإصدار المصحح"], rows) : notice("info", "لا ثغرات معروفة في الحزم المفحوصة", r.dataSent);
    }
    if (toolId === "web.extract") return h("div", { class: "cap-web" }, h("h4", null, r.title || r.url), r.warning ? notice("warn", "نص موجّه للذكاء الاصطناعي داخل الصفحة", "حُفظ كبيانات ولم يُنفَّذ أي شيء منه.") : null,
      h("p", { class: "co-pre", dir: "auto" }, r.excerpt), h("small", { class: "ops-dim" }, `${r.citation} · ${fmt.when(r.fetchedAt)}${r.truncated ? " · مقتطف محدود" : ""}`));
    if (toolId === "knowledge.search") return r.results?.length ? h("ul", { class: "co-knowledge-results" }, r.results.map((x) => h("li", null, h("strong", null, x.title), h("p", null, x.excerpt), h("small", null, `${x.citation} · ${x.source}`)))) : empty("لا نتائج.");
    if (toolId === "knowledge.freshness") return table(["المصدر", "النوع", "الحالة"], (r.sources || []).map((s) => [s.title, s.sourceType, { fresh: "حديث", stale: "قديم", changed: "تغيّر", missing: "غير متاح", unreachable: "تعذّر الوصول" }[s.state] || s.state]));
    if (toolId === "company.overview") return h("div", { class: "os-kpis" }, O.kpi({ label: "مهام مفتوحة", value: r.tasks.open }), O.kpi({ label: "متأخرة", value: r.tasks.overdue.length, tone: r.tasks.overdue.length ? "warn" : null }), O.kpi({ label: "متعطّلة", value: r.tasks.blocked.length }), O.kpi({ label: "موافقات معلّقة", value: r.approvalsPending }));
    if (toolId === "approvals.followupTasks") return notice("info", `أُنشئت ${r.created.length} مهمة متابعة`, r.skipped.length ? `${r.skipped.length} موجودة مسبقًا ولم تتكرر.` : null);
    return null;
  }
  const table = (cols, rows) => h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table" }, h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col" }, c)))),
    h("tbody", null, rows.slice(0, 200).map((r) => h("tr", null, r.map((v) => h("td", { dir: "auto" }, v == null ? "—" : String(v))))))));

  // ------------------------------------------------------------------ artifacts
  const KIND_AR = { image: "صورة", canvas: "تصميم لوحة", pdf: "تقرير PDF", calendar: "تقويم ICS", report: "تقرير" };
  function artifactCard(a, { compact = false, onChange = null } = {}) {
    const isImage = !a.mime || a.mime.startsWith("image/");
    const view = `/local-api/company/artifacts/${encodeURIComponent(a.id)}/view`, download = `/local-api/company/artifacts/${encodeURIComponent(a.id)}/download`;
    const thumb = isImage ? h("a", { class: "cap-art-thumb", href: view, target: "_blank", rel: "noopener" }, h("img", { src: view, alt: a.title || "ملف ناتج", loading: "lazy", decoding: "async" }))
      : h("a", { class: "cap-art-thumb cap-art-doc", href: a.mime === "application/pdf" ? view : download, target: a.mime === "application/pdf" ? "_blank" : null, rel: "noopener" }, icon(a.mime === "text/calendar" ? "calendar" : "download", 34), h("span", null, KIND_AR[a.kind] || a.kind || "ملف"));
    const setState = (state, trigger) => act(trigger, () => mutate("PATCH", `/artifacts/${a.id}`, { state }), state === "approved" ? "اعتُمد الملف" : "حُدّث الملف").then((r) => { if (r) onChange?.(); });
    return h("article", { class: "cap-art-card" }, thumb,
      h("div", { class: "cap-art-info" },
        h("strong", { title: a.title }, a.title || a.id),
        a.agentId ? h("small", { class: "ops-dim" }, C.avatar(a.agentId, "xs"), ` ${agentName(a.agentId)}${a.projectId ? ` · ${C.projectName(a.projectId) || "مشروع"}` : ""}${a.createdAt ? ` · ${fmt.relative(a.createdAt)}` : ""}`) : null,
        a.state ? badge(a.state === "approved" ? "ok" : a.state === "archived" ? "muted" : "info", a.state === "approved" ? "معتمد" : a.state === "archived" ? "مؤرشف" : "مسودة") : null),
      h("div", { class: "cap-art-actions" }, h("a", { class: "btn btn-secondary co-btn", href: download, download: a.filename || "" }, icon("download", 16), "تنزيل"),
        !compact && a.state !== "approved" ? button("اعتماد", (e) => setState("approved", e.currentTarget), { kind: "primary" }) : null,
        !compact && a.state !== "archived" ? button("أرشفة", (e) => setState("archived", e.currentTarget)) : null,
        !compact ? button("حذف", async (e) => { if (!await O.confirmDialog({ title: "حذف الملف الناتج؟", body: "سيُحذف الملف نهائيًا. يبقى سجل تنفيذ الأداة التي أنتجته.", confirm: "حذف", tone: "danger" })) return; if (await act(e.currentTarget, () => mutate("DELETE", `/artifacts/${a.id}`), "حُذف الملف")) onChange?.(); }) : null));
  }
  function artifactGallery(host, { agentId = null, title = "الملفات الناتجة" } = {}) {
    const grid = h("div", { class: "cap-art-grid" }, O.skeleton(2));
    const kinds = select("kind", [["", "كل الأنواع"], ...Object.entries(KIND_AR)], "", { "aria-label": "نوع الملف" });
    const refresh = async () => {
      try {
        const q = new URLSearchParams({ limit: "60", ...(agentId ? { agentId } : {}), ...(kinds.value ? { kind: kinds.value } : {}) });
        const list = (await get(`/artifacts?${q}`)).artifacts;
        fill(grid, list.length ? list.map((a) => artifactCard(a, { onChange: refresh })) : empty(agentId ? "لم ينتج هذا الوكيل ملفات بعد. شغّل إحدى أدواته." : "لا ملفات ناتجة بعد."));
      } catch (error) { fill(grid, notice("bad", "تعذر تحميل الملفات", error.message)); }
    };
    kinds.addEventListener("change", refresh);
    refresh();
    return panelX({ title, hint: "صور وتقارير وتقاويم أنتجتها الأدوات. «معتمد» قرار المالك وحده.", actions: kinds }, grid);
  }

  // ------------------------------------------------------------------ execution audit
  function auditPanel(host, { agentId = null } = {}) {
    const body = h("div", null, O.skeleton(3));
    const status = select("status", [["", "كل الحالات"], ...Object.entries(EXEC_AR).map(([k, [, v]]) => [k, v])], "", { "aria-label": "حالة التنفيذ" });
    const state = { before: null, rows: [], more: false };
    const draw = () => fill(body, state.rows.length ? [h("div", { class: "ops-tablewrap" }, h("table", { class: "ops-table cap-audit" },
      h("thead", null, h("tr", null, ["الوقت", "الأداة", "الوكيل", "المنفّذ", "الحالة", "المدة", "الملفات"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", null, state.rows.map((e) => h("tr", null, h("td", null, fmt.when(e.startedAt)), h("th", { scope: "row" }, bdi(e.toolId, "co-tech-soft")), h("td", null, agentName(e.agentId)),
        h("td", null, { owner: "المالك", agent: "الوكيل", mcp: "MCP" }[e.actorType] || e.actorType), h("td", null, execBadge(e.status), e.errorMessage ? h("small", { class: "ops-dim", title: e.errorMessage }, ` ${e.errorCode}`) : null),
        h("td", null, fmt.ms(e.durationMs)), h("td", null, e.artifactIds.length ? String(e.artifactIds.length) : "—")))))),
      state.more ? h("div", { class: "co-form-actions" }, button("عرض المزيد", () => load(true))) : null] : empty("لا تنفيذات مسجلة بعد."));
    async function load(append = false) {
      try {
        const q = new URLSearchParams({ limit: "30", ...(agentId ? { agentId } : {}), ...(status.value ? { status: status.value } : {}), ...(append && state.before ? { before: state.before } : {}) });
        const rows = (await get(`/executions?${q}`)).executions;
        state.rows = append ? [...state.rows, ...rows] : rows; state.before = rows.at(-1)?.startedAt ?? state.before; state.more = rows.length === 30;
        draw();
      } catch (error) { fill(body, notice("bad", "تعذر تحميل سجل التنفيذ", error.message)); }
    }
    status.addEventListener("change", () => load(false));
    load();
    return panelX({ title: "سجل تنفيذ الأدوات", hint: "كل محاولة — بما فيها المرفوضة — محفوظة مع مدخلاتها المنقّحة ونتيجتها.", actions: status }, body);
  }

  // ------------------------------------------------------------------ library (tab «الأدوات والمهارات»)
  let host = null;
  function rerender() { if (host?.isConnected) renderLibrary(host); }
  function libraryCard(t) {
    return h("article", { class: `cap-card cap-${t.availability}`, "data-tool": t.id, "data-agents": t.grants.filter((g) => g.granted).map((g) => g.agentId).join(" "), "data-search": `${t.id} ${t.ar} ${t.descriptionAr || ""} ${t.description}`.toLowerCase() },
      h("header", { class: "cap-card-head" }, h("div", null, h("h3", null, t.ar), bdi(t.id, "co-tech-soft")), grantChips(t)),
      h("p", { class: "cap-desc" }, t.descriptionAr || t.description),
      toolMeta(t),
      t.availability === "unavailable" ? h("p", { class: "ops-bad-text" }, t.health?.reason) : t.availability === "disabled" ? h("p", { class: "ops-dim" }, `معطّلة: ${t.disabledReason || "بقرار المالك"}`) : null,
      h("footer", { class: "cap-card-foot" },
        h("small", { class: "ops-dim" }, t.executions.total ? `${fmt.num(t.executions.total)} تنفيذ · آخرها ${fmt.relative(t.executions.lastAt)}` : "لم تُستخدم بعد"),
        h("div", { class: "ops-actions" },
          t.availability === "available" && t.grants.some((g) => g.granted) && t.sideEffect !== "proposal" && !t.id.startsWith("router.") ? button("تشغيل", () => openConsole(t), { kind: "primary", icon: "play" }) : null,
          button(t.enabled ? "تعطيل" : "تفعيل", async (e) => {
            let reason = null;
            if (t.enabled) { reason = await O.promptDialog({ title: `تعطيل ${t.ar}`, label: "سبب التعطيل (يظهر للوكلاء في سجل الرفض)", confirm: "تعطيل", maxlength: 200 }); if (reason == null) return; }
            if (await act(e.currentTarget, () => mutate("PATCH", `/capabilities/${t.id}`, { enabled: !t.enabled, reason }), t.enabled ? "عُطّلت القدرة" : "فُعّلت القدرة")) { await loadRegistry(); rerender(); }
          }))));
  }
  /** Filters cards in place, so typing in the search box never rebuilds the page or loses focus. */
  function applyFilter(root) {
    const q = ui.query.trim().toLowerCase();
    let visible = 0;
    for (const card of root.querySelectorAll(".cap-card")) {
      const show = (!q || card.dataset.search.includes(q)) && (!ui.agent || card.dataset.agents.split(" ").includes(ui.agent));
      card.hidden = !show; if (show) visible++;
    }
    for (const group of root.querySelectorAll(".cap-group")) group.hidden = ![...group.querySelectorAll(".cap-card")].some((c) => !c.hidden);
    const counter = root.querySelector(".cap-count"); if (counter) counter.textContent = `${visible} قدرة معروضة`;
  }
  function renderLibrary(root) {
    host = root;
    if (!ui.registry) { fill(root, ui.error ? notice("bad", "تعذر تحميل سجل القدرات", ui.error) : O.skeleton(5)); if (!ui.loading) loadRegistry().then(rerender); return; }
    const reg = ui.registry;
    const sections = [["library", "مكتبة القدرات"], ["files", "الملفات الناتجة"], ["audit", "سجل التنفيذ"]];
    const tabs = h("nav", { class: "os-tabs cap-tabs", "aria-label": "أقسام الأدوات" }, sections.map(([id, text]) => h("button", { type: "button", class: `os-tab${ui.section === id ? " os-tab-current" : ""}`, "aria-pressed": String(ui.section === id), onclick: () => { ui.section = id; rerender(); } }, text)));
    const count = (s) => reg.filter((t) => t.availability === s).length;
    const head = [O.sectionShell({ id: "capabilities", title: "الأدوات والمهارات", subtitle: "كل قدرة مسجلة في الخادم بصلاحيات وحدود وسجل تدقيق. الظهور في الواجهة لا يعني الإذن: الخادم يتحقق من كل استدعاء.",
      actions: [button("فحص الاعتماديات", async (e) => { e.currentTarget.disabled = true; await loadRegistry(true); rerender(); }, { icon: "refresh" })] }),
      h("div", { class: "os-kpis" }, O.kpi({ label: "قدرات مسجلة", value: reg.length, ic: "sparkle" }), O.kpi({ label: "متاحة الآن", value: count("available"), tone: "ok", ic: "check" }),
        O.kpi({ label: "غير متاحة", value: count("unavailable"), tone: count("unavailable") ? "warn" : null, hint: count("unavailable") ? "اعتمادية أو برنامج غير مثبت" : null, ic: "alert" }), O.kpi({ label: "معطّلة من المالك", value: count("disabled"), ic: "shield" })), tabs];
    if (ui.section === "files") { fill(root, ...head, artifactGallery(root)); return; }
    if (ui.section === "audit") { fill(root, ...head, auditPanel(root)); return; }
    const search = h("input", { class: "ops-input", type: "search", value: ui.query, placeholder: "ابحث باسم القدرة أو وصفها…", "aria-label": "بحث القدرات", oninput: (e) => { ui.query = e.currentTarget.value; applyFilter(root); } });
    const agentSel = select("agentFilter", [["", "كل الوكلاء"], ...["ori", "mia", "nex", "luna", "zen", "rex"].map((id) => [id, agentName(id)])], ui.agent, { "aria-label": "تصفية حسب الوكيل", onchange: (e) => { ui.agent = e.currentTarget.value; applyFilter(root); } });
    const groups = CATEGORY_ORDER.map((cat) => [cat, reg.filter((t) => t.category === cat)]).filter(([, list]) => list.length);
    fill(root, ...head,
      h("div", { class: "co-memory-toolbar" }, search, agentSel, h("span", { class: "cap-count ops-dim", "aria-live": "polite" })),
      ...groups.map(([cat, list]) => h("section", { class: "cap-group", "aria-label": CATEGORY_AR[cat] }, h("h3", { class: "cap-group-title" }, CATEGORY_AR[cat] || cat, h("small", null, ` · ${list.length}`)), h("div", { class: "cap-grid" }, list.map(libraryCard)))));
    applyFilter(root);
  }

  // ------------------------------------------------------------------ per-agent workspace panels
  function agentTools(def) {
    const box = h("div", null, O.skeleton(3));
    const draw = () => {
      const mine = (ui.registry || []).filter((t) => t.grants.some((g) => g.agentId === def.id));
      const specialist = mine.filter((t) => t.version === "5.0");
      fill(box, specialist.length ? h("div", { class: "cap-grid" }, specialist.map((t) => {
        const g = t.grants.find((x) => x.agentId === def.id);
        return h("article", { class: `cap-card cap-${t.availability}` }, h("header", { class: "cap-card-head" }, h("div", null, h("h3", null, t.ar), bdi(t.id, "co-tech-soft"))),
          h("p", { class: "cap-desc" }, t.descriptionAr || t.description), toolMeta(t), !g.granted ? h("p", { class: "ops-dim" }, "سحبها المالك من هذا الوكيل.") : t.availability === "unavailable" ? h("p", { class: "ops-bad-text" }, t.health?.reason) : null,
          h("footer", { class: "cap-card-foot" }, h("small", { class: "ops-dim" }, t.executions.total ? `${t.executions.total} تنفيذ` : "لم تُستخدم بعد"),
            g.granted && t.availability === "available" ? button("تشغيل", () => openConsole(t, def.id), { kind: "primary", icon: "play" }) : null));
      })) : empty("لا قدرات متخصصة مسجلة لهذا الوكيل."));
    };
    if (ui.registry) draw(); else loadRegistry().then(draw);
    return panel(`قدرات ${def.name} المتخصصة`, "أدوات حقيقية تعمل في الخادم ضمن صلاحيات هذا الوكيل. النتائج والملفات محفوظة.", box);
  }

  // ------------------------------------------------------------------ MIA studio (Fabric.js in the browser; server validates and re-encodes)
  function studio() {
    const W = 1200, Hh = 675;
    const stage = h("div", { class: "cap-studio-stage" }, h("canvas", { width: W, height: Hh, "aria-label": "لوحة تصميم MIA" }));
    const status = h("p", { class: "ops-dim", role: "status" }, "جارٍ تحميل محرر القوالب…");
    const templates = select("template", [["", "قالب محفوظ…"]], "", { "aria-label": "القوالب المحفوظة" });
    const agentArt = select("art", [["", "صورة وكيل معتمدة…"], ...["ori", "mia", "nex", "luna", "zen", "rex"].map((id) => [id, agentName(id)])], "", { "aria-label": "إضافة صورة وكيل" });
    const toolbar = h("div", { class: "cap-studio-tools", role: "toolbar", "aria-label": "أدوات التصميم" });
    let canvas = null;
    const loadTemplates = () => get("/templates").then((d) => { fill(templates, [h("option", { value: "" }, d.templates.length ? "قالب محفوظ…" : "لا قوالب بعد"), ...d.templates.map((t) => h("option", { value: t.id }, t.name))]); templates.__list = d.templates; }).catch(() => {});
    vendor("fabric", "fabric").then((fabric) => {
      canvas = new fabric.Canvas(stage.querySelector("canvas"), { backgroundColor: "#4c1d95", preserveObjectStacking: true });
      const fit = () => { const w = stage.clientWidth || W; canvas.setDimensions({ width: `${w}px`, height: `${(w * Hh) / W}px` }, { cssOnly: true }); };
      new ResizeObserver(fit).observe(stage); fit();
      const addText = (text, opts) => { const t = new fabric.Textbox(text, { left: W - 760, top: 120, width: 700, fontSize: 64, fontFamily: "Alexandria, Segoe UI, sans-serif", fill: "#ffffff", textAlign: "right", direction: "rtl", ...opts }); canvas.add(t); canvas.setActiveObject(t); canvas.requestRenderAll(); };
      const tool = (text, ic, fn) => button(text, fn, { icon: ic });
      fill(toolbar,
        tool("عنوان", "plus", () => addText("عنوان جديد", {})), tool("نص", "plus", () => addText("نص توضيحي", { fontSize: 32, top: 260 })),
        tool("شريط لوني", "plus", () => { const r = new fabric.Rect({ left: W - 260, top: 60, width: 200, height: 44, rx: 22, ry: 22, fill: "#f59e0b" }); canvas.add(r); canvas.setActiveObject(r); }),
        agentArt,
        tool("خلفية بنفسجية", "sparkle", () => { canvas.backgroundColor = "#4c1d95"; canvas.requestRenderAll(); }), tool("خلفية فاتحة", "sparkle", () => { canvas.backgroundColor = "#faf8ff"; canvas.requestRenderAll(); }),
        tool("حذف المحدد", "close", () => { for (const o of canvas.getActiveObjects()) canvas.remove(o); canvas.discardActiveObject(); canvas.requestRenderAll(); }),
        templates,
        button("حفظ كقالب", async (e) => {
          const name = await O.promptDialog({ title: "حفظ القالب", label: "اسم القالب", maxlength: 80 }); if (!name) return;
          // Fabric stores image sources as absolute URLs; bundled agent artwork is saved by its relative path so a template
          // never depends on this port, and the server accepts only embedded or bundled images.
          const spec = JSON.parse(JSON.stringify(canvas.toJSON()).split(`${location.origin}/internal/assets/agents/`).join("./internal/assets/agents/"));
          if (await act(e.currentTarget, () => mutate("POST", "/templates", { name, width: W, height: Hh, spec }), "حُفظ القالب")) loadTemplates();
        }, { icon: "database" }),
        button("تصدير وحفظ كملف", async (e) => {
          const title = await O.promptDialog({ title: "حفظ التصميم", label: "عنوان الملف", value: "تصميم من استوديو MIA", maxlength: 120 }); if (!title) return;
          canvas.discardActiveObject(); canvas.requestRenderAll();
          const data = canvas.toDataURL({ format: "png", multiplier: 1 }).split(",")[1];
          const out = await act(e.currentTarget, () => mutate("POST", "/capabilities/design.saveCanvas/execute", { agentId: "mia", input: { title, imageBase64: data, templateId: templates.value || undefined } }), "حُفظ التصميم في الملفات الناتجة");
          if (out) status.textContent = `حُفظ كملف ${out.result.artifactIds[0]} — راجعه في «الملفات».`;
        }, { kind: "primary", icon: "download" }));
      agentArt.addEventListener("change", async () => {
        if (!agentArt.value) return;
        const img = await fabric.FabricImage.fromURL(`./internal/assets/agents/${agentArt.value}-card.webp`);
        img.scaleToHeight(420); img.set({ left: 60, top: 140 }); canvas.add(img); canvas.setActiveObject(img); agentArt.value = "";
      });
      templates.addEventListener("change", async () => {
        const tpl = templates.__list?.find((t) => t.id === templates.value); if (!tpl) return;
        await canvas.loadFromJSON(tpl.spec); canvas.requestRenderAll(); status.textContent = `حُمّل القالب «${tpl.name}».`;
      });
      stage.tabIndex = 0;
      stage.addEventListener("keydown", (e) => { if ((e.key === "Delete" || e.key === "Backspace") && !canvas.getActiveObject()?.isEditing) { for (const o of canvas.getActiveObjects()) canvas.remove(o); canvas.discardActiveObject(); canvas.requestRenderAll(); } });
      addText("ABUD FUN", { top: 80, fontSize: 40 });
      status.textContent = "المحرر جاهز. التصدير يمر بتحقق الخادم (PNG فقط، حتى 4096 بكسل) ثم يُحفظ كملف ناتج لـ MIA.";
      loadTemplates();
    }).catch((error) => { status.textContent = ""; fill(toolbar, notice("bad", "تعذر تحميل محرر القوالب", error.message)); });
    return panel("استوديو القوالب", "محرر Fabric.js يعمل في المتصفح. صور الوكلاء المعتمدة تُضاف كما هي دون تعديل.", toolbar, stage, status);
  }

  window.AbudCapabilities = { renderLibrary, agentTools, artifactGallery, auditPanel, studio, openConsole, chart, barChart, vendor, loadRegistry, registry: () => ui.registry };
})();
