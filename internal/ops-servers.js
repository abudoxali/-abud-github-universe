/* ABUD FUN Company OS V4.1 — النظام ← السيرفرات (VPS Operations Center) and the Windows startup panel of System Center.
 * Every figure comes from the Local Bridge, which measured it with read-only probes; nothing is estimated here. A failed
 * SSH check is shown as "last verified state" with its age, never as a stopped service. Write operations exist only as
 * proposals the owner approves for one exact target, after which the bridge executes and verifies them. */
(() => {
  "use strict";
  const O = window.AbudOps;
  const C = window.AbudCompany;
  if (!O || !C) return;
  const { h, fill, fmt, badge, notice, bdi, icon, panel, panelX, empty, button, field, select, kpi, segmented, href, act, mutate, toast, api } = O;

  const sStartup = O.section("sysStartup", "system", "overview");
  const sServers = O.section("sysServers", "system", "servers");
  const ui = { range: "24h", diag: "nginx-config-test", logSource: "nginx-error", logService: "", output: null, outputTitle: null };

  const load = (force) => api.co("vps", "/vps", { force, ttl: 15_000 });
  const loadMetrics = (id, force) => api.co(`vpsMetrics:${id}:${ui.range}`, `/vps/hosts/${id}/metrics?range=${ui.range}`, { force, ttl: 60_000 });
  const loadIncidents = (id, force) => api.co(`vpsIncidents:${id}`, `/vps/hosts/${id}/incidents`, { force, ttl: 30_000 });
  const loadActions = (force) => api.co("vpsActions", "/vps/actions", { force, ttl: 15_000 });
  const loadStartup = (force) => api.co("startup", "/startup", { force, ttl: 15_000 });
  const peek = (key) => O.peek(`co:${key}`)?.data;

  const CONN = { connected: ["ok", "متصل"], stale: ["warn", "قراءة قديمة"], disconnected: ["bad", "غير متصل"], pending: ["muted", "لم يُفحص بعد"], "not-configured": ["muted", "غير مُعدّ"], disabled: ["muted", "معطّل"] };
  const SVC = { running: "ok", stopped: "bad", degraded: "warn", unknown: "muted", retired: "muted", absent: "bad", unreachable: "warn" };
  const SITE = { ok: ["ok", "سليم"], protected: ["info", "محمي (متوقع)"], retired: ["muted", "مُوقَف عمدًا · 410"], degraded: ["warn", "متدهور"], down: ["bad", "متوقف"], unreachable: ["bad", "تعذر الوصول"], unexpected: ["warn", "استجابة غير متوقعة"] };
  const SEV = { critical: ["bad", "حرج"], warning: ["warn", "تحذير"], info: ["info", "معلومة"] };
  const ACTION_STATUS = { proposed: ["warn", "بانتظار موافقتك"], approved: ["info", "معتمد"], running: ["info", "قيد التنفيذ"], succeeded: ["ok", "نجح وتحقق"], failed: ["bad", "فشل"], rejected: ["muted", "مرفوض"], expired: ["muted", "منتهي الصلاحية"] };
  const ENV = { production: "الإنتاج", staging: "Staging", host: "الخادم" };
  const DIAGNOSTICS = [["nginx-config-test", "فحص إعداد Nginx"], ["failed-units", "خدمات systemd الفاشلة"], ["pm2-restarts", "عدادات إعادة تشغيل PM2"], ["postgres-health", "حالة PostgreSQL"], ["disk-usage", "الأقراص والإنودات"], ["network-summary", "ملخص الشبكة"], ["recent-boots", "آخر مرات الإقلاع"]];
  const LOGS = [["nginx-error", "أخطاء Nginx (elhabak)"], ["pm2-error", "سجل أخطاء خدمة PM2"], ["system-warnings", "تحذيرات النظام (6 ساعات)"]];
  const connBadge = (c) => { const [tone, text] = CONN[c?.state] || ["muted", c?.state || "غير معروف"]; return badge(tone, text, c?.ar); };
  const gb = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1073741824).toFixed(bytes >= 10 * 1073741824 ? 0 : 1)} GB` : "—");
  const mb = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1048576)} MB` : "—");
  const days = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 86400)} يوم ${Math.floor((sec % 86400) / 3600)} س` : "—");
  const when = (iso) => (iso ? h("span", { title: iso }, fmt.when(iso), h("small", { class: "ops-dim" }, ` · ${fmt.relative(iso)}`)) : "—");
  const meterTone = (pct, warn, crit) => (!Number.isFinite(pct) ? "unknown" : pct >= crit ? "exhausted" : pct >= warn ? "low" : "ok");
  const short = (sha) => (sha ? bdi(sha.slice(0, 7), "co-tech-soft") : "—");

  // ---------------------------------------------------------------- chart (measured series; gaps stay gaps)
  function chart(series, title) {
    const W = 640, H = 170, pad = { l: 34, r: 8, t: 10, b: 22 };
    const ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "vps-chart", role: "img", "aria-label": title, preserveAspectRatio: "none" });
    const x = (i) => pad.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * (W - pad.l - pad.r));
    const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
    for (const v of [0, 50, 100]) { svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "vps-grid" }), el("text", { x: pad.l - 6, y: y(v) + 4, class: "vps-axis", "text-anchor": "end" }, `${v}%`)); }
    for (const [key, cls] of [["disk", "vps-line-disk"], ["mem", "vps-line-mem"], ["cpu", "vps-line-cpu"]]) {
      let d = "", pen = false;
      series.forEach((p, i) => { if (Number.isFinite(p[key])) { d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(Math.min(Math.max(p[key], 0), 100)).toFixed(1)} `; pen = true; } else pen = false; });
      if (d) svg.append(el("path", { d, class: cls, fill: "none" }));
    }
    if (series.length) {
      const fmtT = (iso) => new Intl.DateTimeFormat("ar-EG-u-nu-latn", { hour: "2-digit", minute: "2-digit", day: ui.range === "7d" || ui.range === "30d" ? "numeric" : undefined, month: ui.range === "30d" ? "short" : undefined, timeZone: O.companyZone() }).format(new Date(iso));
      svg.append(el("text", { x: pad.l, y: H - 4, class: "vps-axis" }, fmtT(series[0].at)), el("text", { x: W - pad.r, y: H - 4, class: "vps-axis", "text-anchor": "end" }, fmtT(series.at(-1).at)));
    }
    return h("figure", { class: "vps-figure" }, h("div", { class: "vps-chart-wrap", dir: "ltr" }, svg),
      h("figcaption", { class: "vps-legend" }, h("span", { class: "vps-key vps-key-cpu" }, "المعالج"), h("span", { class: "vps-key vps-key-mem" }, "الذاكرة"), h("span", { class: "vps-key vps-key-disk" }, "القرص")));
  }

  // ---------------------------------------------------------------- servers page
  function render() {
    if (O.editing(sServers, render)) return;
    const data = peek("vps");
    if (!data) { fill(sServers, O.resourceStatus(O.peek("co:vps"), "السيرفرات") || O.skeleton(4)); return; }
    if (!data.configured) {
      fill(sServers, notice("info", "لا يوجد خادم مسجل", "سجّل الخادم في الملف المحلي local/vps.json (مستبعد من Git) ثم أعد تشغيل التطبيق. لا يُخزَّن أي مفتاح في قاعدة البيانات أو المتصفح."),
        data.configErrors?.length ? notice("bad", "أخطاء في ملف الخوادم", data.configErrors.join("؛ ")) : null);
      return;
    }
    const actions = peek("vpsActions")?.actions || [];
    fill(sServers, data.configErrors?.length ? notice("warn", "تجاهل جزء من ملف الخوادم", data.configErrors.join("؛ ")) : null,
      ...data.hosts.map((host) => hostView(host, actions.filter((a) => a.hostId === host.id), data.settings)),
      settingsPanel(data.settings));
  }

  function hostView(o, actions, settings) {
    const t = settings.thresholds;
    const sys = o.system;
    const live = o.connection.state === "connected";
    const metrics = peek(`vpsMetrics:${o.id}:${ui.range}`);
    const incidents = peek(`vpsIncidents:${o.id}`)?.incidents || o.incidents.list;
    const pending = actions.filter((a) => a.status === "proposed");
    return h("div", { class: "vps-host", "data-host": o.id },
      h("header", { class: "vps-host-head" },
        h("span", { class: "sy-card-icon" }, icon("globe", 22)),
        h("div", { class: "vps-host-title" }, h("h3", null, o.name), h("p", null, o.provider ? `${o.provider} · ` : "", bdi(o.endpoint, "co-tech-soft"))),
        h("div", { class: "vps-host-state" }, connBadge(o.connection),
          h("small", { class: "ops-dim" }, o.lastSuccessAt ? ["آخر قراءة ناجحة ", fmt.relative(o.lastSuccessAt)] : "لا قراءة ناجحة بعد")),
        button("فحص الآن", (e) => probe(e.currentTarget, o.id), { icon: "refresh" })),
      !live ? notice(o.connection.state === "disconnected" ? "bad" : "warn", o.connection.state === "disconnected" ? `تعذر الاتصال: ${o.connection.ar}` : o.connection.ar,
        `${o.lastSuccessAt ? `القيم أدناه آخر حالة مؤكدة (${fmt.when(o.lastSuccessAt)}) وليست حية. ` : ""}فشل SSH لا يعني توقف التطبيقات؛ راجع فحص الموقع العام.${o.connection.consecutiveFailures ? ` محاولات فاشلة متتالية: ${o.connection.consecutiveFailures}.` : ""}`) : null,
      pending.length ? panelX({ title: `إجراءات بانتظار موافقتك (${pending.length})`, hint: "لا يُنفذ شيء على الخادم قبل موافقتك على الإجراء نفسه. كل موافقة صالحة لمرة واحدة خلال 5 دقائق.", cls: "vps-pending" },
        h("ul", { class: "co-approvals" }, pending.map((a) => actionCard(a, o)))) : null,
      h("div", { class: "os-kpis" },
        kpi({ label: "المعالج", value: sys ? fmt.pct(sys.cpu.pct, 1) : null, hint: sys ? `الحمل ${sys.cpu.load1 ?? "—"} · ${sys.cpu.cores ?? "—"} أنوية` : null, ic: "gauge", tone: sys?.cpu.pct >= t.cpuWarnPct ? "warn" : null }),
        kpi({ label: "الذاكرة", value: sys ? fmt.pct(sys.memory.usedPct, 1) : null, hint: sys ? `${gb(sys.memory.totalBytes - sys.memory.availableBytes)} من ${gb(sys.memory.totalBytes)} · متاح ${gb(sys.memory.availableBytes)}` : null, ic: "resources", tone: sys?.memory.usedPct >= t.memWarnPct ? "warn" : null }),
        kpi({ label: "القرص /", value: sys?.disk ? fmt.pct(sys.disk.usedPct) : null, hint: sys?.disk ? `حر ${gb(sys.disk.availBytes)} من ${gb(sys.disk.totalBytes)}` : null, ic: "database", tone: sys?.disk?.usedPct >= t.diskCritPct ? "bad" : sys?.disk?.usedPct >= t.diskWarnPct ? "warn" : null }),
        kpi({ label: "مدة التشغيل", value: sys ? days(sys.uptimeSec) : null, hint: sys ? bdi(sys.os) : null, ic: "clock" }),
        kpi({ label: "زمن فحص SSH", value: o.lastProbeMs != null ? fmt.ms(o.lastProbeMs) : null, hint: "يشمل عينة معالج لمدة ثانية", ic: "activity" }),
        kpi({ label: "حوادث مفتوحة", value: o.incidents.open, hint: o.incidents.critical ? `${o.incidents.critical} حرجة` : "لا حرجة", ic: "alert", tone: o.incidents.critical ? "bad" : o.incidents.open ? "warn" : "ok" })),
      h("div", { class: "co-columns" },
        panelX({ title: "الموارد عبر الزمن", hint: "قياسات فعلية من فحوص القراءة فقط. الفجوات تعني عدم وجود قراءة.", actions: segmented([["1h", "ساعة"], ["24h", "24 ساعة"], ["7d", "7 أيام"], ["30d", "30 يومًا"]], ui.range, (v) => { ui.range = v; loadMetrics(o.id); render(); }, "النطاق الزمني") },
          sys ? h("div", { class: "vps-meters" }, [["المعالج", sys.cpu.pct, t.cpuWarnPct, 101], ["الذاكرة", sys.memory.usedPct, t.memWarnPct, 101], ["Swap", sys.memory.swapUsedPct, t.swapWarnPct, 101], ["القرص", sys.disk?.usedPct, t.diskWarnPct, t.diskCritPct]]
            .map(([text, pct, warn, crit]) => h("div", { class: "vps-meter-row" }, h("span", null, text), O.meter(pct, meterTone(pct, warn, crit), `${text} ${Math.round(pct ?? 0)}%`), h("strong", null, fmt.pct(pct, 1))))) : null,
          metrics?.series?.length ? chart(metrics.series, `المعالج والذاكرة والقرص خلال ${ui.range}`) : empty(metrics ? "لا عينات في هذا النطاق بعد." : "جارٍ تحميل المقاييس…"),
          metrics?.samples ? h("p", { class: "ops-dim" }, `عدد العينات ${metrics.samples} · المعالج متوسط ${fmt.pct(metrics.cpuPct?.avg, 1)} وأقصى ${fmt.pct(metrics.cpuPct?.max, 1)} · الذاكرة أقصى ${fmt.pct(metrics.memPct?.max, 1)} · القرص ${fmt.pct(metrics.diskPct?.first)} ← ${fmt.pct(metrics.diskPct?.last)}`) : null),
        sitesPanel(o)),
      servicesPanel(o),
      h("div", { class: "co-columns" }, deploymentPanel(o), incidentsPanel(o, incidents)),
      h("div", { class: "co-columns" }, toolsPanel(o), actionsHistory(actions)));
  }

  function servicesPanel(o) {
    return panelX({ title: "الخدمات", hint: o.connection.state === "connected" ? "الحالة من آخر فحص (Nginx وPostgreSQL عبر systemd، والتطبيقات عبر PM2)." : "آخر حالة مؤكدة؛ لم تُحدَّث لأن الاتصال الحالي فشل." },
      h("div", { class: "ops-tablewrap", tabindex: "0", role: "region", "aria-label": "جدول الخدمات" }, h("table", { class: "ops-table" },
        h("thead", null, h("tr", null, ["الخدمة", "البيئة", "الحالة", "منذ", "إعادات", "الذاكرة", ""].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", null, o.services.map((s) => h("tr", null,
          h("th", { scope: "row" }, bdi(s.service)), h("td", null, ENV[s.environment] || s.environment),
          h("td", null, badge(SVC[s.state] || "muted", s.ar), s.stale ? h("div", null, badge("warn", "قراءة قديمة", `آخر رصد ${s.observedAt}`)) : null),
          h("td", null, s.changedAt ? fmt.relative(s.changedAt) : "—"), h("td", null, s.detail.restarts ?? "—"), h("td", null, s.detail.memoryMb != null ? `${s.detail.memoryMb} MB` : "—"),
          h("td", null, s.kind === "pm2" && ["running", "stopped", "degraded"].includes(s.state) ? h("button", { type: "button", class: "ops-link", onclick: () => proposeDialog(o, "pm2.restart", s.service) }, "اقتراح إعادة تشغيل") : null)))))),
      h("div", { class: "co-inline" }, button("اقتراح إعادة تحميل Nginx", () => proposeDialog(o, "nginx.reload", null), { icon: "shield" })));
  }

  function sitesPanel(o) {
    const entries = Object.entries(o.sites || {});
    return panelX({ title: "المواقع وشهادات TLS", hint: o.sitesObservedAt ? `فحص HTTPS من هذا الجهاز · ${fmt.relative(o.sitesObservedAt)}` : "لم يُفحص بعد" },
      entries.length ? h("ul", { class: "ops-list vps-sites" }, entries.map(([env, s]) => {
        const [tone, text] = SITE[s.state] || ["muted", s.state];
        return h("li", null, h("div", null, h("strong", null, ENV[env] || env), " ", bdi(s.url, "co-tech-soft")),
          h("div", { class: "co-inline" }, badge(tone, text), s.healthStatus ? badge("muted", `health ${s.healthStatus}`) : null, Number.isFinite(s.healthMs) ? h("span", { class: "ops-dim" }, fmt.ms(s.healthMs)) : null,
            s.healthBody?.database ? badge(s.healthBody.database === "connected" ? "ok" : "bad", `DB ${s.healthBody.database}`) : null),
          s.cert && s.expected === "active" ? h("small", null, s.cert.ok ? `الشهادة صالحة · تنتهي خلال ${s.cert.daysLeft} يومًا (${fmt.when(s.cert.validTo)})${s.cert.issuer ? ` · ${s.cert.issuer}` : ""}` : `الشهادة: ${s.cert.authorizationError || s.cert.error || "غير صالحة"}`) : null,
          s.expected === "retired" ? h("small", { class: "ops-dim" }, "بيئة مُوقَفة عمدًا؛ استجابة 410 متوقعة وليست انقطاعًا.") : null);
      })) : empty("لا مواقع مسجلة."));
  }

  function deploymentPanel(o) {
    const d = o.deployment;
    return panelX({ title: "النشر وقاعدة البيانات", hint: d.observed.at ? `قراءة فقط · ${fmt.relative(d.observed.at)}. لا نشر ولا تراجع تلقائي.` : "لم يُقرأ بعد" },
      h("ul", { class: "ops-list" }, Object.entries(d.environments).map(([env, e]) => h("li", { class: "vps-deploy" },
        h("strong", null, ENV[env] || env, e.expected === "retired" ? h("small", { class: "ops-dim" }, " · مُوقَفة") : null),
        h("dl", { class: "vps-dl" },
          h("div", null, h("dt", null, "الإصدار الحالي"), h("dd", null, bdi(e.currentRelease || "—"))),
          h("div", null, h("dt", null, "Commit"), h("dd", null, short(e.commitSha), e.branch ? [" · ", bdi(e.branch, "co-tech-soft")] : null)),
          h("div", null, h("dt", null, "وقت النشر"), h("dd", null, e.deployedAt ? fmt.when(e.deployedAt) : "—")),
          h("div", null, h("dt", null, "مطابقة فحص الصحة"), h("dd", null, e.provenanceMatch === true ? badge("ok", "مطابق") : e.provenanceMatch === false ? badge("warn", `مختلف: ${e.publicHealthCommit?.slice(0, 7)}`) : badge("muted", "غير متاح"))),
          h("div", null, h("dt", null, "إصدار للتراجع"), h("dd", null, e.rollbackCandidate ? bdi(e.rollbackCandidate) : "—", ` · ${e.releases.length} إصدار محفوظ`)))))),
      d.postgres ? h("dl", { class: "vps-dl" },
        h("div", null, h("dt", null, "PostgreSQL"), h("dd", null, badge(d.postgres.accepting ? "ok" : "bad", d.postgres.accepting ? "يقبل الاتصالات" : "لا يقبل"), " ", bdi(d.postgres.version || ""))),
        h("div", null, h("dt", null, "الاتصالات"), h("dd", null, fmt.num(d.postgres.connections))),
        ...d.postgres.databases.map((db) => h("div", null, h("dt", null, bdi(db.name)), h("dd", null, mb(db.bytes)))),
        d.nginx?.version ? h("div", null, h("dt", null, "Nginx"), h("dd", null, bdi(d.nginx.version), d.nginx.activeSince ? ` · نشط منذ ${fmt.when(d.nginx.activeSince)}` : "")) : null) : null);
  }

  function incidentsPanel(o, list) {
    return panelX({ title: "سجل الحوادث", hint: "تُفتح الحادثة بعد تكرار الرصد (لا تنبيه لكل ارتفاع عابر)، وتُغلق تلقائيًا عند التعافي. الأوقات بتوقيت القاهرة." },
      list.length ? h("ol", { class: "vps-timeline" }, list.slice(0, 30).map((i) => {
        const [tone, text] = SEV[i.severity] || ["muted", i.severity];
        const dur = i.recoveredAt ? Math.round((Date.parse(i.recoveredAt) - Date.parse(i.startedAt)) / 60000) : null;
        return h("li", { class: `vps-inc vps-inc-${i.state}` },
          h("div", { class: "co-inline" }, badge(tone, text), i.state === "open" ? badge("bad", "مفتوحة") : badge("ok", "تعافت"), h("strong", null, O.rich(i.title))),
          h("small", null, `بدأت ${fmt.when(i.startedAt)}`, i.recoveredAt ? ` · تعافت ${fmt.when(i.recoveredAt)} (${dur < 1 ? "أقل من دقيقة" : `${dur} دقيقة`})` : ` · آخر رصد ${fmt.relative(i.lastSeenAt)}`, " · الرصد: ", bdi(i.detection, "co-tech-soft")),
          h("div", { class: "co-inline" }, i.assignedAgent ? h("span", { class: "ops-chip" }, C.avatar(i.assignedAgent), C.assigneeName(i.assignedAgent)) : null,
            i.taskId ? h("button", { type: "button", class: "ops-link", onclick: () => C.openTask(i.taskId) }, "مهمة المتابعة") : null,
            i.diagnosisRunId ? h("button", { type: "button", class: "ops-link", onclick: () => window.AbudWorkforce?.openRun(i.diagnosisRunId) }, "التشخيص") :
              h("button", { type: "button", class: "ops-link", onclick: (e) => diagnose(e.currentTarget, i) }, `اطلب تشخيص ${C.assigneeName(i.assignedAgent || "ori")}`)));
      })) : h("div", { class: "co-empty" }, icon("check", 26), h("p", null, "لا حوادث في آخر 60 يومًا.")));
  }

  function toolsPanel(o) {
    const services = o.services.filter((s) => s.kind === "pm2" && !["retired", "absent"].includes(s.state)).map((s) => [s.service, s.service]);
    const diagSel = select("diagnostic", DIAGNOSTICS, ui.diag, { "aria-label": "الفحص التشخيصي", onchange: (e) => { ui.diag = e.target.value; } });
    const logSel = select("logSource", LOGS, ui.logSource, { "aria-label": "مصدر السجل", onchange: (e) => { ui.logSource = e.target.value; render(); } });
    const svcSel = select("logService", [["", "اختر الخدمة"], ...services], ui.logService, { "aria-label": "الخدمة", onchange: (e) => { ui.logService = e.target.value; } });
    return panelX({ title: "تشخيص آمن وسجلات منقّحة", hint: "فحوص قراءة فقط من قائمة ثابتة. السجلات مقتطعة ومنقّحة (أسرار، رموز، بريد، عناوين IP، استعلامات). كل قراءة تُسجَّل في النشاط." },
      h("div", { class: "co-inline" }, diagSel, button("تشغيل الفحص", (e) => runDiag(e.currentTarget, o.id), { icon: "play" })),
      h("div", { class: "co-inline" }, logSel, ui.logSource === "pm2-error" ? svcSel : null, button("قراءة السجل", (e) => readLog(e.currentTarget, o.id), { icon: "list" })),
      ui.output ? h("div", { class: "vps-output" }, h("strong", null, ui.outputTitle), h("pre", { class: "co-pre", dir: "ltr" }, ui.output)) : null);
  }

  function actionsHistory(actions) {
    const done = actions.filter((a) => a.status !== "proposed").slice(0, 8);
    return panelX({ title: "سجل الإجراءات", hint: "كل إجراء: من طلبه، من وافق، ما نُفذ، والتحقق اللاحق." },
      done.length ? h("ul", { class: "ops-list" }, done.map((a) => {
        const [tone, text] = ACTION_STATUS[a.status] || ["muted", a.status];
        return h("li", null, h("strong", null, a.ar, a.params.service ? [" · ", bdi(a.params.service)] : null), badge(tone, text),
          h("small", { class: "ops-dim" }, `${fmt.when(a.finishedAt || a.decidedAt || a.createdAt)} · طلبه ${C.assigneeName(a.requestedBy.split(":")[1] || "owner")}${a.result?.ar ? ` · ${a.result.ar}` : ""}`));
      })) : empty("لا إجراءات بعد."));
  }

  function settingsPanel(s) {
    const num = (name, value, min, max) => h("input", { class: "ops-input", type: "number", name, min, max, value });
    const form = h("form", { class: "co-form-grid", onsubmit: async (e) => {
      e.preventDefault();
      const v = O.formValues(form);
      const thresholds = Object.fromEntries(["diskWarnPct", "diskCritPct", "memWarnPct", "cpuWarnPct", "sustainedChecks", "certWarnDays", "unreachableChecks"].map((k) => [k, Number(v[k])]));
      if (await act(form.querySelector("[type=submit]"), () => mutate("PATCH", "/vps/settings", { basicIntervalSec: Number(v.basicIntervalSec), inventoryIntervalSec: Number(v.inventoryIntervalSec), siteIntervalSec: Number(v.siteIntervalSec), dailySummary: form.dailySummary.checked, thresholds }), "حُفظت إعدادات المراقبة")) load(true);
    } },
    h("div", { class: "co-form-row" }, field("فحص التوافر (ثانية)", num("basicIntervalSec", s.basicIntervalSec, 30, 900), "SSH قراءة فقط؛ لا فحوص متداخلة. يتباعد تلقائيًا عند الفشل."), field("جرد النشر وقاعدة البيانات (ثانية)", num("inventoryIntervalSec", s.inventoryIntervalSec, 300, 7200)), field("فحص المواقع (ثانية)", num("siteIntervalSec", s.siteIntervalSec, 60, 1800))),
    h("div", { class: "co-form-row" }, field("تحذير القرص %", num("diskWarnPct", s.thresholds.diskWarnPct, 50, 99)), field("القرص حرج %", num("diskCritPct", s.thresholds.diskCritPct, 60, 100)), field("الذاكرة %", num("memWarnPct", s.thresholds.memWarnPct, 50, 100)), field("المعالج %", num("cpuWarnPct", s.thresholds.cpuWarnPct, 50, 100))),
    h("div", { class: "co-form-row" }, field("فحوص متتالية قبل تنبيه الموارد", num("sustainedChecks", s.thresholds.sustainedChecks, 2, 30)), field("فحوص فاشلة قبل «غير قابل للوصول»", num("unreachableChecks", s.thresholds.unreachableChecks, 2, 20)), field("تنبيه انتهاء الشهادة (أيام)", num("certWarnDays", s.thresholds.certWarnDays, 3, 60))),
    h("label", { class: "co-check-field" }, h("input", { type: "checkbox", name: "dailySummary", checked: s.dailySummary ? true : null }),
      h("span", null, h("strong", null, "ملخص يومي من ORI"), h("small", null, "تشغيل واحد يوميًا بعد الثامنة صباحًا بتوقيت الشركة، فقط عند وجود تغيير (حادثة أو تعافٍ أو نشر). يستهلك استدلالًا من OmniRoute."))),
    h("div", { class: "co-form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "حفظ إعدادات المراقبة")));
    return panel("إعدادات المراقبة", "المراقبة الدورية حتمية بلا ذكاء اصطناعي؛ الوكلاء يُستدعون عند طلبك أو للتشخيص أو للملخص اليومي إن فعّلته.", form);
  }

  // ---------------------------------------------------------------- actions: propose → review → approve → execute → verify
  function actionCard(a, o) {
    const r = a.review;
    const confirmInput = h("input", { class: "ops-input", dir: "ltr", placeholder: r.confirmPhrase, "aria-label": `اكتب ${r.confirmPhrase} للتأكيد`, autocomplete: "off" });
    const row = (k, v) => h("div", null, h("dt", null, k), h("dd", null, v));
    return h("li", { class: "co-approval co-approval-pending vps-approval" },
      h("div", { class: "co-inline" }, badge(r.risk === "high" ? "bad" : "warn", r.risk === "high" ? "خطورة عالية" : "خطورة متوسطة"), badge(a.environment === "production" ? "bad" : "info", ENV[a.environment] || a.environment), h("strong", null, a.ar, a.params.service ? [" · ", bdi(a.params.service)] : null)),
      h("dl", { class: "vps-dl" },
        row("الخادم", [o.name, " · ", bdi(o.endpoint, "co-tech-soft")]),
        row("الأمر المسموح", bdi(r.command, "co-tech-soft")),
        row("السبب", O.rich(a.reason)),
        row("طلبه", C.assigneeName(a.requestedBy.split(":")[1] || "owner")),
        row("الأثر المتوقع", r.impactAr), row("التوقف المحتمل", r.downtimeAr),
        row("الشروط المسبقة", h("ul", { class: "vps-bullets" }, (r.preconditionsAr || []).map((x) => h("li", null, x)))),
        row("التحقق بعد التنفيذ", r.verificationAr), row("الاسترداد", r.recoveryAr),
        row("الطلب", `${fmt.when(a.createdAt)} · ينتهي الاقتراح بعد 24 ساعة`)),
      h("div", { class: "co-inline" }, field(`للتأكيد اكتب «${r.confirmPhrase}»`, confirmInput),
        button("موافقة وتنفيذ", (e) => approveAndRun(e.currentTarget, a, confirmInput), { kind: "danger", icon: "check" }),
        button("رفض", async (e) => { if (await act(e.currentTarget, () => mutate("POST", `/vps/actions/${a.id}/reject`, {}), "رُفض الإجراء")) refreshAll(); })));
  }
  async function approveAndRun(trigger, a, input) {
    if (input.value.trim() !== a.review.confirmPhrase) { toast(`اكتب «${a.review.confirmPhrase}» حرفيًا`, "bad"); input.focus(); return; }
    const ok = await O.confirmDialog({ title: `تنفيذ: ${a.ar}${a.params.service ? ` (${a.params.service})` : ""}`, body: `${a.review.impactAr} سيُنفذ الأمر المسموح فقط ثم يُتحقق من الحالة. هل تريد المتابعة؟`, confirm: "نفّذ الآن", tone: "danger" });
    if (!ok) return;
    const approval = await act(trigger, () => mutate("POST", `/vps/actions/${a.id}/approve`, { confirmText: input.value.trim() }), null);
    if (!approval) return;
    toast("جارٍ التنفيذ والتحقق…", "info");
    const result = await act(trigger, () => mutate("POST", `/vps/actions/${a.id}/execute`, { token: approval.token }), null);
    if (result) toast(result.status === "succeeded" ? `نجح وتحقق: ${result.ar}` : `لم يثبت النجاح: ${result.result?.ar || result.status}`, result.status === "succeeded" ? "ok" : "bad");
    refreshAll();
  }
  function proposeDialog(o, operation, service) {
    const d = O.drawer(operation === "pm2.restart" ? `اقتراح إعادة تشغيل ${service}` : "اقتراح إعادة تحميل Nginx");
    const reason = h("textarea", { class: "ops-input", rows: 3, maxlength: 500, required: true, "aria-label": "سبب الإجراء" });
    fill(d.body, notice("warn", "اقتراح فقط", "يُسجَّل الاقتراح ثم تراجعه وتوافق عليه صراحة؛ لا شيء يُنفذ الآن."),
      field("لماذا؟ (مطلوب)", reason),
      button("إنشاء الاقتراح", async (e) => {
        if (reason.value.trim().length < 8) { toast("اكتب سببًا واضحًا", "bad"); reason.focus(); return; }
        if (await act(e.currentTarget, () => mutate("POST", "/vps/actions", { hostId: o.id, operation, service, reason: reason.value.trim() }), "أُنشئ الاقتراح؛ راجعه في أعلى الصفحة")) { d.close(); refreshAll(); }
      }, { kind: "primary" }));
  }

  // ---------------------------------------------------------------- owner operations
  async function probe(trigger, id) {
    const r = await act(trigger, () => mutate("POST", `/vps/hosts/${id}/probe`, { kind: "all" }), null);
    if (r) toast(r.basic?.ok ? "اكتمل الفحص" : `فشل الفحص: ${r.basic?.category || "غير معروف"}`, r.basic?.ok ? "ok" : "bad");
    refreshAll();
  }
  async function runDiag(trigger, id) {
    const r = await act(trigger, () => mutate("POST", `/vps/hosts/${id}/diagnostics`, { diagnostic: ui.diag }), null);
    if (!r) return;
    ui.outputTitle = `${r.ar} · ${fmt.when(r.ranAt)}`;
    ui.output = r.ok ? (r.output.lines.join("\n") || "(لا مخرجات)") : `تعذر التنفيذ: ${r.error.ar}`;
    render();
  }
  async function readLog(trigger, id) {
    if (ui.logSource === "pm2-error" && !ui.logService) { toast("اختر الخدمة", "bad"); return; }
    const r = await act(trigger, () => mutate("POST", `/vps/hosts/${id}/logs`, { source: ui.logSource, service: ui.logService || undefined }), null);
    if (!r) return;
    ui.outputTitle = `${r.ar}${r.service ? ` · ${r.service}` : ""} · ${r.log ? `${r.log.shown} من ${r.log.totalLines} سطر، ${r.log.errorLike} تبدو أخطاء` : ""}`;
    ui.output = r.ok ? (r.log.lines.join("\n") || "(لا سطور مطابقة)") : `تعذر القراءة: ${r.error.ar}`;
    render();
  }
  async function diagnose(trigger, incident) {
    const run = await act(trigger, () => mutate("POST", `/vps/incidents/${incident.id}/diagnose`, {}), `أُسند التشخيص إلى ${C.assigneeName(incident.assignedAgent || "ori")}`);
    if (run) { loadIncidents(incident.hostId, true); O.invalidate("runs", "summary"); }
  }
  function refreshAll() {
    load(true); loadActions(true);
    for (const h0 of peek("vps")?.hosts || []) { loadIncidents(h0.id, true); loadMetrics(h0.id, true); }
    O.invalidate("summary", "notifications", "activity");
  }

  // ---------------------------------------------------------------- startup panel (System → overview)
  function renderStartup() {
    const s = peek("startup");
    if (!s) { fill(sStartup, O.resourceStatus(O.peek("co:startup"), "التشغيل التلقائي")); return; }
    const r = s.omniroute.connection;
    const l = s.company.launcher;
    const toggle = (on, onAction, offAction) => button(on ? "إيقاف" : "تفعيل", async (e) => {
      if (await act(e.currentTarget, () => mutate("POST", "/startup/action", { action: on ? offAction : onAction }), on ? "أُوقف التشغيل التلقائي" : "فُعّل التشغيل التلقائي")) loadStartup(true);
    }, { icon: on ? "close" : "check" });
    const routerTone = r.state === "connected" ? "ok" : r.state === "unknown" ? "muted" : "bad";
    fill(sStartup, panelX({ title: "التشغيل عند تسجيل الدخول إلى Windows", hint: "بعد تسجيل الدخول: يبدأ OmniRoute ثم الـ Bridge وقاعدة البيانات، وتعمل الواجهة فورًا حتى لو تأخر OmniRoute؛ يصبح الوكلاء متاحين عند اتصاله." },
      h("div", { class: "sy-cards" },
        h("article", { class: "sy-card" }, h("div", { class: "sy-card-head" }, h("span", { class: "sy-card-icon" }, icon("system", 22)), h("div", { class: "sy-card-title" }, h("h3", null, "Company OS"), badge(s.company.autostart ? "ok" : "muted", s.company.autostart ? "يبدأ تلقائيًا" : "لا يبدأ تلقائيًا"))),
          h("dl", null,
            h("div", null, h("dt", null, "الآلية"), h("dd", null, "اختصار في مجلد بدء التشغيل")),
            h("div", null, h("dt", null, "المراقب"), h("dd", null, s.company.supervisor ? badge("ok", "يعمل (حد 3 إعادات/ساعة)") : badge("muted", "غير نشط"))),
            h("div", null, h("dt", null, "آخر تشغيل ناجح"), h("dd", null, l?.lastSuccessAt ? fmt.when(l.lastSuccessAt) : "—", l?.mode ? h("small", { class: "ops-dim" }, ` (${l.mode === "sign-in" ? "تسجيل الدخول" : "يدوي"})`) : null)),
            h("div", null, h("dt", null, "آخر فشل"), h("dd", null, l?.lastFailureAt ? [fmt.when(l.lastFailureAt), h("div", { class: "ops-dim" }, O.rich(l.lastFailure || ""))] : "لا يوجد")),
            l?.supervisorRestarts ? h("div", null, h("dt", null, "إعادات بعد خروج غير نظيف"), h("dd", null, String(l.supervisorRestarts))) : null,
            h("div", null, h("dt", null, "فتح المتصفح عند الدخول"), h("dd", null, h("label", { class: "co-inline-check" }, h("input", { type: "checkbox", checked: s.company.openBrowserAtSignIn ? true : null, onchange: async (e) => {
              if (await act(null, () => mutate("POST", "/startup/action", { action: e.target.checked ? "browser-at-signin-on" : "browser-at-signin-off" }), "حُفظ التفضيل")) loadStartup(true);
            } }), "مرة واحدة بعد النجاح"))) ),
          toggle(s.company.autostart, "company-autostart-on", "company-autostart-off")),
        h("article", { class: "sy-card" }, h("div", { class: "sy-card-head" }, h("span", { class: "sy-card-icon" }, icon("resources", 22)), h("div", { class: "sy-card-title" }, h("h3", null, "OmniRoute"), badge(s.omniroute.autostart ? "ok" : "muted", s.omniroute.autostart ? "يبدأ تلقائيًا" : "لا يبدأ تلقائيًا"))),
          h("dl", null,
            h("div", null, h("dt", null, "الآلية"), h("dd", null, bdi("omniroute autostart"))),
            h("div", null, h("dt", null, "الاتصال الآن"), h("dd", null, badge(routerTone, { connected: "متصل", offline: "غير متصل", unknown: "غير معروف" }[r.state] || r.state))),
            h("div", null, h("dt", null, "آخر اتصال ناجح"), h("dd", null, r.lastConnectedAt ? fmt.when(r.lastConnectedAt) : "—")),
            h("div", null, h("dt", null, "آخر فشل اتصال"), h("dd", null, r.lastFailureAt ? [fmt.when(r.lastFailureAt), " ", bdi(r.lastFailureState || "")] : "لا يوجد منذ تشغيل الـ Bridge")),
            h("div", null, h("dt", null, "عودة الاتصال"), h("dd", null, `${r.reconnects} مرة منذ تشغيل الـ Bridge`))),
          h("div", { class: "co-inline" }, toggle(s.omniroute.autostart, "omniroute-autostart-on", "omniroute-autostart-off"),
            button("إعادة محاولة الاتصال", async (e) => { const x = await act(e.currentTarget, () => mutate("POST", "/startup/action", { action: "router-retry" }), null); if (x) { toast(x.router === "connected" ? "OmniRoute متصل" : `ما زال غير متصل (${x.router})`, x.router === "connected" ? "ok" : "bad"); loadStartup(true); api.infra(true); } }, { icon: "refresh" }),
            r.state !== "connected" && s.omniroute.installed ? button("تشغيل OmniRoute", async (e) => { if (await act(e.currentTarget, () => mutate("POST", "/startup/action", { action: "router-start" }), "طُلب تشغيل OmniRoute؛ قد يستغرق حتى دقيقة")) setTimeout(() => loadStartup(true), 20_000); }, { kind: "primary", icon: "play" }) : null)))));
  }

  // ---------------------------------------------------------------- shared panels for HQ and project detail
  O.serversProjectPanel = (p) => {
    const list = p.infrastructure || [];
    if (!list.length) return null;
    return list.map((x) => panelX({ title: `الخادم: ${x.name}`, hint: "حالة الإنتاج والنشر لهذا المشروع.", actions: O.linkButton("مركز السيرفرات", href("system", "servers"), { icon: "chevronLeft" }) },
      h("div", { class: "co-inline" }, connBadge(x.connection), ...Object.entries(x.sites || {}).map(([env, s]) => { const [tone, text] = SITE[s.state] || ["muted", s.state]; return badge(tone, `${ENV[env] || env}: ${text}`); })),
      h("ul", { class: "ops-list" }, x.services.map((s) => h("li", null, bdi(s.service), badge(SVC[s.state] || "muted", s.ar), s.stale ? badge("warn", "قديمة") : null))),
      x.deployment?.environments?.production ? h("p", { class: "ops-dim" }, "الإنتاج: ", bdi(x.deployment.environments.production.currentRelease || "—"), " · ", short(x.deployment.environments.production.commitSha), x.deployment.environments.production.deployedAt ? ` · ${fmt.when(x.deployment.environments.production.deployedAt)}` : "") : null,
      x.incidents.length ? h("ul", { class: "ops-list" }, x.incidents.slice(0, 4).map((i) => h("li", null, badge(SEV[i.severity]?.[0] || "muted", i.state === "open" ? "مفتوحة" : "تعافت"), O.rich(i.title), h("small", { class: "ops-dim" }, fmt.relative(i.startedAt))))) : h("p", { class: "ops-dim" }, "لا حوادث في آخر 14 يومًا."),
      x.tasks.length ? h("p", null, `${x.tasks.length} مهمة بنية تحتية مفتوحة`) : null));
  };
  /** HQ attention items: only open warning/critical incidents, unreachable hosts and pending approvals. */
  O.serversAttention = (s) => {
    const inf = s.infrastructure;
    if (!inf) return [];
    const items = [];
    for (const i of inf.incidents || []) items.push({ sev: i.severity, ic: "globe", title: i.title, sub: `حادثة خادم · منذ ${fmt.relative(i.startedAt)}`, href: href("system", "servers") });
    for (const host of inf.hosts || []) if (host.connection === "disconnected" && !(inf.incidents || []).some((i) => i.hostId === host.id && i.key === "unreachable")) items.push({ sev: "warning", ic: "globe", title: `${host.name}: تعذر الاتصال`, sub: "آخر حالة مؤكدة معروضة في مركز السيرفرات", href: href("system", "servers") });
    if (inf.actionsPending) items.push({ sev: "warning", ic: "shield", title: `${inf.actionsPending} إجراء خادم بانتظار موافقتك`, sub: "لا يُنفذ شيء دون موافقتك", href: href("system", "servers") });
    return items;
  };

  // ---------------------------------------------------------------- wiring
  O.on("co:vps", () => {
    if (O.state.view !== "system") return;
    for (const h0 of peek("vps")?.hosts || []) { loadMetrics(h0.id); loadIncidents(h0.id); }
    render();
  });
  O.on("co:vpsActions", () => { if (O.state.view === "system") render(); });
  O.on("co:startup", () => { if (O.state.view === "system") renderStartup(); });
  const watch = new Set();
  const ensureWatch = () => {
    for (const h0 of peek("vps")?.hosts || []) for (const key of [`co:vpsMetrics:${h0.id}:${ui.range}`, `co:vpsIncidents:${h0.id}`]) {
      if (watch.has(key)) continue;
      watch.add(key);
      O.on(key, () => { if (O.state.view === "system" && O.state.tab === "servers") render(); });
    }
  };
  O.on("co:vps", ensureWatch);
  window.AbudServers = {
    show(tab) {
      if (tab === "overview") loadStartup();
      if (tab === "servers") { load(); loadActions(); ensureWatch(); }
    },
    refresh() { refreshAll(); loadStartup(true); }
  };
  // Live refresh while the servers tab is visible (the bridge serves cached probe results; this never triggers SSH).
  setInterval(() => { if (O.state.view === "system" && O.state.tab === "servers" && document.visibilityState === "visible") { load(true); loadActions(true); } }, 30_000);
  render(); renderStartup();
})();
