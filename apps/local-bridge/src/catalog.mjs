/* Fixed company definitions: the six AI employees, the tool registry, policy domains and provider billing classes.
 * Identity lives here (code, reviewed); per-agent configuration (mode, instructions, tools subset, model override) lives
 * in the company store. Arabic is the product language; ids and model references stay in English. */

export const MODES = {
  standard: { ar: "قياسي", temperature: 0.4, note: "توازن بين الجودة والسرعة والاستهلاك." },
  creative: { ar: "إبداعي", temperature: 0.9, note: "استكشاف أوسع للأفكار والبدائل." },
  analytical: { ar: "تحليلي", temperature: 0.2, note: "استدلال قائم على الأدلة مع ذكر المصدر لكل رقم." },
  research: { ar: "بحثي", temperature: 0.3, note: "تحقيق موجّه بالمصادر مع فصل الدليل عن التفسير والتخمين." },
  strict: { ar: "صارم", temperature: 0.1, note: "تحقق محافظ وضمان عالٍ؛ يرفض ما لا دليل عليه." },
  execution: { ar: "تنفيذي", temperature: 0.2, note: "إجراءات مصرّح بها فقط ضمن حدود الأدوات والموافقات." }
};

export const DOMAINS = {
  general: "مهام عامة",
  coding: "برمجة معقدة",
  architecture: "مراجعة معمارية",
  creative: "إنتاج إبداعي",
  research: "بحث",
  analysis: "تحليل",
  admin: "ملخصات إدارية",
  security: "مراجعة أمنية"
};

/** Owner-supplied artwork. `card` is a crop of the supplied team lineup; `full` and `sheet` are the supplied files
 * unchanged. NEX has no supplied standalone full-body render, so it has none here (no generated substitute). */
const ART = (id) => ({
  card: `./internal/assets/agents/${id}-card.webp`,
  full: id === "nex" ? null : `./internal/assets/agents/${id}-full.webp`,
  sheet: `./internal/assets/agents/${id}-sheet.webp`,
  lineup: "./internal/assets/agents/team-lineup.webp"
});

/** The six permanent AI employees. Responsibilities define what the agent is for; permissions are enforced separately. */
export const AGENTS = [
  {
    id: "ori", name: "ORI", color: "#ff8a1f", order: 1, art: ART("ori"),
    titleAr: "القائد", roleAr: "القيادة وتنسيق العمل",
    summaryAr: "ينسّق مهام الشركة، يوزّع العمل على المتخصصين، يرتّب الأولويات، ويكتب الملخصات التنفيذية.",
    responsibilitiesAr: ["تنسيق مهام الشركة", "اختيار المتخصص المناسب لكل طلب", "ترتيب الأولويات", "متابعة تقدّم المشاريع", "تصعيد العمل المتعطّل", "ملخصات تنفيذية للمالك"],
    boundariesAr: ["سلطة التنسيق لا تعني صلاحيات مميّزة", "لا ينفّذ إجراءات حساسة دون موافقة المالك", "لا يغيّر إعدادات المزوّدين أو الراوتر"],
    defaultMode: "standard", domain: "general",
    tools: ["project.read", "tasks.query", "tasks.create", "tasks.update", "activity.read", "quota.read"],
    capabilities: ["chat", "project_assessment"]
  },
  {
    id: "mia", name: "MIA", color: "#ff4fa3", order: 2, art: ART("mia"),
    titleAr: "المبدعة", roleAr: "الإبداع والتصميم",
    summaryAr: "تدير العمل الإبداعي: مفاهيم الواجهات وتجربة الاستخدام، ملخصات التصميم، الهوية، ونصوص المواقع والمحتوى.",
    responsibilitiesAr: ["مفاهيم UI/UX", "ملخصات التصميم البصري", "الهوية والعلامة", "أفكار المحتوى ونصوص المواقع", "مراجعة إبداعية وملاحظات تصميم"],
    boundariesAr: ["لا توليد صور مدفوع دون ميزانية وموافقة", "لا نشر لأي محتوى خارج الشركة"],
    defaultMode: "creative", domain: "creative",
    tools: ["project.read", "project.docs", "tasks.query", "tasks.create"],
    capabilities: ["chat", "creative_brief"]
  },
  {
    id: "nex", name: "NEX", color: "#2f8bff", order: 3, art: ART("nex"),
    titleAr: "المحلل", roleAr: "الذكاء التشغيلي وإدارة موارد الذكاء الاصطناعي",
    summaryAr: "يراقب OmniRoute والحصص والتكلفة، يقارن المزوّدين، ويقدّم توصيات توجيه قابلة للتفسير مع فصل القياس عن التقدير.",
    responsibilitiesAr: ["مراقبة OmniRoute", "تقييم الحصص ونوافذها", "تحليل استخدام النماذج", "مقارنة التكلفة", "توصيات التوجيه والميزانية", "توقع الاستهلاك", "تحليل عبء الوكلاء"],
    boundariesAr: ["يوصي ولا يغيّر إعدادات المزوّدين بصمت", "لا ينفق خارج الحدود المعتمدة", "يفصل القياس الفعلي عن التقدير دائمًا"],
    defaultMode: "analytical", domain: "analysis",
    tools: ["quota.read", "usage.read", "project.read", "project.docs", "git.status", "tasks.query", "activity.read"],
    capabilities: ["chat", "resource_report"]
  },
  {
    id: "luna", name: "LUNA", color: "#a35bff", order: 4, art: ART("luna"),
    titleAr: "الداعمة", roleAr: "المساعدة ودعم العمليات",
    summaryAr: "تساعد في المهام الإدارية والتذكير وتنظيم العمل وكتابة قوائم المتابعة ومحاضر الاجتماعات ومسودات المراسلات الداخلية.",
    responsibilitiesAr: ["دعم المهام الإدارية", "تنظيم المهام والتذكير", "توثيق التسليم", "محاضر الاجتماعات", "قوائم تحقق تشغيلية", "مسودات مراسلات داخلية"],
    boundariesAr: ["لا ترسل رسائل خارج الشركة", "تنشئ مهامًا داخلية فقط ضمن صلاحياتها"],
    defaultMode: "standard", domain: "admin",
    tools: ["tasks.query", "tasks.create", "tasks.update", "project.read", "project.docs", "activity.read"],
    capabilities: ["chat", "task_breakdown"]
  },
  {
    id: "zen", name: "ZEN", color: "#39d353", order: 5, art: ART("zen"),
    titleAr: "المستكشف", roleAr: "البحث والاستكشاف",
    summaryAr: "يبحث في التقنيات والأطر والأدوات ويقارن البدائل ويكتشف الفرص، مع فصل الدليل المؤكد عن التفسير والتخمين.",
    responsibilitiesAr: ["بحث تقني", "تقييم الأطر والأدوات", "اكتشاف المستودعات", "أبحاث المنتج والسوق", "توصيات التكامل"],
    boundariesAr: ["لا طلبات شبكة غير مقيدة", "يذكر المصدر أو يصرّح بغيابه"],
    defaultMode: "research", domain: "research",
    tools: ["project.read", "project.docs", "git.status"],
    capabilities: ["chat", "research_brief"]
  },
  {
    id: "rex", name: "REX", color: "#ff3b3b", order: 6, art: ART("rex"),
    titleAr: "الحارس", roleAr: "الأمن والحوكمة",
    summaryAr: "يراجع المخاطر الأمنية وتعرّض البيانات الحساسة والصلاحيات وحدود التكامل، ويدعم تطبيق سياسات الموافقة.",
    responsibilitiesAr: ["فحوص أمنية", "كشف تعرّض البيانات الحساسة", "تقييم الصلاحيات", "تحليل المخاطر", "مراجعة النشر الآمن", "الإبلاغ عن نشاط مريب"],
    boundariesAr: ["لا صلاحيات مدير مطلقة", "الأمن الفعلي يُفرض في الخادم وليس بتعليمات النموذج", "قيوده لا تُلغى بأي وضع تشغيل"],
    defaultMode: "strict", domain: "security",
    tools: ["git.status", "project.read", "project.docs", "activity.read", "security.scan"],
    capabilities: ["chat", "security_review"]
  }
];

export const AGENT_IDS = AGENTS.map((agent) => agent.id);
export const agentById = (id) => AGENTS.find((agent) => agent.id === id) || null;

/** What each capability asks the model to produce and which read-only tools are gathered first. */
export const CAPABILITIES = {
  chat: { ar: "طلب عام", gather: ["project.read"], output: "free" },
  project_assessment: { ar: "تقييم حالة مشروع (سير عمل متعدد الوكلاء)", gather: [], output: "workflow" },
  creative_brief: { ar: "ملخص إبداعي", gather: ["project.read", "project.docs"], output: "free" },
  resource_report: { ar: "تقرير موارد الذكاء الاصطناعي", gather: ["quota.read", "usage.read"], output: "free" },
  task_breakdown: { ar: "قائمة متابعة ومهام", gather: ["project.read", "tasks.query"], output: "tasks" },
  research_brief: { ar: "موجز بحثي", gather: ["project.read", "project.docs"], output: "free" },
  security_review: { ar: "مراجعة أمنية", gather: ["git.status", "security.scan"], output: "free" },
  infra_review: { ar: "مراجعة حالة السيرفرات", gather: ["vps.getHealth", "vps.getMetrics", "vps.getDeploymentInfo", "vps.getRecentEvents"], output: "tasks", infra: true },
  infra_assessment: { ar: "تقييم البنية التحتية (سير عمل متعدد الوكلاء)", gather: [], output: "workflow", infra: true }
};

/** Tool registry. Handlers are bound in runtime.mjs; this is the reviewed contract shown in the UI. */
export const TOOLS = [
  { id: "project.read", ar: "قراءة بيانات المشروع", description: "Company project record, checkouts, open tasks and milestones.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 60,
    input: { projectId: { type: "string", max: 120, required: true } } },
  { id: "project.docs", ar: "قراءة مستندات المشروع المعتمدة", description: "Bounded, redacted excerpt of STATUS.md or README from an authorized checkout.", readOnly: true, approval: "none", timeoutMs: 4000, ratePerMin: 30,
    input: { projectId: { type: "string", max: 120, required: true }, doc: { type: "enum", values: ["STATUS.md", "README.md"], required: false } } },
  { id: "git.status", ar: "حالة Git المنقّحة", description: "Sanitized branch, head, working-tree and ahead/behind state of the project's checkouts.", readOnly: true, approval: "none", timeoutMs: 12000, ratePerMin: 20,
    input: { projectId: { type: "string", max: 120, required: true } } },
  { id: "tasks.query", ar: "استعلام المهام", description: "Open tasks filtered by project and/or assignee.", readOnly: true, approval: "none", timeoutMs: 2000, ratePerMin: 60,
    input: { projectId: { type: "string", max: 120, required: false }, assignee: { type: "string", max: 10, required: false } } },
  { id: "tasks.create", ar: "إنشاء مهمة داخلية", description: "Creates an internal company task (never external).", readOnly: false, approval: "none", timeoutMs: 2000, ratePerMin: 20,
    input: { title: { type: "string", max: 160, required: true }, projectId: { type: "string", max: 120, required: false }, priority: { type: "enum", values: ["high", "medium", "low"], required: false }, assignee: { type: "string", max: 10, required: false } } },
  { id: "tasks.update", ar: "تحديث حالة مهمة", description: "Changes the status of an internal task.", readOnly: false, approval: "none", timeoutMs: 2000, ratePerMin: 20,
    input: { taskId: { type: "string", max: 60, required: true }, status: { type: "enum", values: ["todo", "in_progress", "blocked", "review", "done"], required: true } } },
  { id: "usage.read", ar: "قراءة استهلاك OmniRoute", description: "Router-observed usage analytics summary (estimates labelled).", readOnly: true, approval: "none", timeoutMs: 15000, ratePerMin: 10, input: {} },
  { id: "quota.read", ar: "قراءة حصص المزوّدين", description: "Provider-reported quota windows relayed by OmniRoute, plus lockouts.", readOnly: true, approval: "none", timeoutMs: 15000, ratePerMin: 10, input: {} },
  { id: "activity.read", ar: "قراءة سجل النشاط", description: "Latest company activity events.", readOnly: true, approval: "none", timeoutMs: 2000, ratePerMin: 30,
    input: { projectId: { type: "string", max: 120, required: false } } },
  { id: "security.scan", ar: "فحص تعرّض البيانات", description: "Deterministic checks: secret-like strings in approved docs, missing remote, uncommitted changes, unpushed work.", readOnly: true, approval: "none", timeoutMs: 12000, ratePerMin: 10,
    input: { projectId: { type: "string", max: 120, required: true } } },
  { id: "router.settings.propose", ar: "اقتراح تعديل إعدادات الراوتر", description: "Creates an owner approval request for an OmniRoute settings change. Never applies directly.", readOnly: false, approval: "always", timeoutMs: 2000, ratePerMin: 5,
    input: { key: { type: "enum", values: ["requestRetry", "maxRetryIntervalSec", "comboStrategy"], required: true } } },
  // VPS Operations Center. Tier 0 (observation) and Tier 1 (allowlisted diagnostics, proposals). No tool executes a write
  // on a server; proposals wait for the owner's approval of the exact action in the Company OS. hostId is optional when
  // exactly one host is registered (or the run's project is linked to one).
  { id: "vps.listHosts", ar: "قائمة الخوادم المسجلة", description: "Registered VPS hosts with connection state and data age.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 30, tier: 0, input: {} },
  { id: "vps.getHealth", ar: "صحة الخادم الآن", description: "Fresh (≤2 min) sanitized health: resources, services, public checks, open incidents.", readOnly: true, approval: "none", timeoutMs: 35000, ratePerMin: 10, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false } } },
  { id: "vps.getMetrics", ar: "مقاييس الخادم التاريخية", description: "Measured CPU/memory/disk/SSH-latency statistics and a downsampled series.", readOnly: true, approval: "none", timeoutMs: 4000, ratePerMin: 20, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false }, range: { type: "enum", values: ["1h", "24h", "7d", "30d"], required: false } } },
  { id: "vps.listServices", ar: "خدمات الخادم", description: "Last verified state of Nginx, PostgreSQL and PM2 services (stale flag when SSH failed).", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 30, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false } } },
  { id: "vps.getServiceStatus", ar: "حالة خدمة محددة", description: "One service's state, restarts, memory and recent incidents.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 30, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false }, service: { type: "string", max: 64, required: true } } },
  { id: "vps.getDeploymentInfo", ar: "معلومات النشر", description: "Current release path, deployed SHA, release inventory, rollback candidate and public health commit.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 20, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false } } },
  { id: "vps.getRecentEvents", ar: "أحداث الخادم الأخيرة", description: "Incidents (7 days), infrastructure activity, SSH failure count and pending actions.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 20, tier: 0,
    input: { hostId: { type: "string", max: 40, required: false } } },
  { id: "vps.getRedactedLogs", ar: "سجلات منقّحة", description: "Bounded tail of an allowlisted log source, redacted (credentials, tokens, emails, IPs, query strings).", readOnly: true, approval: "none", timeoutMs: 30000, ratePerMin: 6, tier: 1,
    input: { hostId: { type: "string", max: 40, required: false }, source: { type: "enum", values: ["nginx-error", "pm2-error", "system-warnings"], required: true }, service: { type: "string", max: 64, required: false } } },
  { id: "vps.runSafeDiagnostic", ar: "فحص تشخيصي آمن", description: "One allowlisted read-only diagnostic by name. Never accepts a command.", readOnly: true, approval: "none", timeoutMs: 30000, ratePerMin: 6, tier: 1,
    input: { hostId: { type: "string", max: 40, required: false }, diagnostic: { type: "enum", values: ["nginx-config-test", "failed-units", "pm2-restarts", "postgres-health", "disk-usage", "network-summary", "recent-boots"], required: true } } },
  { id: "vps.createActionProposal", ar: "اقتراح إجراء على الخادم", description: "Creates a proposal for one allowlisted operation; it runs only after the owner approves that exact action.", readOnly: false, approval: "none", timeoutMs: 3000, ratePerMin: 4, tier: 1,
    input: { hostId: { type: "string", max: 40, required: false }, operation: { type: "enum", values: ["pm2.restart", "nginx.reload", "deploy.release", "deploy.rollback", "db.migrate", "db.restore", "nginx.edit", "firewall.change", "ssh.access", "release.delete"], required: true },
      service: { type: "string", max: 64, required: false }, reason: { type: "string", max: 500, required: true } } },
  { id: "vps.getActionResult", ar: "نتيجة إجراء خادم", description: "Status, verification result and pre/post state of a proposed or executed action.", readOnly: true, approval: "none", timeoutMs: 3000, ratePerMin: 20, tier: 0,
    input: { actionId: { type: "string", max: 60, required: true } } }
];

/** Infrastructure tools per agent: every agent can observe; diagnostics, logs and proposals follow each role. */
export const VPS_READ_TOOLS = ["vps.listHosts", "vps.getHealth", "vps.getMetrics", "vps.listServices", "vps.getServiceStatus", "vps.getDeploymentInfo", "vps.getRecentEvents", "vps.getActionResult"];
export const VPS_AGENT_TOOLS = {
  ori: [...VPS_READ_TOOLS, "vps.getRedactedLogs", "vps.runSafeDiagnostic", "vps.createActionProposal"],
  nex: [...VPS_READ_TOOLS, "vps.runSafeDiagnostic", "vps.createActionProposal"],
  rex: [...VPS_READ_TOOLS, "vps.getRedactedLogs", "vps.runSafeDiagnostic", "vps.createActionProposal"],
  zen: [...VPS_READ_TOOLS, "vps.getRedactedLogs", "vps.runSafeDiagnostic"],
  luna: [...VPS_READ_TOOLS],
  mia: [...VPS_READ_TOOLS]
};
for (const agent of AGENTS) {
  agent.tools.push(...VPS_AGENT_TOOLS[agent.id]);
  agent.capabilities.push("infra_review");
  if (agent.id === "ori") agent.capabilities.push("infra_assessment");
}
export const toolById = (id) => TOOLS.find((tool) => tool.id === id) || null;

/** Validates tool input against its declared schema. Returns {ok, value|errors}. */
export function validateToolInput(tool, input) {
  const errors = [];
  const value = {};
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const key of Object.keys(source)) if (!Object.hasOwn(tool.input, key)) errors.push(`unknown field: ${key}`);
  for (const [key, rule] of Object.entries(tool.input)) {
    const raw = source[key];
    if (raw == null || raw === "") { if (rule.required) errors.push(`${key} is required`); continue; }
    if (rule.type === "string") {
      if (typeof raw !== "string" || raw.length > rule.max) errors.push(`${key} must be a string up to ${rule.max} chars`);
      else value[key] = raw.trim();
    } else if (rule.type === "enum") {
      if (!rule.values.includes(raw)) errors.push(`${key} must be one of ${rule.values.join(", ")}`);
      else value[key] = raw;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Billing/compliance class per OmniRoute provider id. Policies decide which classes a domain may use. */
export const PROVIDER_CLASSES = {
  antigravity: "restricted", agy: "restricted",
  codex: "subscription", kiro: "subscription", github: "subscription", "amazon-q": "subscription", "devin-desktop": "subscription",
  gemini: "api-free-tier", nvidia: "api-free-tier", sambanova: "api-free-tier", aihorde: "free",
  openrouter: "metered", moonshot: "metered"
};
export const CLASS_INFO = {
  free: { ar: "مجاني صريح", paid: false },
  "api-free-tier": { ar: "مفتاح API بطبقة مجانية (الفوترة غير قابلة للتحقق من هنا)", paid: false },
  subscription: { ar: "اشتراك مستهلك عبر OAuth — يحتاج تفعيلًا صريحًا من المالك", paid: false },
  metered: { ar: "مدفوع حسب الاستهلاك", paid: true },
  restricted: { ar: "مقيّد بشروط المزوّد — لا يُستخدم لوكلاء الشركة", paid: false },
  unknown: { ar: "غير معروف", paid: true }
};

/** OpenRouter ":free" variants and the router's free combos are explicit $0 routes; everything else follows its provider. */
export function modelClass(ref) {
  const provider = String(ref).split("/")[0];
  if (/:free$/.test(ref) || ref === "openrouter/free") return "free";
  return PROVIDER_CLASSES[provider] || "unknown";
}

export const DEFAULT_POLICIES = {
  general: { candidates: ["gemini/gemini-3.1-flash-lite", "openrouter/google/gemma-4-31b-it:free", "nvidia/openai/gpt-oss-120b"], maxOutputTokens: 1600 },
  coding: { candidates: ["nvidia/deepseek-ai/deepseek-v4-pro-0813", "gemini/gemini-3.8-flash", "gemini/gemini-3.1-flash-lite"], maxOutputTokens: 4000 },
  architecture: { candidates: ["gemini/gemini-3.1-pro-preview", "nvidia/deepseek-ai/deepseek-v4-pro-0813", "gemini/gemini-3.8-flash"], maxOutputTokens: 4000, quotaProtectPct: 0 },
  creative: { candidates: ["gemini/gemini-3.8-flash", "gemini/gemini-3.1-flash-lite", "openrouter/google/gemma-4-31b-it:free"], maxOutputTokens: 2400 },
  research: { candidates: ["gemini/gemini-3.8-flash", "openrouter/nvidia/nemotron-3-super-120b-a12b:free", "gemini/gemini-3.1-flash-lite"], maxOutputTokens: 2400 },
  analysis: { candidates: ["gemini/gemini-3.8-flash", "gemini/gemini-3.1-flash-lite", "nvidia/openai/gpt-oss-120b"], maxOutputTokens: 2400 },
  admin: { candidates: ["gemini/gemini-3.1-flash-lite", "openrouter/google/gemma-4-26b-a4b-it:free"], maxOutputTokens: 1600 },
  security: { candidates: ["gemini/gemini-3.8-flash", "gemini/gemini-3.1-flash-lite"], maxOutputTokens: 2400, quotaProtectPct: 0 }
};
