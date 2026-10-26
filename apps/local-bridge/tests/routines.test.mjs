/* V6 routines: deterministic schedules in the company timezone, owner opt-in, executed vs missed, no model calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.mjs";
import { createCompany } from "../src/company.mjs";
import { createMeetings } from "../src/meetings.mjs";
import { createRoutines, dueTimes } from "../src/routines.mjs";

const TZ = "Africa/Cairo";
const utc = (iso) => Date.parse(iso);

function setup(startIso = "2026-01-10T12:00:00Z") {
  let clock = utc(startIso);
  const now = () => new Date(clock);
  const company = createCompany({ db: openDatabase(":memory:"), now });
  company.seed();
  const meetings = createMeetings({ company, runtime: {} });
  const routines = createRoutines({ company, meetings, now });
  return { company, meetings, routines, advance: (ms) => { clock += ms; }, set: (iso) => { clock = utc(iso); }, close: () => company.db.close() };
}
const byKind = (routines, kind) => routines.list().find((r) => r.kind === kind);

test("schedules follow the company timezone, including its daylight-saving offset", () => {
  // Winter (UTC+2): 08:30 Cairo is 06:30Z. Summer (UTC+3): 08:30 Cairo is 05:30Z.
  assert.deepEqual(dueTimes({ type: "daily", time: "08:30" }, utc("2026-01-10T00:00:00Z"), utc("2026-01-11T23:59:00Z"), TZ).map((t) => new Date(t).toISOString()),
    ["2026-01-10T06:30:00.000Z", "2026-01-11T06:30:00.000Z"]);
  assert.deepEqual(dueTimes({ type: "daily", time: "08:30" }, utc("2026-07-10T00:00:00Z"), utc("2026-07-10T23:59:00Z"), TZ).map((t) => new Date(t).toISOString()), ["2026-07-10T05:30:00.000Z"]);
  // Weekly on Sunday (day 0): 2026-01-11 is a Sunday.
  assert.deepEqual(dueTimes({ type: "weekly", day: 0, time: "10:00" }, utc("2026-01-05T00:00:00Z"), utc("2026-01-19T00:00:00Z"), TZ).map((t) => new Date(t).toISOString()),
    ["2026-01-11T08:00:00.000Z", "2026-01-18T08:00:00.000Z"]);
});

test("routines are installed disabled and nothing runs until the owner enables one", () => {
  const env = setup();
  try {
    assert.equal(env.routines.list().length, 7);
    assert.ok(env.routines.list().every((r) => !r.enabled));
    env.set("2026-01-11T07:00:00Z");
    assert.deepEqual(env.routines.tick(), []);
    assert.throws(() => env.routines.update("rt_daily-summary", { enabled: true }, { type: "agent", id: "ori" }), (e) => e.status === 403);
    assert.throws(() => env.routines.update("rt_daily-summary", { schedule: { type: "daily", time: "25:61" } }), (e) => e.status === 422);
    assert.throws(() => env.routines.runNow("rt_daily-summary", { type: "agent", id: "rex" }), (e) => e.status === 403);
  } finally { env.close(); }
} );

test("an enabled routine runs once in its window, raises one notification and makes no model call", () => {
  const env = setup("2026-01-10T12:00:00Z");
  try {
    env.company.createTask({ title: "تسليم التقرير", dueDate: "2026-01-09", priority: "high" });
    env.routines.update("rt_daily-summary", { enabled: true });
    env.set("2026-01-11T06:35:00Z"); // 5 minutes after 08:30 Cairo
    const first = env.routines.tick();
    assert.equal(first.length, 1);
    assert.equal(first[0].status, "executed");
    assert.match(first[0].summary, /1 مهمة مفتوحة، 1 متأخرة/);
    assert.deepEqual(env.routines.tick(), [], "a second tick for the same due time is a no-op");
    const note = env.company.notifications().find((n) => n.kind === "routine");
    assert.ok(note);
    assert.equal(note.level, "warning");
    assert.equal(env.company.db.get("SELECT COUNT(*) AS n FROM agent_runs").n, 0, "no model or agent run was created");
    assert.equal(byKind(env.routines, "daily-summary").lastRun.status, "executed");
  } finally { env.close(); }
});

test("enabling mid-day never reports the morning as missed; downtime is recorded as missed, not executed", () => {
  const env = setup("2026-01-10T12:00:00Z");
  try {
    env.routines.update("rt_daily-summary", { enabled: true });
    env.set("2026-01-10T20:00:00Z");
    assert.deepEqual(env.routines.tick(), [], "the 08:30 that passed before enabling is not owed");
    // Bridge down for three days; it comes back two minutes after the 4th morning's due time.
    env.set("2026-01-14T06:32:00Z");
    const result = env.routines.tick();
    assert.deepEqual(result.map((r) => r.status), ["missed", "missed", "missed", "executed"]);
    const runs = env.routines.runs("rt_daily-summary");
    assert.equal(runs.filter((r) => r.status === "missed").length, 3);
    assert.equal(env.company.notifications().filter((n) => n.kind === "routine").length, 1, "only the executed run notifies");
    assert.equal(byKind(env.routines, "daily-summary").missedCount, 3);
    // Coming back long after the due time (outside the grace window) records missed rather than running late.
    env.set("2026-01-15T10:30:00Z");
    assert.deepEqual(env.routines.tick().map((r) => r.status), ["missed"]);
  } finally { env.close(); }
});

test("manual runs are recorded separately and never satisfy a scheduled due time", () => {
  const env = setup("2026-01-10T12:00:00Z");
  try {
    env.routines.update("rt_approvals-review", { enabled: true });
    const manual = env.routines.runNow("rt_approvals-review");
    assert.equal(manual.trigger, "manual");
    assert.match(manual.summary, /لا توجد موافقات معلّقة/);
    env.set("2026-01-11T07:20:00Z"); // 09:20 Cairo, 5 minutes after the 09:15 due time
    assert.deepEqual(env.routines.tick().map((r) => r.status), ["executed"]);
  } finally { env.close(); }
});

test("the weekly meeting routine prepares a scheduled meeting but never starts it", () => {
  const env = setup("2026-01-10T12:00:00Z");
  try {
    env.routines.update("rt_weekly-meeting", { enabled: true });
    env.set("2026-01-11T08:03:00Z"); // Sunday 10:03 Cairo
    const [run] = env.routines.tick();
    assert.equal(run.status, "executed");
    const meeting = env.meetings.get(run.meetingId);
    assert.equal(meeting.status, "scheduled");
    assert.equal(meeting.chair, "ori");
    assert.equal(meeting.participants.length, 6);
    assert.equal(meeting.turns.length, 0);
    assert.equal(env.company.db.get("SELECT COUNT(*) AS n FROM agent_runs").n, 0);
  } finally { env.close(); }
});

test("changing the schedule restarts its clock and the other read-only routines report real counts", () => {
  const env = setup("2026-01-10T12:00:00Z");
  try {
    const moved = env.routines.update("rt_deadline-review", { enabled: true, schedule: { type: "daily", time: "13:00" } });
    assert.equal(moved.scheduleAr, "يوميًا 13:00");
    assert.ok(moved.nextDueAt);
    env.company.createTask({ title: "مراجعة العقد", dueDate: "2026-01-12" });
    env.set("2026-01-11T11:03:00Z"); // 13:03 Cairo
    const [run] = env.routines.tick();
    assert.match(run.summary, /تستحق خلال 3 أيام/);
    assert.equal(run.details.tasks[0].title, "مراجعة العقد");
    for (const kind of ["ai-usage-summary", "security-reminder", "knowledge-review"]) {
      const id = `rt_${kind}`;
      assert.equal(env.routines.runNow(id).status, "executed", kind);
    }
  } finally { env.close(); }
});
