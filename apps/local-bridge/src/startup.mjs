/* Windows sign-in startup state and the few fixed local operations System Center may request. Each operation maps to one
 * hard-coded argument vector (the project's own launcher, or OmniRoute's own CLI); nothing from a request body reaches a
 * command line, and no path is returned to the browser. OmniRoute's supported mechanism is its own `autostart` command
 * (a hidden VBS in the user's Startup folder that refuses to start a second instance on a busy port); Company OS uses its
 * launcher's Startup-folder shortcut, which starts the bridge and a bounded supervisor at sign-in. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { HttpError } from "./company.mjs";

export const STARTUP_ACTIONS = ["router-retry", "router-start", "company-autostart-on", "company-autostart-off", "omniroute-autostart-on", "omniroute-autostart-off", "browser-at-signin-on", "browser-at-signin-off"];

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (_) { return null; } };
const isoOrNull = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function createStartup({ root, env = process.env, platform = process.platform, spawnImpl = spawn, nodePath = process.execPath, log = () => {}, now = () => Date.now() }) {
  const startupDir = env.APPDATA ? join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup") : null;
  const files = {
    companyLink: startupDir ? join(startupDir, "ABUD FUN Company OS.lnk") : null,
    omniVbs: startupDir ? join(startupDir, "OmniRoute.vbs") : null,
    omniCli: env.APPDATA ? join(env.APPDATA, "npm", "node_modules", "omniroute", "bin", "omniroute.mjs") : null,
    launcherState: join(root, "local", "runtime", "launcher-state.json"),
    supervisorPid: join(root, "local", "runtime", "supervisor.pid"),
    prefs: join(root, "local", "launcher.json"),
    launcher: join(root, "ABUD-OS.ps1")
  };
  const router = { state: "unknown", since: null, lastConnectedAt: null, lastFailureAt: null, lastFailureState: null, reconnects: 0, startRequestedAt: null };

  /** Called with every OmniRoute overview the bridge computes; records transitions, never inferring beyond them. */
  function observeRouter(state) {
    const at = new Date(now()).toISOString();
    if (state === "connected") {
      if (router.state !== "connected" && router.lastFailureAt) router.reconnects++;
      router.lastConnectedAt = at;
    } else { router.lastFailureAt = at; router.lastFailureState = state; }
    if (state !== router.state) { router.since = at; log(JSON.stringify({ event: "router-state", state })); }
    router.state = state;
  }

  function prefs() { const p = readJson(files.prefs) || {}; return { openBrowserAtSignIn: p.openBrowserAtSignIn !== false }; }
  function launcher() {
    const s = readJson(files.launcherState);
    if (!s) return null;
    return { mode: ["sign-in", "manual"].includes(s.mode) ? s.mode : null, lastAttemptAt: isoOrNull(s.lastAttemptAt), lastSuccessAt: isoOrNull(s.lastSuccessAt), lastFailureAt: isoOrNull(s.lastFailureAt),
      lastFailure: typeof s.lastFailure === "string" ? s.lastFailure.replace(/[A-Za-z]:\\[^\s"']+/g, "[path]").slice(0, 240) : null, attempts: Number.isInteger(s.attempts) ? s.attempts : null,
      supervisorRestarts: Number.isInteger(s.supervisorRestarts) ? s.supervisorRestarts : 0, supervisorGaveUpAt: isoOrNull(s.supervisorGaveUpAt) };
  }
  const supervisorRunning = () => {
    let pid = 0;
    try { pid = Number(readFileSync(files.supervisorPid, "utf8").replace(/^﻿/, "").trim()); } catch (_) { return false; }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
  };

  function status() {
    const windows = platform === "win32";
    return {
      platform: windows ? "windows" : platform,
      company: { autostart: windows && Boolean(files.companyLink && existsSync(files.companyLink)), mechanism: "Startup-folder shortcut → ABUD-OS.ps1 start -AtSignIn", launcher: launcher(), supervisor: supervisorRunning(), ...prefs() },
      omniroute: { installed: Boolean(files.omniCli && existsSync(files.omniCli)), autostart: windows && Boolean(files.omniVbs && existsSync(files.omniVbs)), mechanism: "omniroute autostart (hidden VBS in the Startup folder)", connection: { ...router } }
    };
  }

  /** Runs one fixed argument vector and waits (bounded) for it to exit. */
  function runFixed(file, args, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      let child;
      try { child = spawnImpl(file, args, { windowsHide: true, stdio: "ignore", cwd: root }); } catch (_) { resolve({ ok: false, code: null }); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } resolve({ ok: false, code: "timeout" }); }, timeoutMs);
      child.on("error", () => { clearTimeout(timer); resolve({ ok: false, code: null }); });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }); });
    });
  }
  const powershell = () => join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  async function perform(action, { routerConnected = false } = {}) {
    if (!STARTUP_ACTIONS.includes(action)) throw new HttpError(422, "unknown-action", "إجراء غير مسموح");
    if (platform !== "win32" && action !== "router-retry") throw new HttpError(409, "windows-only", "هذا الإجراء متاح على Windows فقط");
    if (action === "browser-at-signin-on" || action === "browser-at-signin-off") {
      mkdirSync(dirname(files.prefs), { recursive: true });
      writeFileSync(files.prefs, JSON.stringify({ ...(readJson(files.prefs) || {}), openBrowserAtSignIn: action.endsWith("-on") }, null, 2));
      return { done: true };
    }
    if (action === "router-start") {
      if (routerConnected) throw new HttpError(409, "router-running", "OmniRoute متصل بالفعل؛ لا يُشغَّل نسخة ثانية");
      if (!files.omniCli || !existsSync(files.omniCli)) throw new HttpError(409, "router-missing", "OmniRoute غير مثبت في المسار المتوقع");
      if (router.startRequestedAt && now() - Date.parse(router.startRequestedAt) < 60_000) throw new HttpError(429, "router-start-throttled", "طُلب التشغيل قبل أقل من دقيقة؛ انتظر حتى يكتمل");
      router.startRequestedAt = new Date(now()).toISOString();
      // The supported daemon form; OmniRoute itself refuses to start when its port is already owned.
      const result = await runFixed(nodePath, [files.omniCli, "serve", "--daemon", "--no-open", "--no-tray"], 60_000);
      return { done: result.ok, code: result.code };
    }
    if (action.startsWith("company-autostart")) {
      const result = await runFixed(powershell(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", files.launcher, "-Action", action.endsWith("-on") ? "autostart-on" : "autostart-off"]);
      if (!result.ok) throw new HttpError(500, "autostart-failed", "تعذر تعديل التشغيل عند تسجيل الدخول");
      return { done: true, autostart: status().company.autostart };
    }
    if (action.startsWith("omniroute-autostart")) {
      if (!files.omniCli || !existsSync(files.omniCli)) throw new HttpError(409, "router-missing", "OmniRoute غير مثبت في المسار المتوقع");
      const result = await runFixed(nodePath, [files.omniCli, "autostart", action.endsWith("-on") ? "enable" : "disable"]);
      if (!result.ok) throw new HttpError(500, "autostart-failed", "تعذر تعديل تشغيل OmniRoute التلقائي");
      return { done: true, autostart: status().omniroute.autostart };
    }
    return { done: true };
  }

  return { status, observeRouter, perform, files };
}
