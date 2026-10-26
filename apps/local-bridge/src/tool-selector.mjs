/* Pure advisory discovery. No DB, network, model, handler invocation or grant expansion. */
import { TOOLS, validateToolInput } from "./catalog.mjs";

export function normalizeToolText(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ") : "";
}

/**
 * Inputs are explicit snapshots: registry profile, request text, known context inputs,
 * per-tool inputs and availability map ({ toolId: boolean | { available, reason } }).
 * Missing availability fails closed. Approval-required candidates remain proposals only.
 * Returns selected tools with tier, score, Arabic reasons and validated inputs, plus rejections and intentAr.
 */
export function selectTools({ agent, grants = [], request = "", projectId, availability = {}, maxTools = 4, context = {}, inputs = {}, catalog = TOOLS } = {}) {
  context = { ...context, ...(projectId ? { projectId } : {}) };
  const normalizedRequest = normalizeToolText(request);
  const negatedOrExample = /(?:\b(?:not|never|dont|explain|example|quote)\b|لا\s|متعملش|مش عايز|مثال|اشرح)/u.test(normalizedRequest) || /["“”«»]/u.test(request);
  if (!inputs["tasks.create"] && !negatedOrExample && /^(?:(?:please|من فضلك)\s+)?(?:create\s+(?:a\s+)?task|(?:انش[اء]+|اعمل|ضيف)\s+مهمه)(?:\s|$)/u.test(normalizedRequest)) {
    inputs = { ...inputs, "tasks.create": { title: request.trim().slice(0, 160) } };
  }
  const selected = [], rejected = [];
  const text = normalizeToolText(request);
  const tokens = new Set(text.split(" ").filter(Boolean));
  const allowed = new Set(Array.isArray(grants) ? grants : []);
  const inactive = !agent || agent.active === false || agent.enabled === false ||
    (agent.availability != null && agent.availability !== "active");
  for (const tool of catalog) {
    const reject = (reason, extra = {}) => rejected.push({ toolId: tool.id, reason, ...extra });
    if (inactive) { reject("agent-unavailable"); continue; }
    if (!allowed.has(tool.id)) { reject("not-granted"); continue; }
    const state = Object.hasOwn(availability, tool.id) ? availability[tool.id] : null;
    if (state !== true && state?.available !== true) { reject("unavailable"); continue; }
    const phrases = [tool.id, tool.ar, ...(tool.intents || [])].map(normalizeToolText);
    const matched = [...new Set(phrases.flatMap(phrase => phrase.split(" ")).filter(token => tokens.has(token)))];
    const exact = phrases.some(phrase => phrase && new RegExp(`(?:^| )(?:و)?${phrase}(?: |$)`, "u").test(text));
    // Role boosts may rank relevant tools, but can never manufacture intent relevance.
    const intentScore = matched.length + (exact ? 10 : 0);
    if (intentScore < 2) { reject("no-match"); continue; }
    const domain = agent.policyDomain || agent.domain || "";
    const categoryDomains = { orchestration: "general", company: "general", administration: "admin", telemetry: "analysis", routing: "analysis", infrastructure: "architecture" };
    const categoryScore = (tool.categories || []).some(category => category === domain || categoryDomains[category] === domain) ? 2 : 0;
    const specializationText = normalizeToolText([...(agent.specializations || agent.specializationsAr || []), agent.roleAr || ""].join(" "));
    const specializationTokens = new Set(specializationText.split(" ").filter(Boolean));
    const specializationScore = Math.min(2, matched.filter(token => specializationTokens.has(token)).length);
    const score = intentScore + categoryScore + specializationScore;
    // Only declared keys may flow from shared context; explicit inputs retain unknown keys
    // so schema validation rejects them rather than silently discarding user arguments.
    const input = {};
    for (const key of Object.keys(tool.input)) if (Object.hasOwn(context, key)) input[key] = context[key];
    if (tool.id === "knowledge.search" && request.trim()) input.q = request.trim().slice(0, 300);
    Object.assign(input, inputs[tool.id] || {});
    const missing = Object.entries(tool.input).filter(([key, rule]) => rule.required &&
      (input[key] == null || (typeof input[key] === "string" && !input[key].trim()))).map(([key]) => key);
    if (missing.length) { reject("missing-input", { missing }); continue; }
    const validated = validateToolInput(tool, input);
    if (!validated.ok) { reject("invalid-inputs", { errors: validated.errors }); continue; }
    selected.push({ toolId: tool.id, input: validated.value, score, reasons: matched, tier: tool.tier,
      reasonAr: `تطابق الطلب مع أداة «${tool.ar}» ضمن الصلاحيات المتاحة.`,
      requiresApproval: tool.approval !== "none" || tool.tier === "C" });
  }
  selected.sort((a, b) => b.score - a.score || (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
  const count = Number.isInteger(maxTools) ? Math.max(0, Math.min(maxTools, 20)) : 4;
  for (const item of selected.splice(count)) rejected.push({ toolId: item.toolId, reason: "limit" });
  return { intentAr: selected.length ? "اكتشاف أدوات مناسبة للطلب ضمن صلاحيات الوكيل" : "لا توجد أداة متاحة تستوفي الطلب والمدخلات", selected, rejected };
}
