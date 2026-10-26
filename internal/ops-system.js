/* ABUD FUN Company OS V2 — النظام (System Center): local services, integrations, the activity timeline, data & backups,
 * security boundaries and settings, as contextual tabs. Values come from bridge responses only; anything not connected is
 * labelled "غير مُعدّ" without numbers. Absolute filesystem paths are never requested or shown. It also runs the idempotent
 * browser-storage migration once per change of the legacy data, so old Workboard tasks reach the company store. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O) return;
  const { h, fill, fmt, badge, notice, L, label, bdi, icon, panel, panelX, empty, button, linkButton, field, select, kpi, segmented, href, act, mutate, invalidate, toast, store, api } = O;

  const sOverview = O.section("opsInfra", "system", "overview");
  const sIntegrations = O.section("sysIntegrations", "system", "integrations");
  const sActivity = O.section("coActivity", "system", "activity");
  const sData = O.section("sysData", "system", "data");
  const sSecurity = O.section("sysSecurity", "system", "security");
  const sSettings = O.section("coSettings", "system", "settings");
  const sRegistry = O.section("sysRegistry", "system", "registry");
  // Read-only developer-tool discovery (Codex / Antigravity / Claude Code) belongs with the integrations.
  const devTools = document.getElementById("agentSystem");
  if (devTools) sIntegrations.after(devTools);

  const co = (key) => O.peek(`co:${key}`)?.data;
  const stateBadge = (state) => ({ running: badge("ok", "يعمل"), connected: badge("ok", "متصل"), partial: badge("warn", "متصل جزئيًا"), "not-configured": badge("muted", "غير مُعدّ"), offline: badge("bad", "غير متصل"), unsupported: badge("muted", "غير مدعوم"), "auth-required": badge("bad", "يحتاج مفتاحًا") }[state] || badge("muted", state || "غير معروف"));
  // How the previous bridge process ended, as classified by the bridge from its lifecycle record at start-up.
  const PREVIOUS_EXIT = { "system-restart": badge("muted", "انتهت مع إعادة تشغيل Windows"), "fatal-error": badge("bad", "توقفت بخطأ داخلي مسجل"), "unexpected-exit": badge("warn", "توقفت دون إيقاف نظيف") };
  const backupTime = (name) => { const m = /^company-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name || ""); return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null; };
  const kb = (bytes) => bdi(Number.isFinite(bytes) ? (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`) : "—", "co-tech-soft");
  const card = (ic, title, stateNode, lines, link) => h("article", { class: "sy-card" },
    h("div", { class: "sy-card-head" }, h("span", { class: "sy-card-icon" }, icon(ic, 22)), h("div", { class: "sy-card-title" }, h("h3", null, title), stateNode)),
    lines?.length ? h("dl", null, lines.filter(Boolean).map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v)))) : null,
    link || null);

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const infra = O.peek("infra")?.data;
    if (!infra) { fill(sOverview, O.resourceStatus(O.peek("infra"), "حالة النظام") || O.skeleton(4)); return; }
    const settings = co("settings");
    const lastBackup = settings?.store?.backups?.find((backup) => backup.healthy);
    const backupAt = backupTime(lastBackup?.name);
    const tools = O.peek("agents")?.data?.agents;
    const installed = tools?.filter((t) => t.install?.state === "installed").length;
    const notes = (co("notifications")?.notifications || []).filter((n) => !n.acknowledged_at && (n.level === "critical" || n.kind === "agent-error" || n.kind === "router" || n.kind === "bridge"));
    const bridge = infra.local.bridge;
    fill(sOverview,
      h("div", { class: "sy-cards" },
        card("system", "Local Bridge", stateBadge(bridge.state), [["الربط", bdi(bridge.bind)], ["Node", bdi(bridge.node)], ["مدة التشغيل", `${Math.round(bridge.uptimeSec / 60)} دقيقة`],
          Number.isFinite(bridge.memoryMb) ? ["الذاكرة", bdi(`${bridge.memoryMb} MB`, "co-tech-soft")] : null,
          bridge.startedAt ? ["الجلسة السابقة", PREVIOUS_EXIT[bridge.previousExit?.kind] || badge("ok", "أُغلقت بشكل نظيف")] : null]),
        card("resources", "OmniRoute", stateBadge(infra.local.router.state), [["الإصدار", bdi(infra.local.router.version || "—")], ["العنوان", bdi(infra.local.router.host || "—")]], linkButton("الموارد الذكية", href("resources"), { icon: "chevronLeft" })),
        card("database", "قاعدة بيانات الشركة", badge("ok", "SQLite"), [["إصدار المخطط", String(infra.local.store.schemaVersion)], ["الحجم", kb(infra.local.store.bytes)], ["النسخ الاحتياطية", String(infra.local.store.backups)]], linkButton("البيانات والنسخ", href("system", "data"), { icon: "chevronLeft" })),
        card("download", "آخر نسخة احتياطية", backupAt ? badge(Date.now() - Date.parse(backupAt) > 7 * 86_400_000 ? "warn" : "ok", fmt.relative(backupAt)) : badge("warn", "لا يوجد"), [["الوقت", backupAt ? fmt.when(backupAt) : "—"], ["الحجم", lastBackup ? kb(lastBackup.bytes) : "—"]],
          button("نسخة احتياطية الآن", (e) => backupNow(e.currentTarget), { icon: "database" })),
        card("agents", "أدوات التطوير المحلية", tools ? badge(installed ? "ok" : "muted", `${installed}/${tools.length} مثبّتة`) : badge("muted", "جارٍ الفحص"), tools ? tools.map((t) => [t.name, t.install?.version ? `v${t.install.version}` : "غير موجود"]) : [], linkButton("التكاملات", href("system", "integrations"), { icon: "chevronLeft" })),
        card("globe", "البنية البعيدة", stateBadge(infra.connectors[0]?.state), infra.connectors.map((c) => [c.ar, h("span", null, stateBadge(c.state), c.detail ? ` ${c.detail}` : "")]), linkButton("السيرفرات", href("system", "servers"), { icon: "chevronLeft" }))),
      panelX({ title: "أخطاء النظام المهمة", hint: "انقطاع الراوتر، أعطال الوكلاء، والتنبيهات الحرجة غير المُقرّة." },
        notes.length ? C.notificationList(notes) : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا أخطاء نظام مفتوحة."))));
  }
  async function backupNow(trigger) {
    const r = await act(trigger, () => mutate("POST", "/backup", {}), "أُنشئت نسخة احتياطية متسقة");
    if (r) { invalidate("settings", "activity"); api.infra(true); }
  }

  // ---------------------------------------------------------------- integrations
  function renderIntegrations() {
    const s = O.peek("settings")?.data;
    const infra = O.peek("infra")?.data;
    const account = O.peek("account")?.data?.account;
    if (!s || !infra) { fill(sIntegrations, O.resourceStatus(O.peek("settings"), "التكاملات") || O.skeleton(3)); return; }
    const yes = (v, ok = "نعم", no = "لا") => (v ? badge("ok", ok) : badge("bad", no));
    fill(sIntegrations,
      h("div", { class: "sy-cards" },
        card("resources", "OmniRoute", stateBadge(infra.local.router.state), [["العنوان", h("span", null, bdi(s.router.host || "—"), " ", s.router.loopback ? badge("ok", "محلي") : badge("bad", "بعيد"))], ["مفتاح API مُعدّ", yes(s.router.keyConfigured)], ["الأسرار المعادة للمتصفح", badge("ok", "لا شيء")], ["الكتابة إلى الراوتر", s.router.writesEnabled ? badge("warn", "مفعّلة بموافقة") : badge("ok", "معطّلة")]]),
        card("globe", "GitHub", account ? badge("ok", "متصل") : badge("muted", "غير متصل"), [["الحساب المحلي (gh)", account ? bdi(account) : "غير متاح"], ["بيانات الكتالوج العام", "عند الطلب من «عالم المشاريع»"], ["الكتابة إلى GitHub", badge("ok", "لا يوجد")]]),
        card("branch", "مجلدات المستودعات المحلية", s.workspace.configured ? badge("ok", "مُعدّة") : badge("warn", "غير مُعدّة"), [["المجلدات", s.workspace.roots.map((r) => r.label).join("، ") || "—"], ["المسارات الكاملة", "لا تُرسل للمتصفح"], ["العوالم المحلية", s.worlds.configured ? String(s.worlds.worldCount) : "غير مُعدّة"]]),
        card("shield", "سياسة التوجيه الاستشارية", s.policy.valid ? badge("ok", "صالحة") : badge("bad", "مرفوضة"), [["المصدر", bdi(s.policy.source)], ...(s.policy.errors.length ? [["أخطاء", s.policy.errors.join("؛ ")]] : []), ["التطبيق على الراوتر", "لا يُكتب إليه"]])),
      panel("موصلات البنية التحتية", "فحوص SSH للقراءة فقط بمفتاح المالك الموجود (بالمسار فقط، لا يُقرأ ولا يُرسل) مع تثبيت بصمة الخادم، وفحوص HTTPS وTLS من هذا الجهاز. الإجراءات على الخادم تحتاج موافقتك على كل إجراء.",
        h("ul", { class: "ops-list" }, infra.connectors.map((c) => h("li", null, h("strong", null, c.ar), stateBadge(c.state), c.detail ? h("span", null, c.detail) : null))),
        linkButton("مركز السيرفرات", href("system", "servers"), { icon: "globe" })));
  }

  // ---------------------------------------------------------------- activity timeline
  const act$ = { actor: "", agent: "", project: "", outcome: "", query: "", extra: [], exhausted: false };
  let actHost = null, actSearch = null;
  function renderActivity() {
    if (!C) return;
    const events = co("activity")?.events;
    if (!events) { fill(sActivity, O.resourceStatus(O.peek("co:activity"), "سجل النشاط") || O.skeleton(5)); return; }
    if (!actSearch) actSearch = h("input", { class: "ops-input pj-search", type: "search", placeholder: "ابحث في الأحداث…", "aria-label": "بحث في سجل النشاط", oninput: (e) => { act$.query = e.target.value; renderActivityList(); } });
    actHost = h("div");
    const notes = co("notifications")?.notifications || [];
    fill(sActivity,
      notes.length ? panelX({ title: `التنبيهات المفتوحة (${notes.length})`, hint: "التنبيهات المتكررة تُدمج؛ الإقرار لا يحذف السجل." }, C.notificationList(groupQuota(notes))) : null,
      panelX({ title: "الخط الزمني", hint: "سجل تدقيق: من فعل ماذا، بأي نتيجة، ومن أي مصدر. التفاصيل التقنية خلف «تفاصيل تقنية»." },
        h("div", { class: "sy-filters" },
          segmented([["", "الكل"], ["owner", "المالك"], ["agent", "الوكلاء"], ["system", "النظام"]], act$.actor, (v) => { act$.actor = v; renderActivity(); }, "تصفية بالفاعل"),
          actSearch,
          select("agent", [["", "كل الوكلاء"], ...C.agentsDef().map((a) => [a.id, a.name])], act$.agent, { "aria-label": "تصفية بالوكيل", onchange: (e) => { act$.agent = e.target.value; renderActivityList(); } }),
          select("project", [["", "كل المشاريع"], ...C.projectOptions(false)], act$.project, { "aria-label": "تصفية بالمشروع", onchange: (e) => { act$.project = e.target.value; renderActivityList(); } }),
          select("outcome", [["", "كل النتائج"], ["failure", "فشل"], ["blocked", "متوقف"], ["pending", "بانتظار"], ["success", "نجح"], ["info", "معلومة"]], act$.outcome, { "aria-label": "تصفية بالخطورة", onchange: (e) => { act$.outcome = e.target.value; renderActivityList(); } })),
        actHost));
    renderActivityList();
  }
  /** Quota notifications for the same provider are shown as one grouped line (accounts stay listed in the body). */
  function groupQuota(list) {
    const out = [], groups = new Map();
    for (const n of list) {
      if (n.kind !== "quota" || n.acknowledged_at) { out.push(n); continue; }
      const key = n.target_id || "quota";
      if (!groups.has(key)) { const g = { ...n, title: `${key}: حصص نافدة أو منخفضة`, body: n.title, count: n.count, _ids: [n.id] }; groups.set(key, g); out.push(g); }
      else { const g = groups.get(key); g.body = `${g.body} · ${n.title}`; g.count += n.count; g._ids.push(n.id); if (n.last_seen_at > g.last_seen_at) g.last_seen_at = n.last_seen_at; }
    }
    return out.map((n) => (n._ids?.length > 1 ? { ...n, title: `${n.title} (${n._ids.length} نوافذ)` } : n));
  }
  function renderActivityList() {
    if (!actHost) return;
    const events = [...(co("activity")?.events || []), ...act$.extra];
    const q = act$.query.trim().toLowerCase();
    const shown = events.filter((e) => (!act$.actor || e.actor_type === act$.actor) && (!act$.agent || e.actor_id === act$.agent) && (!act$.project || (e.target_type === "project" && e.target_id === act$.project))
      && (!act$.outcome || e.outcome === act$.outcome) && (!q || `${e.summary} ${e.action}`.toLowerCase().includes(q)));
    fill(actHost, shown.length ? C.activityList(shown) : empty("لا أحداث مطابقة."),
      !act$.exhausted && events.length >= 80 ? button("تحميل أحداث أقدم", async (e) => {
        const last = events.at(-1);
        const more = await act(e.currentTarget, () => fetch(`/local-api/company/activity?limit=80&before=${last.id}`).then((r) => r.json()), null);
        if (more) { act$.extra.push(...more.events); act$.exhausted = more.events.length < 80; renderActivityList(); }
      }, { icon: "chevronDown" }) : null);
  }

  // ---------------------------------------------------------------- data, backups, export, migration
  const LEGACY_KEYS = [["abud-os-workboard-v1", "لوحة التنفيذ القديمة (مهام، تركيز، سجل)"], ["abud-universe-project-board-v1", "ملاحظات لوحة المشاريع"], ["abud-ops-links-v1", "روابط النسخ المحلية اليدوية"]];
  const MIGRATION_KEY = "abud-os-migration";
  const readRaw = (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const signature = () => { let hash = 5381; const text = LEGACY_KEYS.map(([k]) => readRaw(k) || "").join("\u0000"); for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0; return `${text.length}:${hash >>> 0}`; };
  const parse = (key) => { try { return JSON.parse(readRaw(key) || "null"); } catch (_) { return null; } };
  async function migrate({ silent = false, trigger = null } = {}) {
    const run = () => mutate("POST", "/import/browser", { workboard: parse("abud-os-workboard-v1"), projectBoard: parse("abud-universe-project-board-v1"), links: parse("abud-ops-links-v1"), catalogOwner: window.ABUD_DATA?.owner });
    const report = silent ? await run().catch(() => null) : await act(trigger, run, "اكتمل الترحيل");
    if (!report) return null;
    store.write(MIGRATION_KEY, { signature: signature(), at: new Date().toISOString(), report });
    const moved = report.tasks + report.notes + report.links + (report.focus || 0) + (report.journal || 0);
    if (moved) { toast(`نُقلت بيانات المتصفح إلى مخزن الشركة: ${report.tasks} مهمة، ${report.focus || 0} مشروع تركيز، ${report.journal || 0} حدث سجل، ${report.notes} ملاحظة، ${report.links} ربط.`, "info"); C?.refreshAfterTaskChange(); }
    renderData();
    return report;
  }
  /** Automatic, idempotent: runs only when legacy browser data exists and has changed since the last migration. */
  function autoMigrate() {
    if (!C || !LEGACY_KEYS.some(([k]) => readRaw(k))) return;
    if (store.read(MIGRATION_KEY, {})?.signature === signature()) return;
    migrate({ silent: true });
  }
  let restoreReport = null;
  async function verifyRestore(trigger, name) {
    const report = await act(trigger, () => mutate("POST", "/backups/verify", { name }), null);
    if (!report) return;
    restoreReport = report;
    toast(report.ok ? "نجح اختبار الاستعادة المعزول" : "فشل اختبار الاستعادة", report.ok ? "ok" : "bad");
    invalidate("activity");
    renderData();
  }
  const RESTORE_LABELS = { projects: "المشاريع", tasks: "المهام", agent_runs: "التشغيلات", activity_events: "النشاط", notifications: "التنبيهات", usage_events: "الاستهلاك", memory_notes: "الذاكرة", budgets: "الميزانيات" };
  const restoreSummary = (r) => h("div", { class: "co-report", role: "status" },
    h("p", null, badge(r.ok ? "ok" : "bad", r.ok ? "قابلة للاستعادة" : "غير قابلة للاستعادة"), " ", bdi(r.name, "co-tech-soft"), ` · فحص السلامة: `, bdi(r.integrity), ` · مخالفات المراجع: ${r.foreignKeyViolations} · المخطط ${r.schemaVersion} (الحي ${r.liveSchemaVersion}) · ${fmt.when(r.verifiedAt)}`),
    h("ul", { class: "ops-list" }, Object.entries(r.counts).map(([table, c]) => h("li", null, h("strong", null, RESTORE_LABELS[table] || table), h("span", null, `في النسخة ${c.backup}`), h("span", { class: "ops-dim" }, `الآن ${c.live}`)))));
  function renderData() {
    const s = co("settings");
    if (!s) { fill(sData, O.resourceStatus(O.peek("co:settings"), "البيانات") || O.skeleton(3)); return; }
    const mig = store.read(MIGRATION_KEY, null);
    const present = LEGACY_KEYS.filter(([k]) => readRaw(k));
    fill(sData,
      h("div", { class: "os-kpis" },
        kpi({ label: "محرك التخزين", value: "SQLite", hint: `إصدار المخطط ${s.store.schemaVersion}`, ic: "database" }),
        kpi({ label: "النسخ الاحتياطية السليمة", value: s.store.backups.filter((b) => b.healthy).length, hint: s.store.backups.find((b) => b.healthy) ? `آخرها ${fmt.relative(backupTime(s.store.backups.find((b) => b.healthy).name))}` : "لا يوجد بعد", ic: "download", tone: s.store.backups.some((b) => b.healthy) ? "ok" : "warn" }),
        kpi({ label: "ترحيل المتصفح", value: mig ? "مكتمل" : present.length ? "مطلوب" : "لا بيانات", hint: mig ? fmt.relative(mig.at) : null, ic: "upload", tone: mig ? "ok" : present.length ? "warn" : null })),
      h("div", { class: "co-columns" },
        panelX({ title: "النسخ الاحتياطي", hint: "نسخة متسقة أثناء التشغيل (VACUUM INTO) داخل مجلد النسخ المحلي المستبعد من Git. لا يُرفع شيء.", actions: button("نسخة احتياطية الآن", (e) => backupNow(e.currentTarget), { kind: "primary", icon: "database" }) },
          s.store.backups.length ? h("ul", { class: "ops-list" }, s.store.backups.slice(0, 8).map((b) => h("li", null, icon("database", 16), bdi(b.name, "co-tech-soft"), badge(b.healthy ? "ok" : "bad", b.healthy ? "سليمة" : "غير سليمة"), h("span", { class: "ops-dim" }, kb(b.bytes), backupTime(b.name) ? ` · ${fmt.when(backupTime(b.name))}` : ""),
            b.healthy ? h("button", { type: "button", class: "ops-link", onclick: (e) => verifyRestore(e.currentTarget, b.name) }, "اختبار الاستعادة") : null))) : empty("لا نسخ احتياطية بعد."),
          restoreReport ? restoreSummary(restoreReport) : h("p", { class: "ops-dim" }, "«اختبار الاستعادة» ينسخ النسخة إلى مجلد مؤقت معزول ويفتحها ويقارن سجلاتها بالمخزن الحي، ثم يحذف النسخة المؤقتة. قاعدة البيانات الحية لا تُلمس.")),
        panelX({ title: "التصدير", hint: "ملف JSON كامل لبيانات الشركة (المشاريع، المهام، الوكلاء، السياسات، الميزانيات، الموافقات، الذاكرة، التشغيلات، النشاط) بلا أسرار." },
          button("تصدير JSON", async (e) => {
            const exported = await act(e.currentTarget, () => fetch("/local-api/company/export").then((r) => (r.ok ? r.blob() : Promise.reject(new Error("تعذر التصدير")))), "جُهّز ملف التصدير");
            if (!exported) return;
            const url = URL.createObjectURL(exported);
            const a = h("a", { href: url, download: `abud-company-${O.todayIso()}.json` });
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
          }, { icon: "download" }))),
      panelX({ title: "ترحيل بيانات المتصفح", hint: "ينقل مهام لوحة التنفيذ القديمة ومشاريع التركيز وسجل التنفيذ وملاحظات لوحة المشاريع والروابط اليدوية إلى مخزن الشركة. يعمل تلقائيًا عند تغيّر البيانات القديمة، متكرر الأمان (لا يكرر ما نُقل)، ولا يحذف بيانات المتصفح.",
        actions: button("ترحيل الآن", (e) => migrate({ trigger: e.currentTarget }), { icon: "upload" }) },
        h("ul", { class: "ops-list" }, LEGACY_KEYS.map(([k, text]) => h("li", null, h("strong", null, text), h("code", null, k), readRaw(k) ? badge("info", "موجودة في هذا المتصفح") : badge("muted", "لا بيانات")))),
        mig ? h("p", { class: "co-report", role: "status" }, `آخر ترحيل ${fmt.when(mig.at)}: ${mig.report.tasks} مهمة، ${mig.report.focus ?? 0} مشروع تركيز، ${mig.report.journal ?? 0} حدث سجل، ${mig.report.notes} ملاحظة، ${mig.report.links} ربط. مكرر لم يُنقل: ${mig.report.deduplicated}. متجاوز: ${mig.report.skipped}.`) : null,
        h("p", { class: "ops-dim" }, "تفضيلات العرض (التبويب الأخير، طي القائمة، ترتيب اللوحة العامة) تبقى محلية في المتصفح عن قصد.")));
  }

  // ---------------------------------------------------------------- security
  function renderSecurity() {
    const s = O.peek("settings")?.data;
    fill(sSecurity,
      s ? h("div", { class: "sy-cards" },
        card("shield", "حماية الـ Bridge", badge("ok", "مفعّلة"), [["الاستماع", bdi(s.bridge.bind)], ["حماية الكتابة", s.bridge.writeProtection], ["مسارات الكتابة", `${s.bridge.writeEndpoints} (بيانات الشركة فقط)`], ["فحص Host / عبر المواقع", s.bridge.hostHeaderCheck && s.bridge.crossSiteBlocked ? "مفعّل" : "غير مفعّل"]]),
        card("resources", "أسرار OmniRoute", badge("ok", "معزولة"), [["المفتاح", s.router.keyConfigured ? "مُعدّ في بيئة الـ Bridge" : "غير مُعدّ"], ["يُعاد للمتصفح", "أبدًا"], ["الكتابة إلى الراوتر", s.router.writesEnabled ? "بموافقة صريحة" : "معطّلة"]])) : O.skeleton(2),
      panel("حدود الأمان المطبّقة في الخادم", "عقود ثابتة في المنتج؛ التشغيل المحلي لا يلغيها.", h("ul", { class: "ops-list" }, [
        "الـ Bridge يستمع على 127.0.0.1 فقط ويرفض أي Host أو Origin أجنبي وأي طلب عبر المواقع.",
        "كل كتابة تحتاج رمز جلسة لا يُقرأ إلا من نفس الأصل، وجسم JSON، وحدًا أقصى للحجم.",
        "صلاحيات أدوات الوكلاء تُفرض في الخادم؛ لا يمكن منح وكيل أداة خارج مجموعته المعتمدة، ولا يوجد تنفيذ أوامر Shell أو وصول ملفات عشوائي.",
        "الخوادم: نصوص فحص ثابتة للقراءة فقط عبر SSH بمفتاح المالك (بالمسار فقط) مع تثبيت بصمة الخادم وفحص known_hosts الصارم. لا مسار يقبل أمرًا نصيًا، ولا يرى الوكلاء أو OmniRoute أي مفتاح.",
        "إجراءات الخادم (إعادة تشغيل خدمة PM2 أو إعادة تحميل Nginx) لا تُنفذ إلا بموافقة المالك على الهدف نفسه، برمز لمرة واحدة صالح 5 دقائق، مع قفل وتحقق لاحق. النشر والتراجع والترحيل وتعديل الجدار الناري أو SSH غير متاحة من هذا المسار.",
        "الاستدلال المدفوع وتعديلات إعدادات OmniRoute تحتاج موافقة صريحة؛ والكتابة إلى الراوتر معطّلة ما لم يُشغَّل الـ Bridge مع ABUD_ROUTER_WRITES=1.",
        "المدخلات التي تشبه الأسرار تُرفض في المهام والملاحظات وطلبات الوكلاء.",
        "الموقع العام (GitHub Pages) لا يحتوي أي واجهة أو بيانات داخلية، ولا تُرسل المسارات الكاملة للمتصفح."
      ].map((x) => h("li", null, icon("shield", 16), x)))),
      window.AbudContext ? window.AbudContext.render() : null,
      notice("warn", "لا مصادقة غير الجهاز المحلي", "الحماية الحالية: الاستماع المحلي + رمز الجلسة. لا تعرض الـ Bridge على أي شبكة قبل إضافة مصادقة وتفويض حقيقيين."));
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    if (O.editing(sSettings, renderSettings)) return;
    const s = co("settings");
    if (!s) { fill(sSettings, O.resourceStatus(O.peek("co:settings"), "الإعدادات") || O.skeleton(3)); return; }
    const st = s.settings;
    const prefs = h("form", { class: "co-form-grid", onsubmit: async (event) => {
      event.preventDefault();
      const v = O.formValues(prefs);
      const inferenceTimeouts = Object.fromEntries(["connectMs", "headersMs", "firstTokenMs", "idleMs", "totalMs"].map((key) => [key, Number(v[key])]));
      const saved = await act(prefs.querySelector("[type=submit]"), () => mutate("PATCH", "/settings", { locale: v.locale, timezone: v.timezone, quotaSnapshotMinutes: Number(v.quotaSnapshotMinutes), quotaRetentionDays: Number(v.quotaRetentionDays), subscriptionOptIn: prefs.subscriptionOptIn.checked, inferenceTimeouts }), "حُفظت الإعدادات");
      if (saved) invalidate("settings", "agents", "resources", "summary");
    } },
    h("div", { class: "co-form-row" },
      field("اللغة والتنسيق", select("locale", [["ar-EG", "العربية (مصر)"], ["ar-SA", "العربية (السعودية)"], ["ar", "العربية"]], st.locale)),
      field("المنطقة الزمنية", h("input", { class: "ops-input", name: "timezone", dir: "ltr", value: st.timezone, required: true }), "الافتراضي Africa/Cairo — كل التواريخ تُعرض بها.")),
    h("div", { class: "co-form-row" },
      field("فاصل لقطات الحصص (دقائق)", h("input", { class: "ops-input", type: "number", name: "quotaSnapshotMinutes", min: 5, max: 240, value: st.quotaSnapshotMinutes }), "الحد الأدنى 5 دقائق لتجنب الاستطلاع المفرط."),
      field("الاحتفاظ بتاريخ الحصص (أيام)", h("input", { class: "ops-input", type: "number", name: "quotaRetentionDays", min: 7, max: 365, value: st.quotaRetentionDays }))),
    h("div", { class: "co-form-row" },
      field("اتصال الراوتر المحلي (مللي ثانية)", h("input", { class: "ops-input", type: "number", name: "connectMs", min: 1000, max: 20000, value: st.inferenceTimeouts?.connectMs ?? 5000 })),
      field("انتظار ترويسات الاستدلال", h("input", { class: "ops-input", type: "number", name: "headersMs", min: 5000, max: 120000, value: st.inferenceTimeouts?.headersMs ?? 30000 }))),
    h("div", { class: "co-form-row" },
      field("انتظار أول محتوى مفيد", h("input", { class: "ops-input", type: "number", name: "firstTokenMs", min: 5000, max: 120000, value: st.inferenceTimeouts?.firstTokenMs ?? 25000 })),
      field("سكون البث", h("input", { class: "ops-input", type: "number", name: "idleMs", min: 5000, max: 120000, value: st.inferenceTimeouts?.idleMs ?? 30000 }))),
    h("div", { class: "co-form-row" },
      field("الحد الأقصى للمحاولة", h("input", { class: "ops-input", type: "number", name: "totalMs", min: 20000, max: 300000, value: st.inferenceTimeouts?.totalMs ?? 90000 }), "تسري هذه المهلات على تشغيل وكلاء الشركة فقط، ولا تغيّر إعدادات OmniRoute.")),
    h("label", { class: "co-check-field" }, h("input", { type: "checkbox", name: "subscriptionOptIn", checked: st.subscriptionOptIn ? true : null }),
      h("span", null, h("strong", null, "السماح باشتراكات المستهلك عبر OAuth لوكلاء الشركة"),
        h("small", null, "معطّل افتراضيًا. حتى عند التفعيل يجب أن تسمح سياسة المجال بالفئة. اتصالات Google Antigravity تبقى مستبعدة دائمًا وفق شروط المزوّد."))),
    h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "حفظ الإعدادات")));
    const local = [["abud-os-collapsed", "طي القائمة الجانبية"], ["abud-os-parts", "العرض الفرعي الأخير لكل قسم"], ["abud-os-projects", "طريقة عرض المشاريع"], ["abud-os-work", "تصفية العمل"], ["abud-ops-usage-range", "نطاق تحليلات الاستخدام"], ["abud-ops-manual-quota-v1", "مطابقات الحصص اليدوية"]];
    fill(sSettings,
      panel("تفضيلات الشركة", "تُحفظ في مخزن الشركة وتسري على كل الصفحات.", prefs),
      panel("الواجهة", null, h("label", { class: "co-check-field" }, h("input", { type: "checkbox", checked: document.body.classList.contains("os-collapsed") ? true : null, onchange: (e) => { document.body.classList.toggle("os-collapsed", e.target.checked); store.write("abud-os-collapsed", e.target.checked); } }),
        h("span", null, h("strong", null, "قائمة جانبية مطوية"), h("small", null, "أيقونات فقط لإتاحة مساحة أكبر للمحتوى.")))),
      panel("تفضيلات محفوظة في هذا المتصفح", "بيانات غير سرية فقط. مسحها لا يمس بيانات الشركة.", h("ul", { class: "ops-list" }, local.map(([key, text]) => {
        const present = store.read(key, null) != null;
        return h("li", null, h("strong", null, text), h("code", null, key), present ? badge("info", "محفوظ") : badge("muted", "فارغ"),
          present ? h("button", { type: "button", class: "ops-link", onclick: () => { store.remove(key); renderSettings(); } }, "مسح") : null);
      }))),
      window.AbudVoice ? voicePanel() : null,
      panel("الوكلاء والموارد", "إعدادات كل وكيل في مساحته، والميزانيات وسياسات التوجيه في «الموارد الذكية».", h("div", { class: "co-inline" }, linkButton("الوكلاء", href("agents"), { icon: "agents" }), linkButton("التوجيه والميزانيات", href("resources", "routing"), { icon: "resources" }))));
  }

  // ---------------------------------------------------------------- local voice engine (advanced; daily screens only show Talk/Mute/Stop)
  function voicePanel() {
    const body = h("div", { class: "vo-admin" }, h("p", { class: "ops-dim" }, "يتحقق من محرك الصوت…"));
    const STATE_AR = { ready: "يعمل", stopped: "متوقف (يبدأ تلقائيًا عند أول استخدام)", starting: "يبدأ…", "not-installed": "غير مثبت", error: "خطأ" };
    const draw = async (force = false) => {
      const st = await window.AbudVoice.status(force);
      const models = st.worker?.models || {};
      const run = (label, path, kind = "secondary") => button(label, async (e) => { if (await act(e.currentTarget, () => O.mutate("POST", path, {}), null) !== undefined) draw(true); }, { kind });
      fill(body,
        h("p", null, h("strong", null, STATE_AR[st.state] || st.state), st.reasonAr ? ` — ${st.reasonAr}` : ""),
        st.state === "not-installed" ? h("p", { class: "ops-dim" }, "التثبيت مرة واحدة على هذا الجهاز: ", h("code", { dir: "ltr" }, st.setup || "apps\voice-worker\setup.ps1")) : null,
        st.state !== "not-installed" ? h("div", { class: "ops-actions" },
          st.state === "ready" ? null : run("تشغيل", "/voice/start", "primary"),
          st.state === "ready" ? run("تفريغ ذاكرة كرت الشاشة", "/voice/unload") : null,
          st.state === "ready" ? run("إيقاف المحرك", "/voice/stop") : null,
          button("تحديث", () => draw(true))) : null,
        st.worker ? h("details", null, h("summary", null, "تفاصيل تقنية"),
          h("dl", { class: "mt-budget" }, ...Object.entries(models).flatMap(([name, m]) => [h("dt", null, name === "stt" ? "تحويل الكلام لنص" : name === "tts" ? "النطق" : name), h("dd", { dir: "ltr" }, [m.state, m.device, m.model].filter(Boolean).join(" · "))]),
            st.worker.vramUsedMiB != null ? [h("dt", null, "ذاكرة كرت الشاشة"), h("dd", { dir: "ltr" }, `${st.worker.vramUsedMiB} MiB`)] : null)) : null);
    };
    draw();
    return panel("محرك الصوت المحلي", "التعرف على الكلام والنطق المصري يعملان على هذا الجهاز فقط؛ لا يُرسل أي صوت إلى OmniRoute أو أي خدمة خارجية. الأصوات الستة مؤقتة حتى تعتمدها بالاستماع.", body);
  }

  // ---------------------------------------------------------------- agent registry (owner writes use the shared session guard)
  let registryTemplate = null, templateRequest = 0;
  const registryLoad = (force = false) => {
    api.co("agentRegistry", "/agent-registry", { force, ttl: 30_000 });
    api.co("agentTemplates", "/agent-templates", { force, ttl: 300_000 });
  };
  async function chooseTemplate(id) {
    const request = ++templateRequest;
    registryTemplate = null;
    renderRegistry(true);
    if (!id) return;
    const result = await act(null, async () => {
      const response = await fetch(`/local-api/company/agent-templates/${encodeURIComponent(id)}`, { cache: "no-store", headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "تعذر تحميل القالب");
      return data;
    }, null);
    if (request !== templateRequest) return;
    registryTemplate = result;
    renderRegistry(true);
  }
  async function registryAction(event, agent, operation) {
    const trigger = event.currentTarget;
    const removing = operation === "remove";
    const verb = removing ? "حذف" : operation === "activate" ? "تفعيل" : "تعطيل";
    if (!await O.confirmDialog({ title: `${verb} ${agent.name}`, body: removing ? "حذف نهائي لوكيل مخصص فقط. سيرفض الخادم الحذف إذا كانت له تشغيلات أو سجلات مرتبطة. لا تُحذف السجلات التاريخية." : `هل تريد ${verb} هذا الوكيل المخصص؟ التعطيل يخفيه من القوة العاملة النشطة ولا يحذف سجله.`, confirm: verb, tone: removing || operation === "deactivate" ? "danger" : "primary" })) return;
    const result = await act(trigger, () => mutate(removing ? "DELETE" : "POST", `/agents/${encodeURIComponent(agent.id)}${removing ? "" : `/${operation}`}`, {}), `تم ${verb} الوكيل`);
    if (result) refreshRegistry();
  }
  function refreshRegistry() {
    registryLoad(true);
    invalidate("catalog", "agents", "activity", "summary");
  }
  function renderRegistry(force = false) {
    if (force !== true && O.editing(sRegistry, renderRegistry)) return;
    const agents = co("agentRegistry")?.agents;
    const templates = co("agentTemplates")?.templates;
    const listing = agents ? panelX({ title: "سجل الوكلاء", hint: "الوكلاء المدمجون محميون من التعطيل والحذف. التغييرات محلية وتُسجل باسم المالك." },
      h("ul", { class: "ops-list" }, agents.map((agent) => h("li", null,
        h("strong", null, agent.name), bdi(agent.id), badge(agent.builtin ? "info" : "muted", agent.builtin ? "مدمج" : "مخصص"), badge(agent.active ? "ok" : "warn", agent.active ? "نشط" : "معطل"),
        h("span", { class: "ops-dim" }, [agent.titleAr, agent.department, agent.roleAr, agent.templateId ? `القالب: ${(templates || []).find((t) => t.id === agent.templateId)?.nameAr || agent.templateId}` : "قالب مدمج"].filter(Boolean).join(" · ")),
        !agent.builtin ? h("div", { class: "co-inline" }, button(agent.active ? "تعطيل" : "تفعيل", (event) => registryAction(event, agent, agent.active ? "deactivate" : "activate")), button("حذف", (event) => registryAction(event, agent, "remove"), { kind: "danger" })) : null))))
      : O.resourceStatus(O.peek("co:agentRegistry"), "سجل الوكلاء") || O.skeleton(3);
    const picker = select("templateId", [["", "اختر قالبًا"], ...(templates || []).map((t) => [t.id, t.nameAr])], registryTemplate?.id || "", { onchange: (event) => chooseTemplate(event.target.value), "aria-label": "قالب الوكيل" });
    const template = registryTemplate;
    let form = null;
    if (template) {
      const input = (name, options = {}) => h("input", { class: "ops-input", name, ...options });
      form = h("form", { class: "co-form-grid", onsubmit: async (event) => {
        event.preventDefault();
        const values = O.formValues(form);
        const specializations = values.specializations.split(/[,،\n]/).map((v) => v.trim()).filter(Boolean);
        if (specializations.length > 40 || specializations.some((v) => v.length > 200)) { toast("التخصصات: بحد أقصى 40 تخصصًا و200 حرف لكل تخصص.", "bad"); return; }
        const tools = [...form.querySelectorAll("input[name=tool]:checked")].map((el) => el.value);
        if (!await O.confirmDialog({ title: "إنشاء وكيل مخصص", body: `إنشاء ${values.name} من ${template.nameAr} مع ${tools.length} أداة ضمن صلاحيات القالب فقط؟`, confirm: "إنشاء" })) return;
        const result = await act(form.querySelector("[type=submit]"), () => mutate("POST", "/agents", { templateId: template.id, id: values.id, name: values.name, titleAr: values.titleAr, roleAr: values.roleAr, department: values.department, summaryAr: values.summaryAr, specializations, mode: values.mode, instructions: values.instructions, tools }), "أُنشئ الوكيل المخصص");
        if (result) { registryTemplate = null; ++templateRequest; refreshRegistry(); renderRegistry(); }
      } },
      h("p", { class: "ops-dim" }, template.descriptionAr),
      h("div", { class: "co-form-row" }, field("المعرف", input("id", { required: true, dir: "ltr", pattern: "[a-z][a-z0-9_-]{1,23}", minlength: 2, maxlength: 24 }), "2–24 حرفًا؛ يبدأ بحرف إنجليزي صغير."), field("الاسم", input("name", { required: true, maxlength: 2000 }))),
      h("div", { class: "co-form-row" }, field("المسمى", input("titleAr", { required: true, maxlength: 2000 })), field("الدور", input("roleAr", { required: true, maxlength: 2000 }))),
      h("div", { class: "co-form-row" }, field("القسم", input("department", { maxlength: 200 })), field("النمط", select("mode", ["standard", "creative", "analytical", "research", "strict", "execution"].map((mode) => [mode, mode]), template.defaultMode))),
      field("الملخص", h("textarea", { class: "ops-input", name: "summaryAr", required: true, maxlength: 2000, rows: 3 })),
      field("التخصصات", h("textarea", { class: "ops-input", name: "specializations", rows: 2 }), "افصل بفاصلة أو سطر جديد؛ 40 تخصصًا كحد أقصى."),
      field("التعليمات", h("textarea", { class: "ops-input", name: "instructions", maxlength: 4000, rows: 3 })),
      h("fieldset", null, h("legend", null, "الأدوات المسموحة من القالب"), h("p", { class: "ops-dim" }, "اختر مجموعة فرعية فقط؛ لا يضيف الإنشاء أدوات خارج القالب."), template.allowedTools.map((tool) => h("label", { class: "co-check-field" }, input("tool", { type: "checkbox", value: tool, checked: true }), bdi(tool)))),
      h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "إنشاء الوكيل")));
    }
    fill(sRegistry, listing, panelX({ title: "إنشاء من قالب", hint: "إنشاء وكيل مخصص دون تعديل الوكلاء المدمجين أو توسيع صلاحيات القالب." }, templates ? picker : O.resourceStatus(O.peek("co:agentTemplates"), "قوالب الوكلاء") || O.skeleton(2), form));
  }
  O.on("co:agentRegistry", renderRegistry);
  O.on("co:agentTemplates", renderRegistry);

  // ---------------------------------------------------------------- registration
  O.registerView({
    id: "system", order: 60, icon: "system", ar: "النظام", subtitle: "الخدمات المحلية والتكاملات والنشاط والبيانات والأمان والإعدادات.",
    tabs: [["overview", "نظرة عامة"], ["servers", "السيرفرات"], ["integrations", "التكاملات"], ["activity", "النشاط"], ["data", "البيانات والنسخ"], ["security", "الأمان"], ["registry", "سجل الوكلاء"], ["settings", "الإعدادات"]],
    defaultTab: "overview",
    onShow(tab) {
      api.infra(); api.settings(); C?.co.settings(); C?.co.notifications();
      window.AbudServers?.show(tab);
      if (tab === "registry") { registryLoad(); renderRegistry(); }
      if (tab === "overview" || tab === "integrations") { api.agents(); api.overview(); }
      if (tab === "integrations") api.account();
      if (tab === "activity") { C?.co.activity(); C?.co.catalog(); C?.co.projects(); }
    },
    badge() { const n = (co("notifications")?.notifications || []).filter((x) => !x.acknowledged_at && x.level === "critical").length; return n ? { n, tone: "bad", title: `${n} تنبيه حرج` } : null; }
  });
  O.setActions("system", () => [button("تحديث", () => { api.infra(true); api.settings(true); C?.co.activity(true); C?.co.notifications(true); C?.co.settings(true); window.AbudServers?.refresh(); if (O.state.tab === "registry") registryLoad(true); }, { icon: "refresh" })]);
  const rerender = () => { renderOverview(); renderIntegrations(); renderData(); renderSecurity(); renderSettings(); };
  ["infra", "settings", "agents", "overview", "account"].forEach((key) => O.on(key, () => { if (O.state.view === "system") rerender(); }));
  O.on("co:settings", () => { renderData(); renderSettings(); renderOverview(); });
  O.on("co:notifications", () => { O.refreshNav(); if (O.state.view === "system") { renderOverview(); renderActivity(); } });
  O.on("co:activity", () => { if (O.state.view === "system") renderActivity(); });
  O.on("co:projects", () => { autoMigrate(); });
  rerender();
})();
