/* AI Usage & Quotas — a management/observability layer over the installed OmniRoute. It reuses the router's own
 * documented APIs through the Local Bridge; nothing here re-implements usage tracking, and no number is inferred. */
(() => {
  "use strict";
  const O = window.AbudOps;
  if (!O) return;
  const { h, tr, fmt, badge, source, meter, stateLabel, stateTone, notice, api, on, store } = O;
  const RANGES = ["1d", "7d", "30d", "90d", "all"];
  const RANGE_KEY = "abud-ops-usage-range";
  const MANUAL_KEY = "abud-ops-manual-quota-v1";
  const PRIORITY_PROVIDERS = ["codex", "antigravity", "agy"];
  const CODING_AGENTS = { codex: "Codex", antigravity: "Google Antigravity" };

  let range = RANGES.includes(store.read(RANGE_KEY, "7d")) ? store.read(RANGE_KEY, "7d") : "7d";
  let providerFilter = "all";
  // V2: one live OmniRoute section shared by three AI-Resources tabs; each block declares the tab(s) it belongs to.
  const section = O.section("opsUsage", "resources", "quotas usage providers");
  const body = h("div", { class: "ops-body" });
  const head = h("div", { class: "ops-toolbar" });
  section.append(head, body);
  const forTab = (tabs, ...children) => h("div", { class: "ops-body", "data-os-tab": tabs }, ...children);

  // ---------------------------------------------------------------- helpers
  const chip = (text) => h("span", { class: "ops-chip" }, text);
  const kv = (label, value) => h("div", { class: "ops-kv" }, h("span", null, label), h("strong", null, value));
  const subsection = (title, hint, ...children) => h("section", { class: "ops-panel" }, h("header", { class: "ops-panel-head" }, h("h3", null, title), hint ? h("p", null, hint) : null), ...children);

  function connectionBanner(overview) {
    const c = overview?.connection;
    if (!c || c.state === "connected") return null;
    const host = c.baseHost || "127.0.0.1:20128";
    const text = {
      offline: [tr("OmniRoute غير متاح", "OmniRoute is not reachable"), tr(`لا توجد استجابة من ${host}. شغّل OmniRoute محليًا ثم حدّث.`, `No response from ${host}. Start OmniRoute locally, then refresh.`)],
      "auth-required": [tr("OmniRoute يتطلب مفتاح API", "OmniRoute requires an API key"), tr("ضبط OMNIROUTE_API_KEY في بيئة تشغيل الـ Local Bridge. لا يُخزَّن المفتاح في المتصفح ولا يُعرض هنا.", "Set OMNIROUTE_API_KEY in the environment that launches the Local Bridge. The key is never stored in the browser or shown here.")],
      forbidden: [tr("المفتاح لا يملك صلاحية القراءة", "The API key lacks read permission"), tr("أنشئ مفتاحًا بأقل صلاحيات قراءة لمسارات usage/providers.", "Create a least-privilege key allowed to read usage and providers.")],
      "rate-limited": [tr("OmniRoute طلب التمهّل", "OmniRoute asked us to slow down"), tr(`احترمنا Retry-After${c.retryAfterMs ? ` (${Math.ceil(c.retryAfterMs / 1000)} ث)` : ""}. سيُعاد التحميل لاحقًا.`, `Retry-After is being honoured${c.retryAfterMs ? ` (${Math.ceil(c.retryAfterMs / 1000)} s)` : ""}. Try again shortly.`)],
      timeout: [tr("انتهت مهلة OmniRoute", "OmniRoute timed out"), tr("الراوتر يعمل لكنه لم يرد في الوقت المحدد.", "The router is up but did not answer in time.")],
      misconfigured: [tr("إعداد الراوتر مرفوض", "Router configuration rejected"), tr("عنوان OmniRoute غير loopback أو غير صالح؛ الـ Bridge يرفض الاتصال بعناوين غير محلية افتراضيًا.", "The OmniRoute URL is invalid or not loopback; the bridge refuses non-local routers by default.")]
    }[c.state] || [tr("خطأ في الراوتر", "Router error"), c.message || ""];
    return notice(c.state === "offline" || c.state === "auth-required" ? "bad" : "warn", text[0], text[1]);
  }

  function windowRow(win, conn) {
    const money = win.unit === "currency-balance";
    const reportedText = money
      ? `${fmt.num(win.remaining)} ${win.currency || ""} ${tr("رصيد", "balance")}`
      : win.total != null ? `${fmt.num(win.used)} / ${fmt.num(win.total)} ${win.unit === "percent-of-allowance" ? tr("من الحصة", "of allowance") : tr("وحدة المزوّد", "provider units")}` : tr("غير متاح", "n/a");
    return h("li", { class: `ops-window ops-state-${win.state}` },
      h("div", { class: "ops-window-head" }, h("strong", null, win.label), badge(stateTone(win.state), stateLabel(win.state))),
      money ? null : meter(win.remainingPct, win.state, `${win.label} ${tr("المتبقي", "remaining")}`),
      h("div", { class: "ops-window-meta" },
        h("span", null, win.unlimited ? tr("غير محدود", "Unlimited") : money ? reportedText : `${win.remainingPct != null ? fmt.pct(win.remainingPct, win.remainingPct % 1 ? 1 : 0) : "—"} ${tr("متبقٍ", "remaining")}`),
        money || win.unlimited ? null : h("span", null, reportedText),
        win.resetAt ? h("span", null, `${tr("يُعاد الضبط", "Resets")}: ${fmt.when(win.resetAt)} (${fmt.relative(win.resetAt)})`) : h("span", { class: "ops-dim" }, tr("وقت إعادة الضبط غير معروف", "Reset time not reported")),
        win.windowSeconds ? h("span", { class: "ops-dim" }, `${tr("نافذة", "window")} ${win.windowSeconds >= 86400 ? `${Math.round(win.windowSeconds / 86400)}d` : `${Math.round(win.windowSeconds / 3600)}h`}`) : null));
  }

  function connectionBlock(conn) {
    const q = conn.quota;
    const tone = conn.health24h?.state && conn.health24h.state !== "healthy" ? "warn" : "ok";
    const supportText = {
      "not-exposed": tr("هذا المزوّد لا يكشف الحصة عبر الراوتر — لا توجد أرقام. (لا نستنتج حصة من عدد التوكنز.)", "This provider does not expose quota through the router — no figures are shown. (Allowance is never inferred from token counts.)"),
      "no-windows": tr("الراوتر رد بدون نوافذ حصة.", "The router answered without quota windows."),
      error: tr("تعذر قراءة الحصة الآن.", "Quota could not be read right now."),
      "rate-limited": tr("الحصة مؤجلة بسبب Retry-After.", "Quota fetch deferred because of Retry-After.")
    }[q?.support];
    return h("div", { class: "ops-conn" },
      h("div", { class: "ops-conn-head" },
        h("span", { class: "ops-conn-id" }, `${tr("اتصال", "Connection")} ${conn.shortId}`),
        conn.active ? badge("ok", tr("نشط", "Active")) : badge("muted", tr("متوقف", "Inactive")),
        conn.routerHealth ? badge(conn.routerHealth === "healthy" ? "ok" : "warn", `${tr("الراوتر", "Router")}: ${conn.routerHealth}`) : null,
        conn.health24h ? badge(tone, `24h: ${conn.health24h.state}${conn.health24h.successRatePct != null ? ` · ${fmt.pct(conn.health24h.successRatePct)}` : ""}`, tr("صحة آخر 24 ساعة كما يرصدها الراوتر", "Last-24h health as observed by the router")) : null,
        q?.plan ? chip(`${tr("الخطة", "Plan")}: ${q.plan}`) : null),
      q?.windows?.length ? h("ul", { class: "ops-windows" }, q.windows.map((win) => windowRow(win, conn))) : h("p", { class: "ops-dim" }, supportText || tr("لا بيانات.", "No data.")),
      q?.perModel?.length ? h("details", { class: "ops-details" }, h("summary", null, `${tr("حدود لكل نموذج", "Per-model limits")} (${q.perModel.length})`),
        h("ul", { class: "ops-permodel" }, q.perModel.map((m) => h("li", null, h("span", null, m.model), badge(stateTone(m.state), `${m.remainingPct != null ? fmt.pct(m.remainingPct) : "—"} · ${stateLabel(m.state)}`), m.resetAt ? h("span", { class: "ops-dim" }, fmt.relative(m.resetAt)) : null)))) : null,
      q?.extras?.bankedResetCredits != null || q?.extras?.paidCredits ? h("div", { class: "ops-extras" },
        q.extras.bankedResetCredits != null ? chip(`${tr("رصيد إعادة ضبط مخزّن", "Banked reset credits")}: ${q.extras.bankedResetCredits}`) : null,
        q.extras.paidCredits ? chip(`${tr("رصيد مدفوع", "Paid credits")}: ${q.extras.paidCredits.hasCredits ? fmt.num(q.extras.paidCredits.balance) : tr("لا يوجد", "none")}`) : null,
        q.extras.routerObservedSpeed?.medianTps != null ? chip(`${tr("سرعة (الراوتر)", "Speed (router-observed)")}: ${fmt.num(Math.round(q.extras.routerObservedSpeed.medianTps))} tok/s`) : null) : null,
      q?.fetchedAt ? h("div", { class: "ops-foot" }, `${tr("آخر جلب للحصة", "Quota fetched")}: ${fmt.when(q.fetchedAt)}`) : null);
  }

  function providerCard(provider, conns) {
    const worst = conns.map((c) => c.quota?.state || "unknown").reduce((a, b) => (O.stateRank[b] > O.stateRank[a] ? b : a), "unknown");
    const reported = conns.some((c) => c.quota?.support === "reported");
    const allWindows = conns.flatMap((c) => c.quota?.windows || []);
    const partial = ["exhausted", "critical"].includes(worst) && allWindows.some((w) => ["ok", "unlimited"].includes(w.state));
    const worstLabel = partial ? tr("نفدت بعض النوافذ", "Partly exhausted") : stateLabel(worst);
    return h("article", { class: `ops-card ops-provider ops-state-${worst}`, "data-provider": provider },
      h("header", { class: "ops-card-head" },
        h("h4", null, CODING_AGENTS[provider] ? `${CODING_AGENTS[provider]} · ${provider}` : provider),
        h("div", { class: "ops-card-badges" }, reported ? source("provider-reported") : source("unknown"), badge(stateTone(worst), worstLabel, partial ? tr("بعض نوافذ الحصة لا تزال متاحة", "Some quota windows are still available") : undefined))),
      conns.map(connectionBlock));
  }

  // ---------------------------------------------------------------- quota section
  function quotaSection(overview) {
    if (!overview?.connections?.length) return null;
    const byProvider = new Map();
    for (const conn of overview.connections) byProvider.set(conn.provider, [...(byProvider.get(conn.provider) || []), conn]);
    const rank = (provider) => {
      const idx = PRIORITY_PROVIDERS.indexOf(provider);
      return idx >= 0 ? idx : 10 + (["exhausted", "critical", "low"].some((s) => byProvider.get(provider).some((c) => c.quota?.state === s)) ? 0 : 1);
    };
    let providers = [...byProvider.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (providerFilter === "reported") providers = providers.filter((p) => byProvider.get(p).some((c) => c.quota?.support === "reported"));
    if (providerFilter === "alerts") providers = providers.filter((p) => byProvider.get(p).some((c) => ["exhausted", "critical", "low"].includes(c.quota?.state)));
    const qm = overview.router?.quotaMonitoring;
    const filters = ["all", "reported", "alerts"].map((id) => h("button", {
      type: "button", class: "ops-seg", "aria-pressed": providerFilter === id ? "true" : "false",
      onclick: () => { providerFilter = id; render(); }
    }, { all: tr("الكل", "All"), reported: tr("بها أرقام", "With figures"), alerts: tr("تنبيهات", "Alerts") }[id]));
    return subsection(tr("حصص المزوّدين", "Provider quotas"),
      tr("الأرقام هنا يعيدها المزوّد نفسه عبر OmniRoute. لا نجمع حصص مزوّدين مختلفين في رصيد واحد.", "Figures are returned by each provider and relayed by OmniRoute. Separate quota pools are never combined into a global balance."),
      h("div", { class: "ops-toolbar" }, h("div", { class: "ops-seggroup", role: "group", "aria-label": tr("تصفية المزوّدين", "Filter providers") }, filters),
        qm ? h("span", { class: "ops-dim" }, tr(`الراوتر نفسه يصرّح: مراقبة حصص موثوقة لـ ${qm.authoritative} من ${qm.authoritative + qm.headerBased + qm.configured + qm.unsupported} اتصالًا (غير مدعومة: ${qm.unsupported}).`, `The router itself reports authoritative quota monitoring for ${qm.authoritative} of ${qm.authoritative + qm.headerBased + qm.configured + qm.unsupported} connections (unsupported: ${qm.unsupported}).`)) : null),
      providers.length ? h("div", { class: "ops-grid" }, providers.map((p) => providerCard(p, byProvider.get(p)))) : h("p", { class: "ops-dim" }, tr("لا مزوّدين مطابقين للتصفية.", "No providers match this filter.")));
  }

  function alertsSection(overview) {
    const warnings = overview?.warnings || [];
    if (!overview?.connections?.length) return null;
    const quotaWarnings = warnings.filter((w) => ["exhausted", "critical", "low"].includes(w.level));
    const lockouts = overview.lockouts || [];
    const healthWarnings = warnings.filter((w) => w.level === "provider-health");
    if (!quotaWarnings.length && !lockouts.length && !healthWarnings.length) {
      return notice("ok", tr("لا تنبيهات حصص", "No quota alerts"), tr(`حدود التنبيه: منخفض ≤ ${overview.thresholds.warnPercent}% ، حرج ≤ ${overview.thresholds.criticalPercent}% من الأرقام المُبلَّغة فقط.`, `Thresholds: low ≤ ${overview.thresholds.warnPercent}%, critical ≤ ${overview.thresholds.criticalPercent}% — applied to provider-reported figures only.`));
    }
    return subsection(tr("تنبيهات", "Alerts"), tr(`حدود التنبيه: منخفض ≤ ${overview.thresholds.warnPercent}% ، حرج ≤ ${overview.thresholds.criticalPercent}%.`, `Thresholds: low ≤ ${overview.thresholds.warnPercent}%, critical ≤ ${overview.thresholds.criticalPercent}%.`),
      h("ul", { class: "ops-alerts" },
        quotaWarnings.map((w) => h("li", { class: `ops-alert ops-alert-${w.level}` }, badge(stateTone(w.level), stateLabel(w.level)), h("strong", null, w.provider), h("span", null, w.window), w.resetAt ? h("span", { class: "ops-dim" }, `${tr("يُعاد الضبط", "resets")} ${fmt.relative(w.resetAt)}`) : null)),
        lockouts.map((l) => h("li", { class: "ops-alert ops-alert-lockout" }, badge("bad", tr("قفل مؤقت", "Lockout")), h("strong", null, l.provider), h("span", null, `${l.model} · ${l.reason}`), l.until ? h("span", { class: "ops-dim" }, `${tr("حتى", "until")} ${fmt.when(l.until)}`) : null)),
        healthWarnings.map((w) => h("li", { class: "ops-alert ops-alert-health" }, badge("warn", tr("صحة المزوّد", "Provider health")), h("strong", null, w.provider), h("span", { class: "ops-dim" }, w.detail)))));
  }

  // ---------------------------------------------------------------- analytics
  function tile(label, value, note, kind) {
    return h("div", { class: "ops-tile" }, h("span", null, label), h("strong", null, value), note ? h("small", null, note) : null, kind ? source(kind) : null);
  }

  function dailyChart(trend) {
    if (!trend?.length) return h("p", { class: "ops-dim" }, tr("لا بيانات يومية في هذا النطاق.", "No daily data in this range."));
    const ns = "http://www.w3.org/2000/svg";
    const width = 640, height = 170, pad = { l: 40, r: 8, t: 14, b: 26 };
    const max = Math.max(...trend.map((d) => d.requests), 1);
    const slot = (width - pad.l - pad.r) / trend.length;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "ops-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", tr("الطلبات اليومية: ", "Daily requests: ") + trend.map((d) => `${d.date} ${d.requests}`).join(", "));
    const el = (tag, attrs, text) => { const node = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text != null) node.textContent = text; svg.append(node); return node; };
    el("line", { x1: pad.l, x2: width - pad.r, y1: height - pad.b, y2: height - pad.b, class: "ops-axis" });
    el("text", { x: pad.l - 6, y: pad.t + 4, class: "ops-axis-label", "text-anchor": "end" }, fmt.compact(max));
    el("text", { x: pad.l - 6, y: height - pad.b, class: "ops-axis-label", "text-anchor": "end" }, "0");
    trend.forEach((d, i) => {
      const barH = ((height - pad.t - pad.b) * d.requests) / max;
      const x = pad.l + i * slot + slot * 0.18;
      el("rect", { x, y: height - pad.b - barH, width: slot * 0.64, height: Math.max(barH, d.requests ? 1 : 0), rx: 3, class: "ops-bar" });
      if (trend.length <= 14 || i % Math.ceil(trend.length / 10) === 0) el("text", { x: x + (slot * 0.64) / 2, y: height - 8, class: "ops-axis-label", "text-anchor": "middle" }, d.date.slice(5));
      if (d.requests) el("text", { x: x + (slot * 0.64) / 2, y: height - pad.b - barH - 4, class: "ops-axis-label", "text-anchor": "middle" }, fmt.compact(d.requests));
    });
    return svg;
  }

  function providerBars(list) {
    const top = list.slice(0, 10);
    const max = Math.max(...top.map((p) => p.requests), 1);
    return h("ul", { class: "ops-bars" }, top.map((p) => {
      const fill = h("span", { class: "ops-barfill" });
      fill.style.inlineSize = `${Math.max((p.requests / max) * 100, 1)}%`;
      return h("li", null, h("span", { class: "ops-bar-name" }, p.provider), h("span", { class: "ops-bartrack" }, fill),
        h("span", { class: "ops-bar-num" }, fmt.num(p.requests)), h("span", { class: `ops-bar-rate ${p.successRatePct != null && p.successRatePct < 70 ? "ops-bad-text" : ""}` }, p.successRatePct != null ? fmt.pct(p.successRatePct) : "—"));
    }));
  }

  function analyticsSection(usage) {
    if (!usage) return null;
    if (usage.connection && usage.connection.state !== "connected") return null;
    const a = usage.analytics;
    const actions = h("div", { class: "ops-seggroup", role: "group", "aria-label": tr("النطاق الزمني", "Time range") }, RANGES.map((r) => h("button", {
      type: "button", class: "ops-seg", "aria-pressed": r === range ? "true" : "false",
      onclick: () => { range = r; store.write(RANGE_KEY, r); api.usage(r); render(); }
    }, r === "all" ? tr("الكل", "All") : r)));
    if (!a) return subsection(tr("تحليلات الاستخدام", "Usage analytics"), null, actions, notice("warn", tr("تحليلات غير متاحة", "Analytics unavailable"), usage.analyticsError?.message || usage.analyticsError?.code || ""));
    const s = a.summary;
    return subsection(tr("تحليلات الاستخدام", "Usage analytics"),
      tr("مرصود من سجل الراوتر نفسه. التكلفة تقدير من جدول أسعار الراوتر وليست فاتورة مزوّد.", "Observed from the router's own log. Cost is the router's price-table estimate, not a provider invoice."),
      actions,
      h("div", { class: "ops-tiles" },
        tile(tr("الطلبات", "Requests"), fmt.num(s.requests), `${fmt.num(s.successfulRequests)} ✓ · ${fmt.num(s.failedRequests)} ✕`, "router-observed"),
        tile(tr("نسبة النجاح", "Success rate"), fmt.pct(s.successRatePct, 1), s.successRatePct != null && s.successRatePct < 70 ? tr("نسبة فشل مرتفعة تستحق المراجعة", "High failure share worth reviewing") : null, "router-observed"),
        tile(tr("توكنز الإدخال", "Input tokens"), fmt.compact(s.promptTokens), fmt.num(s.promptTokens), "router-observed"),
        tile(tr("توكنز الإخراج", "Output tokens"), fmt.compact(s.completionTokens), fmt.num(s.completionTokens), "router-observed"),
        tile(tr("متوسط التأخير", "Avg latency"), fmt.ms(s.avgLatencyMs), null, "router-observed"),
        tile(tr("التكلفة التقديرية", "Estimated cost"), fmt.usd(s.estimatedCostUsd), tr("بأسعار القائمة — ليست فاتورة", "At list price — not billed"), "estimated"),
        tile(tr("تحويلات Fallback", "Fallbacks"), fmt.num(s.fallbackCount), s.fallbackRatePct != null ? fmt.pct(s.fallbackRatePct, 2) : null, "router-observed")),
      usage.live ? h("p", { class: "ops-dim" }, `${tr("لحظي", "Live")}: ${fmt.num(usage.live.inFlightRequests)} ${tr("طلب قيد التنفيذ", "in-flight")} · ${fmt.num(usage.live.requestsLast10Minutes)} ${tr("طلب آخر 10 دقائق", "requests in the last 10 min")}` ) : null,
      h("div", { class: "ops-two" },
        h("div", null, h("h4", null, tr("الطلبات يوميًا", "Requests per day")), dailyChart(a.dailyTrend)),
        h("div", null, h("h4", null, tr("الطلبات حسب المزوّد", "Requests by provider")), h("p", { class: "ops-dim ops-legend" }, tr("العدد · نسبة النجاح", "count · success rate")), providerBars(a.byProvider))),
      h("h4", null, tr("أكثر النماذج استخدامًا", "Top models")),
      h("div", { class: "ops-tablewrap", tabindex: "0", role: "region", "aria-label": tr("جدول النماذج", "Models table") },
        h("table", { class: "ops-table" },
          h("thead", null, h("tr", null, [tr("النموذج", "Model"), tr("المزوّد", "Provider"), tr("الطلبات", "Requests"), "In", "Out", tr("النجاح", "Success"), tr("التأخير", "Latency"), tr("تقدير $", "Est. $"), tr("آخر استخدام", "Last used")].map((c) => h("th", { scope: "col" }, c)))),
          h("tbody", null, a.byModel.slice(0, 15).map((m) => h("tr", null, h("th", { scope: "row" }, m.model), h("td", null, m.provider), h("td", null, fmt.num(m.requests)), h("td", null, fmt.compact(m.promptTokens)), h("td", null, fmt.compact(m.completionTokens)),
            h("td", { class: m.successRatePct != null && m.successRatePct < 70 ? "ops-bad-text" : "" }, fmt.pct(m.successRatePct)), h("td", null, fmt.ms(m.avgLatencyMs)), h("td", null, fmt.usd(m.estimatedCostUsd)), h("td", null, fmt.relative(m.lastUsedAt))))))),
      h("div", { class: "ops-two" },
        h("div", null, h("h4", null, tr("آخر النماذج المستخدمة", "Recent model selections")),
          a.recentModels.length ? h("ul", { class: "ops-list" }, a.recentModels.map((m) => h("li", null, h("strong", null, m.model), h("span", { class: "ops-dim" }, `${m.provider} · ${fmt.relative(m.lastUsedAt)}`)))) : h("p", { class: "ops-dim" }, tr("لا بيانات.", "No data."))),
        h("div", null, h("h4", null, tr("عينة آخر 100 نداء للراوتر", "Latest 100 router calls (sample)")), logSample(usage.logs))));
  }

  function logSample(logs) {
    if (!logs) return h("p", { class: "ops-dim" }, tr("سجل النداءات غير متاح.", "Call log unavailable."));
    const s = logs.sample;
    return h("div", null,
      h("ul", { class: "ops-list" },
        h("li", null, h("strong", null, fmt.num(s.routerProbes)), h("span", { class: "ops-dim" }, tr("اختبارات اتصال يجريها الراوتر نفسه (ليست عملًا فعليًا)", "connection tests run by the router itself (not real work)"))),
        h("li", null, h("strong", null, fmt.num(s.workloadRequests)), h("span", { class: "ops-dim" }, tr("طلبات عمل فعلية في العينة", "real workload requests in the sample"))),
        h("li", null, h("strong", null, fmt.num(s.rateLimited)), h("span", { class: "ops-dim" }, tr("أحداث 429 (Rate limit) في العينة", "HTTP 429 rate-limit events in the sample"))),
        h("li", null, h("strong", null, fmt.num(s.probeFailures + s.failures)), h("span", { class: "ops-dim" }, tr("نداءات فاشلة في العينة", "failed calls in the sample")))),
      h("p", { class: "ops-dim" }, tr("العينة آخر 100 سجل فقط؛ لا تمثل الفترة المختارة كلها.", "Only the latest 100 records; it does not represent the whole selected range.")));
  }

  // ---------------------------------------------------------------- manual reconciliation
  function manualSection(overview) {
    const entries = store.read(MANUAL_KEY, []);
    const options = [];
    for (const conn of overview?.connections || []) {
      if (!CODING_AGENTS[conn.provider] && conn.provider !== "agy") continue;
      for (const win of conn.quota?.windows || []) options.push({ id: `${conn.shortId}|${win.id}`, label: `${CODING_AGENTS[conn.provider] || conn.provider} · ${conn.shortId} · ${win.label}`, win });
    }
    const select = h("select", { id: "opsManualWindow", class: "ops-input", "aria-label": tr("النافذة", "Window") }, options.map((o) => h("option", { value: o.id }, o.label)));
    const input = h("input", { id: "opsManualValue", class: "ops-input", type: "number", min: "0", max: "100", step: "0.1", inputmode: "decimal", placeholder: tr("% المتبقي كما تراه", "% remaining as you see it"), "aria-label": tr("النسبة المتبقية", "Remaining percent") });
    const save = h("button", {
      type: "button", class: "btn btn-outline", onclick: () => {
        const value = Number(input.value);
        const opt = options.find((o) => o.id === select.value);
        if (!opt || input.value === "" || !Number.isFinite(value) || value < 0 || value > 100) { input.setAttribute("aria-invalid", "true"); return; }
        input.removeAttribute("aria-invalid");
        store.write(MANUAL_KEY, [{ id: `${Date.now()}`, key: opt.id, label: opt.label, remainingPct: value, at: new Date().toISOString() }, ...entries].slice(0, 30));
        input.value = "";
        render();
      }
    }, tr("حفظ على هذا الجهاز", "Save on this device"));
    const rows = entries.map((entry) => {
      const opt = options.find((o) => o.id === entry.key);
      const reported = opt?.win.remainingPct;
      const delta = reported != null ? entry.remainingPct - reported : null;
      return h("li", null, h("strong", null, entry.label), source("manual"),
        h("span", null, `${fmt.pct(entry.remainingPct, 1)} · ${fmt.when(entry.at)}`),
        reported != null ? h("span", { class: Math.abs(delta) > 5 ? "ops-bad-text" : "ops-dim" }, `${tr("مقابل المُبلَّغ الآن", "vs. provider-reported now")} ${fmt.pct(reported, 1)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`) : h("span", { class: "ops-dim" }, tr("لا رقم مُبلَّغ للمقارنة", "no reported value to compare")),
        h("button", { type: "button", class: "ops-link", onclick: () => { store.write(MANUAL_KEY, entries.filter((e) => e.id !== entry.id)); render(); } }, tr("حذف", "Delete")));
    });
    return subsection(tr("مطابقة يدوية للحصص", "Manual quota reconciliation"),
      tr("لا توجد واجهة آلية مدعومة لقراءة /status في Codex أو /usage في Antigravity، ولا نقرأ ملفات الاعتماد أو نسحب صفحات محمية. افتح الأداة، اقرأ الرقم، وسجّله هنا للمقارنة.", "There is no supported machine-readable interface for Codex /status or Antigravity /usage, and ABUD does not read credential files or scrape protected pages. Open the tool, read the figure, and record it here to compare."),
      options.length ? h("div", { class: "ops-form" }, select, input, save) : h("p", { class: "ops-dim" }, tr("لا توجد نوافذ حصص مُبلَّغة لـ Codex/Antigravity الآن.", "No provider-reported Codex/Antigravity windows are available right now.")),
      rows.length ? h("ul", { class: "ops-list ops-manual" }, rows) : null);
  }

  // ---------------------------------------------------------------- routing policy (advisory)
  function policySection(policy) {
    const res = O.peek("policy");
    if (!policy) return res?.state === "error" ? notice("bad", tr("تعذر تحميل السياسة", "Policy unavailable"), res.error) : null;
    const chipFor = (state) => badge({ available: "ok", exhausted: "bad", "locked-out": "bad", unknown: "muted" }[state] || "muted", { available: tr("متاح", "available"), exhausted: tr("نفد", "exhausted"), "locked-out": tr("مقفول", "locked out"), unknown: tr("غير معروف", "unknown") }[state] || state);
    const stepList = (steps) => h("ol", { class: "ops-steps" }, steps.map((s) => h("li", null, h("code", null, s.ref), chipFor(s.state), h("span", { class: "ops-dim" }, s.reason))));
    return subsection(tr("سياسة التوجيه والحصص (استشارية)", "Routing & quota policy (advisory)"),
      tr("تُقيَّم السياسة ضد حالة الراوتر الحية فقط. لم يُجرَ أي تعديل على OmniRoute؛ تطبيق التغييرات يحتاج موافقة منفصلة.", "The policy is evaluated against live router state only. Nothing was changed in OmniRoute; applying changes needs a separate approval."),
      h("div", { class: "ops-extras" }, chip(`${tr("المصدر", "Source")}: ${policy.policy.source}`), policy.policy.valid ? badge("ok", tr("صالحة", "Valid")) : badge("bad", tr("مرفوضة", "Rejected")), badge("info", tr("لم يُطبَّق على الراوتر", "Not applied to router"))),
      policy.findings.length ? h("ul", { class: "ops-alerts" }, policy.findings.map((f) => h("li", { class: `ops-alert ops-alert-${f.level}` }, badge(f.level === "critical" ? "bad" : f.level === "warning" ? "warn" : "info", f.level), h("span", null, f.message)))) : h("p", { class: "ops-dim" }, tr("لا ملاحظات.", "No findings.")),
      policy.groups.length ? h("div", null, h("h4", null, tr("مجموعات الأولوية", "Priority groups")), policy.groups.map((g) => h("div", { class: "ops-subblock" }, h("strong", null, g.id), h("span", { class: "ops-dim" }, ` ${g.purpose || ""}`), stepList(g.models)))) : null,
      policy.chains.length ? h("div", null, h("h4", null, tr("سلاسل Fallback", "Fallback chains")), policy.chains.map((c) => h("div", { class: "ops-subblock" }, h("strong", null, c.id), chip(`${tr("يتطلب", "requires")}: ${c.requires}`), h("span", { class: "ops-dim" }, c.firstUsable ? ` ${tr("أول خطوة قابلة للاستخدام", "first usable step")}: ${c.firstUsable}` : ` ${tr("لا خطوة متاحة", "no usable step")}`), stepList(c.steps)))) : h("p", { class: "ops-dim" }, tr("لا توجد سلاسل Fallback معرّفة في local/routing-policy.json.", "No fallback chains are defined in local/routing-policy.json.")),
      policy.combos.length ? h("details", { class: "ops-details" }, h("summary", null, `${tr("Combos الموجودة في الراوتر", "Combos configured in the router")} (${policy.combos.length})`),
        policy.combos.map((c) => h("div", { class: "ops-subblock" }, h("strong", null, c.name), chip(c.strategy), stepList(c.steps)))) : null);
  }

  // ---------------------------------------------------------------- render
  function render() {
    const overviewRes = O.peek("overview");
    const usageRes = O.peek(`usage:${range}`);
    const overview = overviewRes?.data;
    const usage = usageRes?.data;
    const policy = O.peek("policy")?.data;
    const loading = overviewRes?.state === "loading" || usageRes?.state === "loading";
    O.fill(head,
      h("p", { class: "ops-dim" }, tr("بيانات حية من OmniRoute عبر الـ Bridge (قراءة فقط).", "Live OmniRoute data via the bridge (read-only).")),
      h("div", { class: "ops-actions" }, overview?.generatedAt ? h("span", { class: "ops-stamp" }, `${tr("آخر تحديث", "Updated")}: ${fmt.when(overview.generatedAt)}`) : null,
        h("button", { type: "button", class: "btn btn-secondary", id: "opsUsageRefresh", disabled: loading ? "" : null, onclick: () => { api.overview(true); api.usage(range, true); api.policy(true); } }, O.icon("refresh", 18), tr("تحديث", "Refresh"))));
    const stale = overviewRes?.state === "stale" ? notice("warn", tr("بيانات قديمة", "Showing stale data"), tr("فشل التحديث الأخير؛ تُعرض آخر بيانات ناجحة.", "The last refresh failed; the last successful data is shown.")) : null;
    O.fill(body,
      O.resourceStatus(overviewRes, tr("بيانات الراوتر", "Router data")),
      connectionBanner(overview),
      stale,
      forTab("quotas",
        h("div", { class: "ops-legend-row", "aria-label": tr("أنواع المصادر", "Data source kinds") }, h("span", { class: "ops-dim" }, "مصدر كل رقم:"), source("provider-reported"), source("router-observed"), source("estimated"), source("manual"), source("unknown")),
        alertsSection(overview), quotaSection(overview), manualSection(overview)),
      forTab("usage", analyticsSection(usage)),
      forTab("providers", providersTable(overview), policySection(policy)));
  }

  /** Providers & models: one compact row per provider (connections, quota support, router health) — no quota summing. */
  function providersTable(overview) {
    if (!overview?.connections?.length) return null;
    const byProvider = new Map();
    for (const conn of overview.connections) byProvider.set(conn.provider, [...(byProvider.get(conn.provider) || []), conn]);
    const support = { reported: ["accent", "مُبلَّغة"], "not-exposed": ["muted", "غير مكشوفة"], "no-windows": ["muted", "بلا نوافذ"], error: ["bad", "خطأ"], "rate-limited": ["warn", "مؤجلة"] };
    return subsection("المزوّدون والاتصالات", "كل حساب يُعرض منفصلًا؛ لا تُجمع حصص الحسابات أو المزوّدين في رقم واحد.",
      h("div", { class: "ops-tablewrap", tabindex: "0", role: "region", "aria-label": "جدول المزوّدين" }, h("table", { class: "ops-table" },
        h("thead", null, h("tr", null, ["المزوّد", "الاتصالات", "نشط", "الحصة", "أسوأ حالة", "صحة 24 ساعة"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", null, [...byProvider].sort((a, b) => a[0].localeCompare(b[0])).map(([provider, conns]) => {
          const worst = conns.map((c) => c.quota?.state || "unknown").reduce((a, b) => (O.stateRank[b] > O.stateRank[a] ? b : a), "unknown");
          const health = conns.map((c) => c.health24h?.state).filter(Boolean);
          const sup = conns.find((c) => c.quota?.support === "reported") ? "reported" : conns[0]?.quota?.support;
          return h("tr", { "data-provider": provider },
            h("th", { scope: "row" }, O.bdi(provider)), h("td", null, String(conns.length)), h("td", null, String(conns.filter((c) => c.active).length)),
            h("td", null, badge(...(support[sup] || ["muted", "غير معروف"]))), h("td", null, badge(stateTone(worst), stateLabel(worst))),
            h("td", null, health.length ? health.map((x, i) => [i ? " " : "", badge(x === "healthy" ? "ok" : "warn", x === "healthy" ? "سليم" : x)]) : h("span", { class: "ops-dim" }, "—")));
        })))),
      overview.lockouts?.length ? h("p", { class: "ops-dim" }, `${overview.lockouts.length} قفل مؤقت نشط — التفاصيل في «الحصص».`) : null);
  }

  window.addEventListener("abud:view", (event) => { if (event.detail.id === "resources") { api.overview(); api.usage(range); api.policy(); } });
  on("overview", () => { render(); O.refreshNav(); });
  on("policy", render);
  RANGES.forEach((r) => on(`usage:${r}`, () => { if (r === range) render(); }));
  window.addEventListener("abud:language", render);
  render();
})();
