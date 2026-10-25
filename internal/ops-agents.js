/* AI Agents — replaces the reserved Agent System placeholder (internal mode only) with discovery-based monitoring.
 * Displays only what is discoverable. Provider health, process presence and task activity are kept as separate facts. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O) return;
  const { h, tr, fmt, badge, source, stateLabel, stateTone, notice, api, on } = O;
  const section = document.getElementById("agentSystem");
  if (!section) return;
  section.classList.add("ops-section");

  const INSTALL = { installed: ["ok", () => tr("مثبّت", "Installed")], "config-only": ["warn", () => tr("إعدادات فقط", "Config only")], "not-found": ["muted", () => tr("غير موجود", "Not found")], error: ["bad", () => tr("خطأ", "Error")] };
  const HEALTH = { healthy: ["ok", () => tr("سليم", "Healthy")], degraded: ["warn", () => tr("متدهور", "Degraded")], "not-connected": ["muted", () => tr("غير موصول بالراوتر", "Not connected to router")], unknown: ["muted", () => tr("غير معروف", "Unknown")], "not-applicable": ["muted", () => tr("لا ينطبق", "Not applicable")] };
  const COVERAGE = {
    "routed-through-router": () => tr("طلبات الأداة تمر عبر OmniRoute — أرقام الراوتر تعكس استهلاكها.", "This tool's requests go through OmniRoute — router figures reflect its usage."),
    "direct-not-routed": () => tr("الأداة تتصل بمزوّدها مباشرة — أرقام استخدام الراوتر لا تشمل طلباتها (قد تظهر حصة الحساب فقط).", "This tool talks to its provider directly — router usage figures do not include its requests (only the shared account quota may be visible)."),
    "router-account-quota": () => tr("الحصة تأتي من حساب مزوّد موصول بالراوتر؛ استهلاك تطبيق الأداة نفسه غير مرصود.", "Quota comes from a provider account connected to the router; the desktop tool's own consumption is not observed."),
    unknown: () => tr("غير معروف.", "Unknown.")
  };

  const row = (label, ...value) => h("div", { class: "ops-row" }, h("dt", null, label), h("dd", null, ...value));
  const pill = (map, key) => { const [tone, label] = map[key] || ["muted", () => String(key)]; return badge(tone, label()); };

  function agentCard(agent) {
    const proc = agent.process || {};
    const quota = agent.quota || {};
    const native = quota.nativeStatus;
    return h("article", { class: "ops-card ops-agent", "data-agent": agent.id },
      h("header", { class: "ops-card-head" },
        h("div", null, h("h3", null, agent.name), h("span", { class: "ops-dim" }, agent.install?.version ? `v${agent.install.version}` : tr("الإصدار غير معروف", "Version unknown"))),
        h("div", { class: "ops-card-badges" }, pill(INSTALL, agent.install?.state), badge(agent.execution?.enabled ? "bad" : "ok", agent.execution?.enabled ? tr("تنفيذ مفعّل", "Execution on") : tr("التنفيذ معطّل", "Execution disabled"), agent.execution?.reason))),
      h("dl", { class: "ops-dl" },
        row(tr("التثبيت", "Install"), agent.install?.location || "—", agent.install?.versionSource ? h("span", { class: "ops-dim" }, ` · ${agent.install.versionSource}`) : null),
        row(tr("العملية (Process)", "Process"),
          proc.running == null ? badge("muted", tr("غير معروف", "Unknown")) : proc.running ? badge("info", `${tr("ظاهرة", "Present")} · ${proc.count}`) : badge("muted", tr("غير ظاهرة", "Not running")),
          h("span", { class: "ops-dim" }, ` ${proc.meaning || ""}`), proc.note ? h("div", { class: "ops-dim" }, proc.note) : null),
        row(tr("صحة المزوّد", "Provider health"), pill(HEALTH, agent.provider?.health), agent.provider?.routingProviders?.length ? h("span", { class: "ops-dim" }, ` · ${agent.provider.routingProviders.join(", ")} · ${agent.provider.connections.length} ${tr("اتصال", "conn.")}`) : null,
          agent.provider?.lockouts?.length ? h("div", { class: "ops-bad-text" }, agent.provider.lockouts.map((l) => `${l.model}: ${l.reason}`).join(" · ")) : null),
        row(tr("آخر نشاط ملحوظ", "Last observed activity"), agent.lastObserved ? [fmt.when(agent.lastObserved.at), h("span", { class: "ops-dim" }, ` (${fmt.relative(agent.lastObserved.at)})`), h("div", { class: "ops-dim" }, agent.lastObserved.source)] : h("span", { class: "ops-dim" }, tr("غير متاح", "Not available"))),
        row(tr("المهمة / الجلسة الحالية", "Active task / session"), badge("muted", tr("غير مكشوفة", "Not exposed")), h("span", { class: "ops-dim" }, ` ${agent.activeSession?.reason || ""}`)),
        row(tr("المشروع المرتبط", "Associated project"), agent.project?.state === "identified" ? [h("strong", null, agent.project.repo), h("span", { class: "ops-dim" }, ` · ${agent.project.reason}`)] : h("span", { class: "ops-dim" }, agent.project?.reason || tr("غير معروف", "Unknown"))),
        row(tr("النماذج المدعومة", "Models"), agent.models?.count ? [`${fmt.num(agent.models.count)} `, h("span", { class: "ops-dim" }, agent.models.source), h("details", { class: "ops-details" }, h("summary", null, tr("عيّنة", "Sample")), h("p", { class: "ops-code-list" }, agent.models.sample.join("  ·  ")))] : h("span", { class: "ops-dim" }, tr("غير متاحة من مصدر موثوق", "No reliable source"))),
        row(tr("مصدر الحصة", "Quota source"), quota.source === "unavailable" ? [source("unknown"), h("span", { class: "ops-dim" }, ` ${tr("لا مصدر آلي", "no automated source")}`)] : [source("provider-reported"), badge(stateTone(quota.state), stateLabel(quota.state)), h("span", { class: "ops-dim" }, ` ${quota.source}`)]),
        row(tr("تغطية الاستخدام", "Usage coverage"), h("span", null, (COVERAGE[agent.usageCoverage] || COVERAGE.unknown)())),
        row(tr("الأخطاء الأخيرة", "Recent errors"), h("span", { class: "ops-dim" }, `${tr("من الوكيل", "Agent")}: ${tr("غير مجمّعة", "not collected")} · ${tr("من المزوّد", "Provider")}: ${agent.recentErrors?.provider || "—"}`)),
        row(tr("صحة الإعدادات", "Configuration health"), badge(agent.configHealth === "ok" ? "ok" : "warn", agent.configHealth === "ok" ? tr("سليمة", "OK") : tr("تحتاج مراجعة", "Needs attention")),
          h("ul", { class: "ops-checks" }, (agent.checks || []).map((c) => h("li", null, badge({ pass: "ok", warn: "warn", fail: "bad", info: "info" }[c.state] || "muted", c.state), h("span", null, ` ${c.detail}`)))))),
      native ? h("details", { class: "ops-details" }, h("summary", null, tr("الواجهة الأصلية للحالة/الحصة (غير مدعومة آليًا)", "Native status/quota interface (not machine-readable)")),
        h("p", null, native.reason), h("ol", null, native.manual.map((step) => h("li", null, step))),
        h("a", { class: "ops-link", href: "#view/usage" }, tr("افتح المطابقة اليدوية ←", "Open manual reconciliation →"))) : null);
  }

  function render() {
    const res = O.peek("agents");
    const data = res?.data;
    const overview = O.peek("overview")?.data;
    O.fill(section, 
      O.sectionShell({
        id: "agentSystem", kicker: "LOCAL DEVELOPER ENVIRONMENT", title: tr("أدوات التطوير المحلية", "Local developer tools"),
        subtitle: tr("اكتشاف ومراقبة للقراءة فقط. صحة المزوّد ≠ عملية الوكيل ≠ مهمة نشطة.", "Read-only discovery and monitoring. Provider health ≠ agent process ≠ active task."),
        actions: [data?.generatedAt ? h("span", { class: "ops-stamp" }, `${tr("آخر فحص", "Scanned")}: ${fmt.when(data.generatedAt)}`) : null,
          h("button", { type: "button", class: "btn btn-secondary", id: "opsAgentsRefresh", onclick: () => { api.overview(true); api.agents(true); } }, h("span", { class: "icon", "aria-hidden": "true" }, "↻"), tr("إعادة الفحص", "Rescan"))]
      }),
      h("div", { class: "ops-body" },
        O.resourceStatus(res, tr("اكتشاف الوكلاء", "Agent discovery")),
        notice("info", tr("صلاحيات التنفيذ معطّلة", "Execution permissions are disabled"), tr("هذه الصفحة لا تشغّل ولا توقف ولا ترسل أوامر إلى أي وكيل. التنفيذ يحتاج مرحلة منفصلة معتمدة.", "This page never starts, stops or instructs an agent. Execution needs a separate approved milestone.")),
        overview?.connection && overview.connection.state !== "connected" ? notice("warn", tr("حالة المزوّد غير متاحة", "Provider state unavailable"), tr("OmniRoute غير متصل بالصلاحيات اللازمة، فحالة المزوّد والحصص تظهر كغير معروفة.", "OmniRoute is not connected with valid credentials, so provider health and quota show as unknown.")) : null,
        data ? h("div", { class: "ops-grid ops-grid-wide" }, data.agents.map(agentCard)) : null,
        data ? h("p", { class: "ops-dim" }, tr("لإضافة وكيل جديد: أضف Adapter في apps/local-bridge/src/agents.mjs بنفس عقد الحقول؛ الواجهة لا تتغير.", "To add an agent: add an adapter in apps/local-bridge/src/agents.mjs with the same field contract; this UI does not change.")) : null));
  }

  // Local developer tools (Codex / Antigravity / Claude Code) are shown under Infrastructure; "agents" is the AI workforce.
  on("agents", render);
  on("overview", () => { if (O.peek("agents")?.data) render(); });
  window.addEventListener("abud:language", render);
  render();
})();
