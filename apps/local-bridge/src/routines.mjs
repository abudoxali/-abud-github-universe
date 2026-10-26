/* Owner-enabled routines: the daily summary, deadline and approval reviews, the AI usage summary, the weekly team meeting
 * and the security / knowledge review reminders. Everything here is deterministic — a fixed schedule in the company
 * timezone, read-only checks over records already in the store, and no model call — so an idle company spends no tokens.
 * A routine is off until the owner turns it on. Each due time ends as exactly one routine_runs row: executed or failed
 * if the bridge was up, missed if it was not (never silently counted as done). The weekly meeting only creates a
 * scheduled meeting for the owner to start; it never starts one and never decides anything. */
import { HttpError } from "./company.mjs";
import { newId, parseJson } from "./db.mjs";

const GRACE_MS = 15 * 60_000;          // a due time older than this when seen is "missed", not run late
const LOOKBACK_MS = 8 * 86_400_000;    // never walk further back than a week when the bridge was off
const DAY_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** Defaults installed disabled. Egyptian work week: Sunday–Thursday; the weekly meeting is Sunday morning. */
export const ROUTINE_DEFAULTS = [
  { kind: "daily-summary", title: "ملخص عمليات اليوم", schedule: { type: "daily", time: "08:30" } },
  { kind: "deadline-review", title: "مراجعة المواعيد النهائية", schedule: { type: "daily", time: "09:00" } },
  { kind: "approvals-review", title: "الموافقات المعلّقة", schedule: { type: "daily", time: "09:15" } },
  { kind: "ai-usage-summary", title: "ملخص استهلاك الذكاء الاصطناعي", schedule: { type: "weekly", day: 0, time: "09:30" } },
  { kind: "weekly-meeting", title: "اجتماع الفريق الأسبوعي", schedule: { type: "weekly", day: 0, time: "10:00" } },
  { kind: "security-reminder", title: "تذكير المراجعة الأمنية", schedule: { type: "weekly", day: 4, time: "11:00" } },
  { kind: "knowledge-review", title: "تذكير مراجعة المعرفة", schedule: { type: "weekly", day: 3, time: "11:00" } }
];

function zonedParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
    .formatToParts(date).map((p) => [p.type, p.value]));
}
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The UTC instant of `hh:mm` on a calendar day in `timeZone` (handles offset changes by re-checking once). */
function zonedInstant(y, m, d, hh, mm, timeZone) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += Date.UTC(y, m - 1, d, hh, mm) - seen;
  }
  return new Date(guess);
}

/** Every due instant of `schedule` in (afterMs, untilMs], oldest first. */
export function dueTimes(schedule, afterMs, untilMs, timeZone) {
  const [hh, mm] = String(schedule.time || "09:00").split(":").map(Number);
  const out = [];
  const start = new Date(afterMs);
  for (let day = -1; day <= Math.ceil((untilMs - afterMs) / 86_400_000) + 1; day++) {
    const p = zonedParts(new Date(start.getTime() + day * 86_400_000), timeZone);
    if (schedule.type === "weekly" && WEEKDAYS[p.weekday] !== schedule.day) continue;
    const instant = zonedInstant(+p.year, +p.month, +p.day, hh, mm, timeZone).getTime();
    if (instant > afterMs && instant <= untilMs && !out.includes(instant)) out.push(instant);
  }
  return out.sort((a, b) => a - b);
}

function validateSchedule(input) {
  const type = input?.type;
  if (!["daily", "weekly"].includes(type)) throw new HttpError(422, "validation", "نوع الجدول يوميًا أو أسبوعيًا");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time ?? ""))) throw new HttpError(422, "validation", "الوقت بصيغة HH:MM");
  if (type === "weekly" && !(Number.isInteger(input.day) && input.day >= 0 && input.day <= 6)) throw new HttpError(422, "validation", "اليوم رقم من 0 (الأحد) إلى 6 (السبت)");
  return type === "weekly" ? { type, day: input.day, time: input.time } : { type, time: input.time };
}

export function createRoutines({ company, meetings = null, now = () => new Date(), log = () => {} }) {
  const db = company.db;
  const iso = () => now().toISOString();
  const tz = () => company.settings().timezone;
  const row = (r) => ({ id: r.id, kind: r.kind, title: r.title, schedule: parseJson(r.schedule, {}), enabled: r.enabled === 1, enabledAt: r.enabled_at, lastDueAt: r.last_due_at, createdAt: r.created_at, updatedAt: r.updated_at });
  const runRow = (r) => ({ id: r.id, routineId: r.routine_id, dueAt: r.due_at, ranAt: r.ran_at, status: r.status, trigger: r.trigger, summary: r.summary, details: parseJson(r.details, {}), meetingId: r.meeting_id });
  const scheduleAr = (s) => s.type === "daily" ? `يوميًا ${s.time}` : `كل ${DAY_AR[s.day]} ${s.time}`;

  function seed() {
    const at = iso();
    for (const d of ROUTINE_DEFAULTS) {
      db.run("INSERT OR IGNORE INTO routines (id, kind, title, schedule, enabled, created_at, updated_at) VALUES (?,?,?,?,0,?,?)", `rt_${d.kind}`, d.kind, d.title, JSON.stringify(d.schedule), at, at);
    }
  }

  function list() {
    return db.all("SELECT * FROM routines ORDER BY rowid").map((r) => {
      const last = db.get("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1", r.id);
      const missed = db.get("SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND status = 'missed'", r.id).n;
      const model = row(r);
      return { ...model, scheduleAr: scheduleAr(model.schedule), lastRun: last ? runRow(last) : null, missedCount: missed, nextDueAt: model.enabled ? dueTimes(model.schedule, now().getTime(), now().getTime() + 9 * 86_400_000, tz())[0] ? new Date(dueTimes(model.schedule, now().getTime(), now().getTime() + 9 * 86_400_000, tz())[0]).toISOString() : null : null };
    });
  }
  const get = (id) => { const r = db.get("SELECT * FROM routines WHERE id = ?", String(id)); if (!r) throw new HttpError(404, "not-found", "الروتين غير موجود"); return r; };
  const runs = (id, limit = 30) => (get(id), db.all("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT ?", id, Math.min(Number(limit) || 30, 200)).map(runRow));

  /** Owner-only configuration: switch on/off and move the time. Turning a routine on starts its clock now, so
   * enabling at noon never reports the morning as missed. */
  function update(id, patch = {}, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "ضبط الروتين للمالك وحده");
    const current = get(id);
    const schedule = patch.schedule !== undefined ? validateSchedule(patch.schedule) : parseJson(current.schedule, {});
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0;
    const at = iso();
    db.tx(() => {
      db.run("UPDATE routines SET schedule = ?, enabled = ?, enabled_at = ?, last_due_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(schedule), enabled,
        enabled && !current.enabled ? at : enabled ? current.enabled_at : null, enabled && (!current.enabled || patch.schedule !== undefined) ? at : current.last_due_at, at, id);
      company.log({ actorType: "owner", actorId: "owner", action: "routine.updated", targetType: "routine", targetId: id, summary: `${enabled ? "تفعيل" : "إيقاف"} روتين «${current.title}» (${scheduleAr(schedule)})` });
    });
    return list().find((r) => r.id === id);
  }

  // ------------------------------------------------------------------ the read-only checks (no model calls)
  const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(now());
  const openTasks = () => company.listTasks({ includeClosed: false, limit: 2000 }).filter((t) => !t.archivedAt);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const CHECKS = {
    "daily-summary"() {
      const today = todayIso(), tasks = openTasks();
      const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today), dueToday = tasks.filter((t) => t.dueDate === today);
      const approvals = company.listApprovals({ status: "pending" }).length;
      const active = company.listRuns({ limit: 100 }).filter((r) => ["queued", "running"].includes(r.status)).length;
      const meetingsToday = db.all("SELECT id FROM meetings WHERE status IN ('scheduled','active','paused')").length;
      const summary = `${plural(tasks.length, "مهمة مفتوحة", "مهام مفتوحة")}، ${overdue.length} متأخرة، ${dueToday.length} مستحقة اليوم، ${approvals} موافقة معلّقة، ${active} تشغيل جارٍ، ${meetingsToday} اجتماع قادم أو مفتوح.`;
      return { summary, details: { openTasks: tasks.length, overdue: overdue.length, dueToday: dueToday.length, approvalsPending: approvals, activeRuns: active, openMeetings: meetingsToday }, level: overdue.length || approvals ? "warning" : "info" };
    },
    "deadline-review"() {
      const today = todayIso(), soon = new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(new Date(now().getTime() + 3 * 86_400_000));
      const tasks = openTasks().filter((t) => t.dueDate && t.dueDate <= soon).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const overdue = tasks.filter((t) => t.dueDate < today);
      const summary = tasks.length ? `${overdue.length} مهمة متأخرة و${tasks.length - overdue.length} تستحق خلال 3 أيام. الأقرب: «${tasks[0].title}» (${tasks[0].dueDate}).` : "لا توجد مهام متأخرة أو مستحقة خلال 3 أيام.";
      return { summary, details: { overdue: overdue.length, upcoming: tasks.length - overdue.length, tasks: tasks.slice(0, 10).map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate, assignee: t.assignee })) }, level: overdue.length ? "warning" : "info" };
    },
    "approvals-review"() {
      const pending = company.listApprovals({ status: "pending" });
      const summary = pending.length ? `${pending.length} موافقة تنتظر قرارك${pending[0].created_at ? ` — الأقدم من ${String(pending.at(-1).created_at).slice(0, 10)}` : ""}.` : "لا توجد موافقات معلّقة.";
      return { summary, details: { pending: pending.length, ids: pending.slice(0, 10).map((a) => a.id) }, level: pending.length ? "warning" : "info" };
    },
    "ai-usage-summary"() {
      const week = company.usageSince(new Date(now().getTime() - 7 * 86_400_000).toISOString());
      const byAgent = company.usageByAgent(new Date(now().getTime() - 7 * 86_400_000).toISOString());
      const top = [...byAgent].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))[0];
      const cost = week.unknownCostEvents ? `التكلفة غير معروفة لـ ${week.unknownCostEvents} طلب` : `التكلفة التقديرية ${week.costUsd.toFixed(4)}$`;
      const summary = `آخر 7 أيام: ${week.runs} طلب، ${week.tokens.toLocaleString("en")} رمز${top?.agentId ? `، الأكثر استهلاكًا ${company.agentById(top.agentId)?.name ?? top.agentId}` : ""}. ${cost}.`;
      return { summary, details: { runs: week.runs, tokens: week.tokens, costUsd: week.costUsd, unknownCostEvents: week.unknownCostEvents }, level: "info" };
    },
    "security-reminder"() {
      const pending = company.listApprovals({ status: "pending" }).length;
      return { summary: `موعد المراجعة الأمنية الأسبوعية: اطلب من REX فحص المستودعات المهمة. ${pending ? `${pending} موافقة معلّقة تحتاج نظرك.` : "لا موافقات معلّقة."}`, details: { approvalsPending: pending, suggestedAgent: "rex" }, level: "info" };
    },
    "knowledge-review"() {
      const conflicts = company.memoryConflicts().length;
      const proposals = db.get("SELECT COUNT(*) AS n FROM learning_proposals WHERE status = 'pending'")?.n ?? 0;
      const stale = db.get("SELECT COUNT(*) AS n FROM knowledge_documents WHERE state = 'active' AND freshness IN ('stale','changed')")?.n ?? 0;
      return { summary: `${conflicts} تعارض في الذاكرة، ${proposals} اقتراح تعلّم معلّق، ${stale} مصدر معرفة قديم أو متغيّر.`, details: { memoryConflicts: conflicts, pendingProposals: proposals, staleSources: stale }, level: conflicts || proposals || stale ? "warning" : "info" };
    },
    "weekly-meeting"() {
      if (!meetings) return { summary: "مركز الاجتماعات غير متاح.", details: {}, level: "info", failed: true };
      const team = company.listAgents().filter((a) => company.agentConfig(a.id).enabled).map((a) => a.id);
      const open = openTasks().length;
      const meeting = meetings.create({ title: `اجتماع الفريق الأسبوعي — ${todayIso()}`, participants: team, mode: "text",
        agenda: ["مراجعة أولويات الأسبوع", `حالة المهام المفتوحة (${open})`, "المخاطر والموافقات المعلّقة", "استهلاك الذكاء الاصطناعي"] });
      return { summary: `جُهّز اجتماع الفريق الأسبوعي (${team.length} مشاركين). لم يبدأ؛ افتحه من الاجتماعات عندما تكون جاهزًا.`, details: { participants: team.length }, level: "info", meetingId: meeting.id };
    }
  };

  function execute(routine, dueAt, trigger) {
    const model = row(routine);
    let outcome, status = "executed";
    try { outcome = CHECKS[model.kind](); if (outcome.failed) status = "failed"; } catch (error) {
      outcome = { summary: `تعذر تنفيذ الروتين: ${String(error?.message || error).slice(0, 160)}`, details: {}, level: "warning" };
      status = "failed";
    }
    const id = newId("rtr");
    db.tx(() => {
      db.run("INSERT INTO routine_runs (id, routine_id, due_at, ran_at, status, trigger, summary, details, meeting_id) VALUES (?,?,?,?,?,?,?,?,?)",
        id, model.id, dueAt, iso(), status, trigger, outcome.summary, JSON.stringify(outcome.details ?? {}), outcome.meetingId ?? null);
      if (status === "executed" || status === "failed") {
        company.raise({ key: `routine:${model.id}:${dueAt}:${trigger}`, level: outcome.level ?? "info", kind: "routine", title: model.title, body: outcome.summary,
          targetType: outcome.meetingId ? "meeting" : "routine", targetId: outcome.meetingId ?? model.id });
      }
      company.log({ actorType: "system", actorId: "routines", action: `routine.${status}`, targetType: "routine", targetId: model.id, outcome: status === "executed" ? "success" : "failure", summary: `${model.title}: ${outcome.summary}`.slice(0, 300), metadata: { dueAt, trigger } });
    });
    return runRow(db.get("SELECT * FROM routine_runs WHERE id = ?", id));
  }

  /** Manual run: the same read-only checks, recorded as a manual run so it never satisfies a scheduled due time. */
  function runNow(id, actor = { type: "owner", id: "owner" }) {
    if (actor.type !== "owner") throw new HttpError(403, "owner-only", "تشغيل الروتين يدويًا للمالك وحده");
    return execute(get(id), iso(), "manual");
  }

  /** Walks every enabled routine's due times since it was last handled: the newest one within the grace window runs,
   * older ones are recorded as missed. Idempotent — the unique (routine, due) index makes a repeat a no-op. */
  function tick() {
    const nowMs = now().getTime();
    const processed = [];
    for (const r of db.all("SELECT * FROM routines WHERE enabled = 1")) {
      const schedule = parseJson(r.schedule, {});
      const since = Math.max(Date.parse(r.last_due_at || r.enabled_at || 0) || 0, nowMs - LOOKBACK_MS);
      const dues = dueTimes(schedule, since, nowMs, tz());
      if (!dues.length) continue;
      dues.forEach((dueMs, index) => {
        const dueAt = new Date(dueMs).toISOString();
        if (db.get("SELECT id FROM routine_runs WHERE routine_id = ? AND due_at = ? AND trigger = 'schedule'", r.id, dueAt)) return;
        const isNewest = index === dues.length - 1 && nowMs - dueMs <= GRACE_MS;
        if (isNewest) processed.push(execute(r, dueAt, "schedule"));
        else {
          db.run("INSERT INTO routine_runs (id, routine_id, due_at, ran_at, status, trigger, summary, details) VALUES (?,?,?,?,'missed','schedule',?,?)", newId("rtr"), r.id, dueAt, iso(),
            "لم يُنفَّذ في موعده لأن النظام كان متوقفًا.", JSON.stringify({ lateByMinutes: Math.round((nowMs - dueMs) / 60000) }));
          processed.push({ routineId: r.id, dueAt, status: "missed" });
        }
      });
      db.run("UPDATE routines SET last_due_at = ? WHERE id = ?", new Date(dues.at(-1)).toISOString(), r.id);
    }
    return processed;
  }

  let timer = null;
  function start(intervalMs = 60_000) {
    if (timer) return;
    seed();
    tick();
    timer = setInterval(() => { try { tick(); } catch (error) { log(`routines tick failed: ${error?.message}`); } }, intervalMs);
    timer.unref?.();
  }
  const stop = () => { clearInterval(timer); timer = null; };

  seed();
  return { list, get: (id) => list().find((r) => r.id === id) ?? get(id), runs, update, runNow, tick, start, stop };
}
