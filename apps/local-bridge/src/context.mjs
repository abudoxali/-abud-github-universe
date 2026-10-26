/* Company context boundaries. The company runs on the owner's personal PC, so reach is opt-in: only folders the owner
 * authorized are ever inspected, locations that hold credentials, browser profiles or system files can never be
 * authorized, and personal folders (Documents, Downloads, Desktop itself …) need an explicit owner flag. This module is
 * pure policy plus read-only reporting — what was read (the tool audit trail) and what left the machine (inference
 * usage) — and never touches file contents. */
import { homedir } from "node:os";
import { resolve } from "node:path";

const norm = (path) => resolve(String(path)).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

/** Locations that are never authorizable, whatever the owner configures. */
const PROTECTED = [
  [/\/\.ssh(\/|$)/, "مفاتيح SSH"], [/\/\.gnupg(\/|$)/, "مفاتيح GPG"], [/\/\.aws(\/|$)/, "بيانات اعتماد AWS"], [/\/\.azure(\/|$)/, "بيانات اعتماد Azure"],
  [/\/\.kube(\/|$)/, "إعدادات Kubernetes"], [/\/\.docker(\/|$)/, "بيانات اعتماد Docker"], [/\/\.config\/(gcloud|gh)(\/|$)/, "بيانات اعتماد السحابة وGitHub"],
  [/\/\.omniroute(\/|$)/, "حسابات وبيانات OmniRoute"], [/\/\.claude(\/|$)(?!worktrees)/, "جلسات وبيانات وكلاء البرمجة"], [/\/\.codex(\/|$)/, "جلسات وبيانات وكلاء البرمجة"],
  [/\/\.password-store(\/|$)/, "مخزن كلمات المرور"], [/\/(keepass|1password|bitwarden|lastpass|dashlane)[^/]*(\/|$)/, "مدير كلمات المرور"],
  [/\/appdata\/(local|roaming)\/(google\/chrome|microsoft\/edge|bravesoftware|opera software|mozilla|vivaldi|chromium)(\/|$)/, "ملفات المتصفح (كوكيز وكلمات المرور)"],
  [/\/appdata\/(local|roaming)\/microsoft\/(credentials|protect|vault|crypto|windows\/(cookies|inetcookies))(\/|$)/, "مخزن اعتماد ويندوز"],
  [/\/appdata\/roaming\/(signal|discord|slack|telegram desktop|whatsapp)(\/|$)/, "بيانات تطبيقات المراسلة"],
  [/^[a-z]:\/windows(\/|$)/, "ملفات النظام"], [/^[a-z]:\/program files( \(x86\))?(\/|$)/, "ملفات البرامج"], [/^[a-z]:\/programdata(\/|$)/, "بيانات النظام"],
  [/^[a-z]:\/\$recycle\.bin(\/|$)/, "سلة المحذوفات"], [/^[a-z]:\/system volume information(\/|$)/, "ملفات النظام"], [/^(\/etc|\/proc|\/sys|\/root)(\/|$)/, "ملفات النظام"]
];
/** Personal folders: allowed only when the owner marks the scope personal; their subfolders are ordinary scopes. */
const PERSONAL_NAMES = ["documents", "downloads", "desktop", "pictures", "music", "videos", "onedrive"];

/** `{ ok, code, reasonAr, personal }` for a candidate authorized folder. `personalConfirmed` is the owner's explicit flag. */
export function classifyPath(path, { personalConfirmed = false, home = homedir() } = {}) {
  const p = norm(path), h = norm(home);
  if (/^[a-z]:$/.test(p) || p === "" || p === "/") return { ok: false, code: "too-broad", reasonAr: "جذر قرص كامل أوسع من أن يُصرَّح به" };
  if (p === h) return { ok: false, code: "too-broad", reasonAr: "مجلد المستخدم كله أوسع من أن يُصرَّح به؛ اختر مجلد عمل محددًا" };
  for (const [pattern, label] of PROTECTED) if (pattern.test(p)) return { ok: false, code: "protected", reasonAr: `موقع محمي دائمًا: ${label}` };
  const rel = p.startsWith(`${h}/`) ? p.slice(h.length + 1).split("/") : [];
  const personal = (rel.length === 1 && PERSONAL_NAMES.includes(rel[0])) || (rel[0]?.startsWith("onedrive") && rel.length === 2 && PERSONAL_NAMES.includes(rel[1]));
  if (personal && !personalConfirmed) return { ok: false, code: "personal-needs-confirmation", reasonAr: "مجلد شخصي؛ يلزم تأكيدك الصريح أنه مصرّح به للشركة", personal: true };
  return { ok: true, code: "ok", personal };
}

/** What the company must never read through any tool, regardless of scope (file-level rules for future file tools). */
export const NEVER_READ_FILES = /(^|\/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|pfx|p12|kdbx|ppk)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|cookies(\.sqlite)?|login data|web data|key[34]\.db|logins\.json)$/i;

const DATA_FLOW = {
  staysLocal: ["قاعدة بيانات الشركة والمحادثات والذاكرة والاجتماعات", "فهرس المعرفة والمستندات", "التسجيلات الصوتية والصوت المولَّد (لا تُخزَّن)", "النماذج المحلية للصوت", "المجلدات المصرّح بها ومحتواها", "إعدادات الصلاحيات وسجل التدقيق"],
  sentToInference: ["نص رسالتك والمحادثة الأخيرة بحد أقصى لسياق محدد", "مقتطفات أدوات مقروءة ومنقّحة من الأسرار وبحدود حجم", "ملاحظات ذاكرة معتمدة (حتى 2400 حرف)", "مقتطفات معرفة مفهرسة ذات صلة (محدودة)", "نص ما تقوله بالصوت بعد تحويله محليًا إلى نص"],
  neverSent: ["الصوت نفسه", "قاعدة البيانات أو مجلدات كاملة", "ملفات الأسرار والمفاتيح والكوكيز", "محتوى المجلدات غير المصرّح بها"]
};

export function createContextReport({ company, workspaceReport }) {
  const db = company.db;
  const FILE_TOOLS = ["project.read", "project.docs", "git.status", "security.scan", "security.gitleaks", "security.osv", "knowledge.search", "knowledge.freshness", "web.extract", "design.saveCanvas"];

  /** Read-only trail of what agents touched, from the tool audit log (inputs reduced to ids/paths already stored). */
  function accessHistory({ limit = 50, agentId = null, projectId = null } = {}) {
    const where = [`tool_id IN (${FILE_TOOLS.map(() => "?").join(",")})`], params = [...FILE_TOOLS];
    if (agentId) { where.push("agent_id = ?"); params.push(String(agentId)); }
    if (projectId) { where.push("project_id = ?"); params.push(String(projectId)); }
    return db.all(`SELECT id, tool_id, agent_id, actor_type, project_id, status, error_code, started_at, duration_ms FROM tool_executions WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`, ...params, Math.min(Number(limit) || 50, 200))
      .map((r) => ({ id: r.id, toolId: r.tool_id, agentId: r.agent_id, actor: r.actor_type, projectId: r.project_id, status: r.status, errorCode: r.error_code, at: r.started_at, durationMs: r.duration_ms }));
  }

  /** Measured outbound inference: which provider and model received how many requests/tokens (no content). */
  function outbound({ days = 7 } = {}) {
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 7, 1), 90) * 86_400_000).toISOString();
    const rows = db.all("SELECT provider, model, COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(completion_tokens),0) AS completionTokens FROM usage_events WHERE at >= ? GROUP BY provider, model ORDER BY requests DESC LIMIT 30", since);
    return { since, byModel: rows.map((r) => ({ provider: r.provider ?? "unknown", model: r.model ?? "unknown", requests: r.requests, promptTokens: r.promptTokens, completionTokens: r.completionTokens })) };
  }

  async function overview() {
    const scopes = workspaceReport ? await workspaceReport() : { roots: [], rejected: [] };
    return { scopes, protected: PROTECTED.map(([, label]) => label).filter((v, i, all) => all.indexOf(v) === i), personalFolders: PERSONAL_NAMES, dataFlow: DATA_FLOW, outbound: outbound(), access: accessHistory({ limit: 25 }) };
  }
  return { accessHistory, outbound, overview, classifyPath, dataFlow: DATA_FLOW };
}
