/* ABUD-side, non-secret quota/routing policy. It is advisory: it is validated, evaluated against the live router state,
 * and shown to the operator. It does NOT write to OmniRoute (whose persistent configuration is a SQLite store managed
 * through its own API/dashboard); applying any change to the live router needs a separate approved step. */
import { readFile } from "node:fs/promises";
import { DEFAULT_THRESHOLDS } from "./omniroute.mjs";
import { text } from "./util.mjs";

export const DEFAULT_POLICY = Object.freeze({
  version: 1,
  thresholds: { ...DEFAULT_THRESHOLDS },
  retry: { maxRetries: 2, honorRetryAfter: true },
  priorityGroups: [],
  fallbackChains: []
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_REF = /^[A-Za-z0-9._:/@+-]{1,100}$/;

export function validatePolicy(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { valid: false, errors: ["policy must be a JSON object"], policy: structuredClone(DEFAULT_POLICY) };
  if (input.version !== 1) errors.push("version must be 1");
  const warn = input.thresholds?.warnPercent ?? DEFAULT_THRESHOLDS.warnPercent;
  const critical = input.thresholds?.criticalPercent ?? DEFAULT_THRESHOLDS.criticalPercent;
  if (!Number.isFinite(warn) || !Number.isFinite(critical) || critical < 0 || warn > 100 || critical >= warn) errors.push("thresholds need 0 <= criticalPercent < warnPercent <= 100");
  const maxRetries = input.retry?.maxRetries ?? DEFAULT_POLICY.retry.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) errors.push("retry.maxRetries must be an integer 0-5");
  if (input.retry?.honorRetryAfter === false) errors.push("retry.honorRetryAfter must not be disabled: provider Retry-After responses must be respected");
  const groups = [];
  for (const [index, group] of (Array.isArray(input.priorityGroups) ? input.priorityGroups : []).slice(0, 20).entries()) {
    const models = Array.isArray(group?.models) ? group.models : [];
    if (!SLUG.test(group?.id ?? "")) errors.push(`priorityGroups[${index}].id must be a lowercase slug`);
    else if (models.length > 30 || !models.every((m) => typeof m === "string" && MODEL_REF.test(m))) errors.push(`priorityGroups[${index}].models must be up to 30 model references`);
    else groups.push({ id: group.id, purpose: text(group.purpose, 160), models: [...models] });
  }
  const chains = [];
  for (const [index, chain] of (Array.isArray(input.fallbackChains) ? input.fallbackChains : []).slice(0, 20).entries()) {
    const steps = Array.isArray(chain?.steps) ? chain.steps : [];
    const requires = ["none", "tools", "reasoning"].includes(chain?.requires) ? chain.requires : "none";
    if (!SLUG.test(chain?.id ?? "")) errors.push(`fallbackChains[${index}].id must be a lowercase slug`);
    else if (steps.length < 2 || steps.length > 12 || !steps.every((m) => typeof m === "string" && MODEL_REF.test(m))) errors.push(`fallbackChains[${index}].steps needs 2-12 model references`);
    else chains.push({ id: chain.id, purpose: text(chain.purpose, 160), steps: [...steps], requires });
  }
  if (errors.length) return { valid: false, errors, policy: structuredClone(DEFAULT_POLICY) };
  return { valid: true, errors: [], policy: { version: 1, thresholds: { warnPercent: warn, criticalPercent: critical }, retry: { maxRetries, honorRetryAfter: true }, priorityGroups: groups, fallbackChains: chains } };
}

export async function loadPolicy(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const result = validatePolicy(parsed);
    return { source: "local/routing-policy.json", ...result };
  } catch (error) {
    if (error?.code === "ENOENT") return { source: "built-in default", valid: true, errors: [], policy: structuredClone(DEFAULT_POLICY) };
    return { source: "local/routing-policy.json", valid: false, errors: ["file is not valid JSON"], policy: structuredClone(DEFAULT_POLICY) };
  }
}

const splitRef = (ref) => { const i = ref.indexOf("/"); return i < 0 ? { provider: null, model: ref } : { provider: ref.slice(0, i), model: ref.slice(i + 1) }; };

/** Availability of one model reference using only provider-reported windows and router lockouts. */
export function modelAvailability(ref, overview) {
  const { provider, model } = splitRef(ref);
  const conns = (overview.connections || []).filter((c) => c.active && (!provider || c.provider === provider));
  if (!conns.length) return { state: "unknown", reason: provider ? `no active ${provider} connection reported by the router` : "provider not specified" };
  const lock = (overview.lockouts || []).find((l) => (!provider || l.provider === provider) && l.model === model);
  if (lock) return { state: "locked-out", reason: `router lockout (${lock.reason}) until ${lock.until ?? "unknown"}`, until: lock.until };
  let anyReported = false;
  for (const conn of conns) {
    const q = conn.quota;
    if (!q || q.support !== "reported") continue;
    anyReported = true;
    const hit = [...q.perModel.filter((w) => w.model === model), ...q.windows.filter((w) => w.group && (w.models || []).includes(model)), ...q.windows.filter((w) => !w.group)].find((w) => w.state === "exhausted");
    if (hit) return { state: "exhausted", reason: `${hit.label} exhausted (provider-reported)`, until: hit.resetAt };
  }
  return anyReported ? { state: "available", reason: "no exhausted provider-reported window applies" } : { state: "unknown", reason: "provider does not report quota through the router" };
}

export function evaluatePolicy({ policyState, overview }) {
  const { policy } = policyState;
  const findings = [];
  const routerUp = overview?.connection?.state === "connected";
  if (!policyState.valid) findings.push({ level: "warning", code: "policy-invalid", message: `Policy file rejected: ${policyState.errors.join("; ")}. Built-in defaults are in effect.` });
  if (!routerUp) {
    findings.push({ level: "info", code: "router-unavailable", message: "OmniRoute is not reachable with valid credentials, so no policy evaluation against live state is possible." });
    return { policy: { source: policyState.source, valid: policyState.valid, errors: policyState.errors, effective: policy }, findings, groups: [], chains: [], combos: [], appliedToRouter: false };
  }
  const groups = policy.priorityGroups.map((group) => ({ id: group.id, purpose: group.purpose, models: group.models.map((ref) => ({ ref, ...modelAvailability(ref, overview) })) }));
  const chains = policy.fallbackChains.map((chain) => {
    const steps = chain.steps.map((ref) => ({ ref, ...modelAvailability(ref, overview) }));
    const first = steps.find((s) => s.state === "available") ?? steps.find((s) => s.state === "unknown") ?? null;
    if (!steps.some((s) => s.state === "available" || s.state === "unknown")) findings.push({ level: "critical", code: "chain-unavailable", message: `Fallback chain "${chain.id}" has no available step right now.` });
    return { id: chain.id, purpose: chain.purpose, requires: chain.requires, steps, firstUsable: first?.ref ?? null };
  });
  const combos = (overview.combos || []).map((combo) => {
    const steps = combo.steps.map((step) => ({ ref: step.providerId && !step.model.includes("/") ? `${step.providerId}/${step.model}` : step.model, ...modelAvailability(step.providerId && !step.model.includes("/") ? `${step.providerId}/${step.model}` : step.model, overview) }));
    const unavailable = steps.filter((s) => ["exhausted", "locked-out"].includes(s.state));
    if (steps.length && unavailable.length === steps.length) findings.push({ level: "critical", code: "combo-unavailable", message: `Router combo "${combo.name}" has every step exhausted or locked out.` });
    else if (unavailable.length) findings.push({ level: "warning", code: "combo-degraded", message: `Router combo "${combo.name}": ${unavailable.length}/${steps.length} step(s) exhausted or locked out (${unavailable.map((s) => s.ref).join(", ")}).` });
    return { name: combo.name, strategy: combo.strategy, steps };
  });
  const retry = overview.routingSettings?.requestRetry;
  if (Number.isFinite(retry) && retry > policy.retry.maxRetries) findings.push({ level: "warning", code: "retry-above-policy", message: `Router requestRetry is ${retry}; policy allows at most ${policy.retry.maxRetries}. Excess retries consume quota on failing providers.` });
  const qm = overview.router?.quotaMonitoring;
  if (qm && qm.unsupported > 0) findings.push({ level: "info", code: "router-quota-monitoring", message: `The router itself reports authoritative quota monitoring for ${qm.authoritative ?? 0} connection(s) and "unsupported" for ${qm.unsupported}. Per-connection provider-reported figures below are used where the provider exposes them.` });
  for (const w of overview.warnings || []) {
    if (w.level === "exhausted" || w.level === "critical") findings.push({ level: w.level === "exhausted" ? "critical" : "warning", code: `quota-${w.level}`, message: `${w.provider}: ${w.window} is ${w.level} (${w.remainingPct ?? "?"}% remaining)${w.resetAt ? `; resets ${w.resetAt}` : ""}.` });
  }
  findings.sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.level] - { critical: 0, warning: 1, info: 2 }[b.level]));
  return { policy: { source: policyState.source, valid: policyState.valid, errors: policyState.errors, effective: policy }, findings, groups, chains, combos, appliedToRouter: false };
}
