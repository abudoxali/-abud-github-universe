/* NEX — explainable AI-resource recommendations plus the bounded operations loop (quota snapshots, retention,
 * notifications). Recommendations are derived only from observed data; every one states its evidence, confidence, risk
 * and whether owner approval is needed. Nothing here changes the router. */
import { modelClass } from "./catalog.mjs";
import { selectRoute } from "./runtime.mjs";

/** category: critical | warning | optimization | info — drives grouping in the NEX view; defaults to the level. */
const rec = (fields) => ({ approvalRequired: false, action: null, category: fields.category || fields.level, ...fields });

/** Pure: builds recommendations from already-normalized inputs. */
export function recommend({ overview, usage, policies = [], budgets = [], agentConfigs = [], quotaMeta = null, snapshotMinutes = 15, appUsage = null, subscriptionOptIn = false, now = Date.now() }) {
  const out = [];
  const routerUp = overview?.connection?.state === "connected";
  if (!routerUp) {
    out.push(rec({ id: "router-offline", level: "critical", titleAr: "OmniRoute غير متصل", situationAr: `حالة الاتصال: ${overview?.connection?.state ?? "غير معروفة"}.`, evidence: [{ kind: "router-observed", text: "GET /api/health" }],
      actionAr: "تحقق من تشغيل OmniRoute ومن مفتاح OMNIROUTE_API_KEY في بيئة الـ Bridge.", benefitAr: "استعادة التوجيه والحصص.", confidence: "high", riskAr: "لا شيء." }));
    return out;
  }
  // 1. exhausted / low provider-reported windows — grouped per provider and condition. One depleted provider is one
  //    recommendation (every account/window stays listed in the evidence), and normal quota depletion is a warning that
  //    the routing policy already handles, not a company-critical incident. A domain with no eligible model is critical (6).
  const groups = new Map();
  for (const conn of overview.connections.filter((c) => c.active && c.quota?.support === "reported")) {
    for (const win of conn.quota.windows) {
      const condition = win.state === "exhausted" ? "exhausted" : win.state === "critical" || win.state === "low" ? "low" : null;
      if (!condition) continue;
      const key = `${condition}:${conn.provider}`;
      const group = groups.get(key) || { condition, provider: conn.provider, accounts: new Set(), items: [] };
      group.accounts.add(conn.shortId);
      group.items.push({ conn, win });
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const restricted = modelClass(`${group.provider}/x`) === "restricted";
    const resets = group.items.map(({ win }) => win.resetAt).filter(Boolean).sort();
    const accounts = group.accounts.size > 1 ? ` في ${group.accounts.size} حسابات` : "";
    const evidence = group.items.slice(0, 8).map(({ conn, win }) => ({ kind: "provider-reported", text: `${conn.provider} ${conn.shortId}: ${win.label} = ${win.remainingPct ?? 0}%${win.resetAt ? ` · reset ${win.resetAt}` : ""}` }));
    if (group.condition === "exhausted") {
      out.push(rec({ id: `exhausted:${group.provider}`, level: restricted ? "info" : "warning", category: restricted ? "info" : "warning", titleAr: `حصة نافدة لدى ${group.provider} (${group.items.length} ${group.items.length === 1 ? "نافذة" : "نوافذ"}${accounts})`,
        situationAr: `${group.items.map(({ win }) => win.label).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).join("، ")}${resets.length ? `. أقرب إعادة ضبط ${resets[0]}` : ""}.`, evidence,
        actionAr: restricted ? "هذا المزوّد مستبعد من وكلاء الشركة أصلًا؛ لا إجراء على الوكلاء. راجع combos الراوتر التي تعتمد عليه." : "سياسات الشركة تتجاوز هذا المزوّد تلقائيًا حتى إعادة الضبط. أجّل المهام غير العاجلة التي تحتاجه.",
        benefitAr: "تجنب طلبات فاشلة وإعادة محاولات مستهلكة.", confidence: "high", riskAr: "منخفض: استنفاد الحصة جزء طبيعي من دورة الاستخدام." }));
    } else {
      out.push(rec({ id: `low:${group.provider}`, level: "warning", category: "warning", titleAr: `حصة منخفضة لدى ${group.provider} (${group.items.length} ${group.items.length === 1 ? "نافذة" : "نوافذ"}${accounts})`,
        situationAr: group.items.slice(0, 4).map(({ win }) => `${win.label}: ${win.remainingPct}%`).join("، ") + (resets.length ? `. أقرب إعادة ضبط ${resets[0]}` : ""), evidence,
        actionAr: "احتفظ بالسعة المتبقية للمهام عالية الأولوية؛ حماية الحصة في سياسات التوجيه تمنع المهام العادية من استهلاكها.", benefitAr: "إبقاء سعة للمهام الحرجة حتى إعادة الضبط.", confidence: "high", riskAr: "قد تتأخر مهام منخفضة الأولوية." }));
    }
  }
  // 2. reset opportunities: windows resetting within 2h that are currently exhausted/low
  const soon = overview.connections.flatMap((c) => (c.quota?.windows || []).filter((w) => w.resetAt && ["exhausted", "critical", "low"].includes(w.state) && Date.parse(w.resetAt) - now < 2 * 3_600_000 && Date.parse(w.resetAt) > now).map((w) => ({ c, w })));
  if (soon.length) out.push(rec({ id: "reset-soon", level: "info", titleAr: "إعادة ضبط قريبة لحصص", situationAr: soon.map(({ c, w }) => `${c.provider} ${w.label}`).join("، "),
    evidence: soon.map(({ c, w }) => ({ kind: "provider-reported", text: `${c.provider}: ${w.label} resets ${w.resetAt}` })), actionAr: "جدولة المهام غير العاجلة بعد موعد إعادة الضبط.", benefitAr: "الاستفادة من نافذة جديدة بدل مزوّد بديل.", confidence: "high", riskAr: "لا شيء." }));
  // 3. router retry above policy
  const retry = overview.routingSettings?.requestRetry;
  const maxPolicyRetry = policies.length ? Math.max(...policies.map((p) => p.maxRetries)) : 2;
  if (Number.isFinite(retry) && retry > Math.max(maxPolicyRetry, 2)) {
    out.push(rec({ id: "router-retry", level: "warning", category: "optimization", titleAr: `إعادة المحاولة في الراوتر = ${retry}`, situationAr: `الراوتر يعيد المحاولة ${retry} مرات لكل طلب فاشل، وأعلى سياسة في الشركة تسمح بـ ${Math.max(maxPolicyRetry, 2)}.`,
      evidence: [{ kind: "router-observed", text: "GET /api/settings requestRetry" }], actionAr: `اقتراح خفض requestRetry إلى ${Math.max(maxPolicyRetry, 2)} عبر مسار الموافقة.`, benefitAr: "تقليل الاستهلاك على المزوّدين الفاشلين.", confidence: "medium",
      riskAr: "يؤثر على كل الطلبات المارة بالراوتر (ومنها أدوات أخرى خارج الشركة).", approvalRequired: true, action: { type: "router.settings", key: "requestRetry", value: Math.max(maxPolicyRetry, 2) } }));
  }
  // 4. failing providers (router-observed analytics)
  for (const p of usage?.analytics?.byProvider ?? []) {
    if (p.requests >= 20 && Number.isFinite(p.successRatePct) && p.successRatePct < 70) {
      out.push(rec({ id: `failing:${p.provider}`, level: "warning", titleAr: `مزوّد بنسبة نجاح منخفضة: ${p.provider}`, situationAr: `${p.successRatePct}% نجاح من ${p.requests} طلب (${usage.range}).`,
        evidence: [{ kind: "router-observed", text: `GET /api/usage/analytics?range=${usage.range}` }], actionAr: "راجع اتصال هذا المزوّد في لوحة OmniRoute (المصادقة، الحصة، الحظر) قبل الاعتماد عليه.", benefitAr: "خفض الطلبات الفاشلة والتأخير.", confidence: "medium", riskAr: "قد تشمل الأرقام اختبارات اتصال الراوتر نفسه." }));
    }
  }
  // 5. cost concentration (router estimate)
  const models = usage?.analytics?.byModel ?? [];
  const totalCost = models.reduce((sum, m) => sum + (m.estimatedCostUsd || 0), 0);
  const top = models.filter((m) => !m.routerProbe).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)[0];
  if (top && totalCost > 1 && top.estimatedCostUsd / totalCost > 0.5) {
    out.push(rec({ id: `cost:${top.model}`, level: "info", category: "optimization", titleAr: `تركّز التكلفة التقديرية في ${top.model}`, situationAr: `${Math.round((top.estimatedCostUsd / totalCost) * 100)}% من التكلفة التقديرية (${usage.range}).`,
      evidence: [{ kind: "estimated", text: "router list-price estimate, not an invoice" }], actionAr: "وجّه المهام منخفضة الأولوية إلى نماذج مجانية/طبقة مجانية مؤهلة واحتفظ بهذا النموذج للمهام المعقدة.", benefitAr: "خفض التكلفة التقديرية دون المساس بالمهام الحرجة.", confidence: "low", riskAr: "التقدير قد لا يطابق الفوترة الفعلية." }));
  }
  // 6. policy domains with no eligible model right now
  for (const policy of policies) {
    const route = selectRoute({ policy, agentConfig: null, priority: "medium", overview, subscriptionOptIn });
    if (!route.chosen) {
      out.push(rec({ id: `domain-blocked:${policy.domain}`, level: "critical", titleAr: `لا نموذج مؤهل لمجال «${policy.labelAr}»`, situationAr: route.candidates.map((c) => `${c.ref}: ${c.reasons[0]?.ar ?? ""}`).join(" · "),
        evidence: [{ kind: "router-observed", text: "route evaluation against live state" }], actionAr: "أضف مرشحًا مؤهلًا إلى السياسة أو انتظر إعادة ضبط الحصة.", benefitAr: "منع توقف وكلاء هذا المجال.", confidence: "high", riskAr: "لا شيء." }));
    } else if (route.chosen !== policy.candidates[0]) {
      const first = route.candidates.find((c) => c.ref === policy.candidates[0]);
      out.push(rec({ id: `domain-fallback:${policy.domain}`, level: "info", titleAr: `مجال «${policy.labelAr}» يستخدم بديلًا الآن`, situationAr: `${policy.candidates[0]} غير مؤهل (${first?.reasons[0]?.ar ?? ""}) → ${route.chosen}.`,
        evidence: [{ kind: "router-observed", text: "route evaluation against live state" }], actionAr: "لا إجراء مطلوب؛ راجع ترتيب المرشحين إن استمر ذلك.", benefitAr: "شفافية سبب اختيار النموذج.", confidence: "high", riskAr: "لا شيء." }));
    }
  }
  // 7. compliance: restricted / subscription connections present
  const restricted = overview.connections.filter((c) => c.active && modelClass(`${c.provider}/x`) === "restricted");
  if (restricted.length) out.push(rec({ id: "restricted-providers", level: "info", titleAr: "اتصالات مستبعدة من وكلاء الشركة", situationAr: `${restricted.length} اتصال (${[...new Set(restricted.map((c) => c.provider))].join("، ")}) يعتمد على مصادقة اشتراك مستهلك.`,
    evidence: [{ kind: "router-observed", text: "GET /api/providers" }], actionAr: "تبقى مستبعدة. للاستخدام المؤسسي استخدم مفتاح Google AI Studio أو Gemini Enterprise الرسمي.", benefitAr: "الالتزام بشروط المزوّد وتجنب حظر الحساب.", confidence: "high", riskAr: "لا شيء." }));
  // 8. budgets
  for (const b of budgets.filter((x) => x.state === "warning" || x.state === "exceeded" || x.state === "unverified")) {
    const unknown = b.spent.unknownCostEvents ? ` + ${b.spent.unknownCostEvents} تشغيل بتكلفة غير معروفة` : "";
    const unverified = b.state === "unverified";
    out.push(rec({ id: `budget:${b.id}`, level: b.state === "exceeded" ? "critical" : "warning", titleAr: `ميزانية ${b.scope}${b.scopeRef ? ` (${b.scopeRef})` : ""} ${b.period}: ${b.state === "exceeded" ? "متجاوزة" : unverified ? "غير قابلة للتحقق" : "قريبة من الحد"}`,
      situationAr: `المصروف المعروف ${b.spent.costUsd.toFixed(4)}$${unknown} و${b.spent.tokens} رمز منذ ${b.periodStart}.${unverified ? ` ${b.unverifiedPaidEvents} استدلال مدفوع بلا تكلفة أو رموز من الراوتر.` : ""}`, evidence: [{ kind: "application-measured", text: "usage_events (router per-response estimate)" }],
      actionAr: unverified ? (b.hardStop ? "الاستدلال المدفوع في هذا النطاق متوقف حتى بداية الفترة التالية؛ النماذج المجانية تستمر. راجع فاتورة المزوّد قبل تعديل الميزانية." : "راجع فاتورة المزوّد؛ هذه الميزانية لا توقف الإنفاق.")
        : b.hardStop ? "التشغيلات الجديدة في هذا النطاق متوقفة حتى بداية الفترة التالية أو رفع الحد." : "راجع الحد أو أجّل المهام غير العاجلة.", benefitAr: "منع إنفاق غير متوقع.", confidence: "medium", riskAr: "قد تتوقف مهام." }));
  }
  // 9. stale quota observations
  if (quotaMeta?.at && now - Date.parse(quotaMeta.at) > snapshotMinutes * 3 * 60_000) {
    out.push(rec({ id: "quota-stale", level: "warning", titleAr: "لقطات الحصص قديمة", situationAr: `آخر لقطة مخزنة: ${quotaMeta.at}.`, evidence: [{ kind: "application-measured", text: "quota_observations" }],
      actionAr: "تأكد أن الـ Bridge يعمل وأن الراوتر متصل؛ التحديث التلقائي محدود بفاصل الإعدادات.", benefitAr: "تاريخ استهلاك موثوق.", confidence: "high", riskAr: "لا شيء." }));
  }
  // 10. agent usage concentration
  if (appUsage?.byAgent?.length) {
    const sorted = [...appUsage.byAgent].sort((a, b) => b.tokens - a.tokens);
    const total = sorted.reduce((s, a) => s + a.tokens, 0);
    if (total > 0) out.push(rec({ id: "agent-usage", level: "info", titleAr: `الأكثر استهلاكًا: ${sorted[0].agentId.toUpperCase()}`, situationAr: sorted.map((a) => `${a.agentId.toUpperCase()}: ${a.tokens} رمز / ${a.runs} تشغيل`).join(" · "),
      evidence: [{ kind: "application-measured", text: "usage_events since period start" }], actionAr: "راجع تعليمات الوكيل وحجم السياق إن كان الاستهلاك أعلى من المتوقع.", benefitAr: "توزيع أوضح للاستهلاك.", confidence: "high", riskAr: "لا شيء." }));
    if (appUsage.unknownCostEvents > 0) out.push(rec({ id: "unknown-cost", level: "info", titleAr: "تكلفة غير معروفة لبعض التشغيلات", situationAr: `${appUsage.unknownCostEvents} تشغيل بلا تقدير تكلفة من الراوتر.`, evidence: [{ kind: "application-measured", text: "usage_events.cost_usd IS NULL" }],
      actionAr: "تعامل مع هذه التشغيلات كتكلفة غير معروفة؛ لا تُحسب صفرًا.", benefitAr: "عدم التقليل من الإنفاق.", confidence: "high", riskAr: "لا شيء." }));
  }
  const rank = { critical: 0, warning: 1, optimization: 2, info: 3 };
  return out.sort((a, b) => rank[a.category] - rank[b.category]);
}

// Plain-Arabic reason for each router connection state; the technical state is kept in parentheses for diagnosis.
const ROUTER_STATE_AR = {
  offline: "لا يستجيب على عنوانه المحلي؛ شغّل OmniRoute ثم انتظر دقيقة",
  "auth-required": "رفض مفتاح API المُعدّ؛ راجع OMNIROUTE_API_KEY",
  forbidden: "رفض الطلب لعدم وجود صلاحية",
  "rate-limited": "يحدّ من الطلبات مؤقتًا",
  timeout: "لم يرد في الوقت المحدد",
  misconfigured: "عنوان الراوتر غير صالح في الإعدادات",
  error: "أعاد خطأ غير متوقع"
};

/** Bounded background loop: quota snapshots, retention, low-quota/lockout/overdue notifications. */
export function createOperations({ company, getOverview, intervalFloorMs = 5 * 60_000, now = () => new Date(), log = () => {} }) {
  let timer = null;
  let lastRun = 0;
  let lastPrune = 0;

  async function tick({ force = false } = {}) {
    const settings = company.settings();
    const interval = Math.max(intervalFloorMs, settings.quotaSnapshotMinutes * 60_000);
    if (!force && now().getTime() - lastRun < interval) return { skipped: true };
    lastRun = now().getTime();
    const overview = await getOverview(false);
    const stored = company.recordQuota(overview);
    if (overview?.connection?.state === "connected") {
      const active = new Set();
      for (const w of overview.warnings || []) {
        if (["exhausted", "critical", "low"].includes(w.level) && modelClass(`${w.provider}/x`) !== "restricted") {
          const key = `quota:${w.connectionId}:${w.window}:${w.level === "exhausted" ? "exhausted" : "low"}`;
          active.add(key);
          company.raise({ key, level: "warning", kind: "quota", title: `${w.provider}: ${w.window} ${w.level === "exhausted" ? "نفدت" : `منخفضة (${w.remainingPct}%)`}`, body: w.resetAt ? `يُعاد الضبط ${w.resetAt}` : null, targetType: "provider", targetId: w.provider });
        }
      }
      company.resolveStale("quota", active);
      company.resolveStale("router", new Set());
    } else {
      const state = overview?.connection?.state ?? "unknown";
      company.raise({ key: "router:offline", level: "critical", kind: "router", title: "OmniRoute غير متصل", body: `${ROUTER_STATE_AR[state] || "تعذر التحقق من حالة الراوتر"} (${state})`, targetType: "provider", targetId: "omniroute" });
    }
    // Overdue tasks (company timezone date).
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(now());
    const overdue = company.db.all("SELECT id, title, due_date FROM tasks WHERE archived_at IS NULL AND due_date IS NOT NULL AND due_date < ? AND status NOT IN ('done','cancelled')", today);
    const overdueKeys = new Set();
    for (const task of overdue) {
      const key = `task-overdue:${task.id}`;
      overdueKeys.add(key);
      company.raise({ key, level: "warning", kind: "task-overdue", title: `مهمة متأخرة: ${task.title}`, body: `الموعد ${task.due_date}`, targetType: "task", targetId: task.id });
    }
    company.resolveStale("task-overdue", overdueKeys);
    if (now().getTime() - lastPrune > 6 * 3_600_000) { lastPrune = now().getTime(); company.pruneQuota(settings.quotaRetentionDays); }
    return { stored, overdue: overdue.length };
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((error) => log(`operations tick failed: ${error?.message}`)), 60_000);
      timer.unref?.();
      setTimeout(() => tick({ force: true }).catch((error) => log(`initial operations tick failed: ${error?.message}`)), 1500).unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
