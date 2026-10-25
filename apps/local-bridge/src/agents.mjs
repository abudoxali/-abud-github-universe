/* Agent discovery adapters. Each adapter reports only what is discoverable without reading credentials, session
 * contents, or scraping a UI: install metadata, process presence, config *keys on an allowlist*, file modification
 * times and router-reported provider state. Provider health and agent-process presence are kept strictly separate. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { run, text } from "./util.mjs";
import { STATE_RANK } from "./omniroute.mjs";

export const EXECUTION_POLICY = { enabled: false, reason: "Agent execution is disabled until a separate, explicitly approved execution milestone." };

/** TOML allowlist reader: top-level model/model_provider/approval_policy/sandbox_mode and [model_providers.*].base_url host. */
export function parseCodexConfig(content, routerHost) {
  const out = { model: null, modelProvider: null, approvalPolicy: null, sandboxMode: null, providers: [], routedThroughRouter: false };
  let table = "";
  for (const raw of String(content).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[\[?([^\]]+)\]?\]$/);
    if (header) { table = header[1].trim(); continue; }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (!table) {
      if (key === "model") out.model = text(value, 80);
      else if (key === "model_provider") out.modelProvider = text(value, 60);
      else if (key === "approval_policy") out.approvalPolicy = text(value, 40);
      else if (key === "sandbox_mode") out.sandboxMode = text(value, 40);
    } else if (/^model_providers\.[A-Za-z0-9_-]+$/.test(table) && key === "base_url") {
      try {
        const host = new URL(value).host;
        out.providers.push({ name: table.split(".")[1], baseHost: host });
        if (routerHost && host === routerHost) out.routedThroughRouter = true;
      } catch (_) { /* unparsable base_url is simply not reported */ }
    }
  }
  return out;
}

const normalizeEncoded = (value) => String(value).replace(/[^A-Za-z0-9]/g, "-");

/** Claude Code stores per-project folders named after the project path with non-alphanumerics replaced by '-'. */
export function matchEncodedProject(encodedName, repos) {
  let best = null;
  for (const repo of repos) {
    const enc = normalizeEncoded(repo.dir);
    if (encodedName.toLowerCase() === enc.toLowerCase() || encodedName.toLowerCase().startsWith(`${enc.toLowerCase()}--`)) {
      if (!best || enc.length > best.enc.length) best = { rel: repo.rel, enc };
    }
  }
  return best?.rel ?? null;
}

async function newestMtime(dir, { depth = 1, filesOnly = false, limit = 400 } = {}) {
  let newest = null;
  let seen = 0;
  async function walk(path, remaining) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch (_) { return; }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const entry of entries) {
      if (seen++ > limit || entry.isSymbolicLink()) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!filesOnly) { const s = await stat(full).catch(() => null); if (s && (!newest || s.mtimeMs > newest.ms)) newest = { ms: s.mtimeMs, name: entry.name }; }
        if (remaining > 0) await walk(full, remaining - 1);
      } else {
        const s = await stat(full).catch(() => null);
        if (s && (!newest || s.mtimeMs > newest.ms)) newest = { ms: s.mtimeMs, name: entry.name };
      }
    }
  }
  await walk(dir, depth);
  return newest;
}

async function fileMtime(path) {
  try { return (await stat(path)).mtimeMs; } catch (_) { return null; }
}

export async function listProcessCounts(names, { runImpl = run, platform = process.platform } = {}) {
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  const result = platform === "win32"
    ? await runImpl("tasklist", ["/FO", "CSV", "/NH"], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
    : await runImpl("ps", ["-A", "-o", "comm="], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
  if (!result.ok) return { available: false, counts };
  for (const line of result.stdout.split(/\r?\n/)) {
    const image = (platform === "win32" ? line.match(/^"([^"]+)"/)?.[1] : line.trim().split("/").pop()) || "";
    const key = image.toLowerCase().replace(/\.exe$/, "");
    if (key in counts) counts[key]++;
  }
  return { available: true, counts };
}

const hostOf = (value) => { try { return new URL(value).host; } catch (_) { return null; } };

export function createAgentService({ home = homedir(), env = process.env, platform = process.platform, runImpl = run, repoPaths = () => [], routerHost = "127.0.0.1:20128", appData = env.APPDATA, localAppData = env.LOCALAPPDATA } = {}) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  async function codex(ctx) {
    let version = null;
    let location = null;
    let versionSource = null;
    let state = "not-found";
    if (platform === "win32") {
      const appx = await runImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).Version"], { timeout: 10_000 });
      const v = appx.ok ? appx.stdout.trim() : "";
      if (/^\d+(\.\d+)+/.test(v)) { version = v; location = "Windows app package (OpenAI.Codex)"; versionSource = "installed package version"; state = "installed"; }
    }
    if (!version) {
      const cli = await runImpl("codex", ["--version"], { timeout: 6000 });
      const m = cli.ok ? cli.stdout.match(/(\d+\.\d+\.\d+[^\s]*)/) : null;
      if (m) { version = m[1]; location = "codex CLI on PATH"; versionSource = "codex --version"; state = "installed"; }
    }
    const configPath = join(home, ".codex", "config.toml");
    let config = null;
    try { config = parseCodexConfig(await readFile(configPath, "utf8"), routerHost); } catch (_) { /* absent or unreadable */ }
    if (state === "not-found" && (config || (await fileMtime(join(home, ".codex"))))) state = "config-only";
    const sessions = await newestMtime(join(home, ".codex", "sessions"), { depth: 3, filesOnly: true });
    const index = await fileMtime(join(home, ".codex", "session_index.jsonl"));
    const lastMs = Math.max(sessions?.ms ?? 0, index ?? 0) || null;
    const checks = [
      { id: "config-file", state: config ? "pass" : "warn", detail: config ? "~/.codex/config.toml readable (only allowlisted keys are read)" : "~/.codex/config.toml not found or unreadable" }
    ];
    if (config) {
      checks.push({
        id: "router-path", state: config.routedThroughRouter ? "pass" : "info",
        detail: config.routedThroughRouter ? "Codex model provider points at the local OmniRoute" : "Codex does not appear to route through OmniRoute; router usage figures will not include this tool's own requests"
      });
      checks.push({ id: "sandbox-approval", state: "info", detail: `approval_policy=${config.approvalPolicy ?? "default"}, sandbox_mode=${config.sandboxMode ?? "default"}` });
    }
    return {
      install: { state, version, versionSource: version ? versionSource : null, location },
      processNames: ["codex"],
      routingProviders: ["codex"],
      configuration: config ? { model: config.model, modelProvider: config.modelProvider, providers: config.providers } : null,
      usageCoverage: config ? (config.routedThroughRouter ? "routed-through-router" : "direct-not-routed") : "unknown",
      lastObserved: lastMs ? { at: iso(lastMs), source: "file modification time of ~/.codex/sessions and session_index.jsonl (contents not read)" } : null,
      project: { state: "not-exposed", reason: "Codex session working directories live inside session files, which ABUD does not read." },
      checks,
      nativeStatus: {
        supported: false,
        reason: "Codex /status is an interactive in-session command. No documented machine-readable local status interface was found, and ABUD does not read auth files or scrape its UI.",
        manual: ["Open Codex and run /status.", "Compare its session and weekly figures with the provider-reported values shown here.", "Record the figure in the manual reconciliation box; it stays on this device and is labelled as manual."]
      }
    };
  }

  async function antigravity() {
    let version = null;
    let state = "not-found";
    const exe = localAppData ? join(localAppData, "Programs", "Antigravity", "Antigravity.exe") : null;
    if (exe && (await fileMtime(exe))) {
      state = "installed";
      const info = await runImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { timeout: 10_000 });
      const v = info.ok ? info.stdout.trim() : "";
      if (/^\d+(\.\d+)+/.test(v)) version = v;
    }
    const logs = appData ? await newestMtime(join(appData, "Antigravity", "logs"), { depth: 2, filesOnly: true, limit: 200 }) : null;
    if (state === "not-found" && appData && (await fileMtime(join(appData, "Antigravity")))) state = "config-only";
    return {
      install: { state, version, versionSource: version ? "Antigravity.exe file version" : null, location: state === "installed" ? "per-user install" : null },
      processNames: ["antigravity"],
      routingProviders: ["antigravity", "agy"],
      configuration: null,
      usageCoverage: "router-account-quota",
      lastObserved: logs ? { at: iso(logs.ms), source: "file modification time of Antigravity application logs (contents not read)" } : null,
      project: { state: "not-exposed", reason: "No documented local interface exposes the active workspace of an Antigravity session." },
      checks: [{ id: "install", state: state === "installed" ? "pass" : "warn", detail: state === "installed" ? "Antigravity.exe present in the per-user install location" : "Antigravity install not found in the per-user location" }],
      nativeStatus: {
        supported: false,
        reason: "No documented machine-readable /usage or /quota interface was found locally. Quota is available only through OmniRoute's provider-reported relay for the connected Antigravity account.",
        manual: ["Open Antigravity and view its usage/quota panel (or run /usage where available).", "Compare with the per-group figures reported through OmniRoute.", "Record the figure in the manual reconciliation box; it is labelled as manual and stays on this device."]
      }
    };
  }

  async function claudeCode(ctx) {
    const cli = await runImpl("claude", ["--version"], { timeout: 8000 });
    const m = cli.ok ? cli.stdout.match(/(\d+\.\d+\.\d+)/) : null;
    const baseHost = hostOf(env.ANTHROPIC_BASE_URL);
    let settingsHost = null;
    try {
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
      settingsHost = hostOf(settings?.env?.ANTHROPIC_BASE_URL);
    } catch (_) { /* optional */ }
    const effective = baseHost || settingsHost;
    const projectsDir = join(home, ".claude", "projects");
    let latest = null;
    let project = { state: "not-exposed", reason: "No project folder could be matched to an authorized workspace repository." };
    try {
      const dirs = [];
      for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const s = await stat(join(projectsDir, entry.name)).catch(() => null);
        if (s) dirs.push({ name: entry.name, ms: s.mtimeMs });
      }
      dirs.sort((a, b) => b.ms - a.ms);
      latest = dirs[0] ?? null;
      const repos = repoPaths();
      for (const candidate of dirs.slice(0, 8)) {
        const rel = matchEncodedProject(candidate.name, repos);
        if (rel) {
          project = { state: "identified", repo: rel, at: iso(candidate.ms), reason: "Matched from the folder name Claude Code uses for its project store among the 8 most recently modified (no session contents read)." };
          break;
        }
      }
    } catch (_) { /* no project store */ }
    return {
      install: { state: m ? "installed" : "not-found", version: m ? m[1] : null, versionSource: m ? "claude --version" : null, location: m ? "claude CLI on PATH" : null },
      processNames: ["claude"],
      processNote: "claude.exe matches both Claude Code sessions and the Claude desktop app; the count is not a measure of active tasks.",
      routingProviders: [],
      configuration: effective ? { baseHost: effective } : null,
      usageCoverage: effective ? (effective === routerHost ? "routed-through-router" : "direct-not-routed") : "direct-not-routed",
      lastObserved: latest ? { at: iso(latest.ms), source: "modification time of the newest ~/.claude/projects folder (contents not read)" } : null,
      project,
      checks: [
        { id: "router-path", state: effective === routerHost ? "pass" : "info", detail: effective === routerHost ? "ANTHROPIC_BASE_URL points at the local OmniRoute" : "Claude Code is not configured to use the local OmniRoute (ANTHROPIC_BASE_URL unset or different)" }
      ],
      nativeStatus: { supported: false, reason: "Claude Code subscription usage is shown by its in-app /usage view; no documented local machine-readable interface was found.", manual: ["Run /usage inside Claude Code and note the figure for your records."] }
    };
  }

  const adapters = [
    { id: "codex", name: "Codex", run: codex },
    { id: "antigravity", name: "Google Antigravity", run: antigravity },
    { id: "claude-code", name: "Claude Code", run: claudeCode }
  ];

  /** `overview` is the router overview (or null/offline). */
  async function discover({ overview } = {}) {
    const results = await Promise.all(adapters.map(async (adapter) => {
      try { return { adapter, data: await adapter.run({}) }; } catch (_) { return { adapter, data: null }; }
    }));
    const processNames = [...new Set(results.flatMap((r) => r.data?.processNames ?? []))];
    const processes = await listProcessCounts(processNames, { runImpl, platform });
    const connections = overview?.connections ?? [];
    const routerUp = overview?.connection?.state === "connected";
    const agents = results.map(({ adapter, data }) => {
      if (!data) return { id: adapter.id, name: adapter.name, install: { state: "error" }, execution: EXECUTION_POLICY };
      const mine = connections.filter((c) => data.routingProviders.includes(c.provider));
      const worst = mine.flatMap((c) => c.quota?.windows ?? []).reduce((acc, w) => (STATE_RANK[w.state] > STATE_RANK[acc] ? w.state : acc), "unknown");
      const lockouts = (overview?.lockouts ?? []).filter((l) => data.routingProviders.includes(l.provider));
      const providerHealth = !data.routingProviders.length ? "not-applicable" : !routerUp ? "unknown" : !mine.length ? "not-connected"
        : !lockouts.length && mine.every((c) => c.active && c.routerHealth === "healthy" && (c.health24h?.state ?? "healthy") === "healthy") ? "healthy" : "degraded";
      const count = processes.counts[data.processNames[0]] ?? 0;
      const modelIds = data.routingProviders.flatMap((p) => overview?.models?.byProvider?.[p]?.ids ?? []);
      const modelCount = data.routingProviders.reduce((sum, p) => sum + (overview?.models?.byProvider?.[p]?.count ?? 0), 0);
      return {
        id: adapter.id, name: adapter.name, install: data.install,
        process: { running: processes.available ? count > 0 : null, count: processes.available ? count : null, source: "operating-system process list", note: data.processNote ?? null, meaning: "Process presence only; it does not mean the agent is working on a task." },
        provider: {
          routingProviders: data.routingProviders, health: providerHealth, source: "OmniRoute",
          connections: mine.map((c) => ({ shortId: c.shortId, provider: c.provider, active: c.active, routerHealth: c.routerHealth, health24h: c.health24h?.state ?? null, quotaState: c.quota?.state ?? "unknown" })),
          lockouts: lockouts.map((l) => ({ model: l.model, reason: l.reason, until: l.until }))
        },
        models: { count: modelCount, sample: modelIds.slice(0, 24), source: modelCount ? "OmniRoute /v1/models (router catalog, not a statement of what the agent itself can run)" : null },
        lastObserved: data.lastObserved,
        activeSession: { state: "not-exposed", reason: "No supported local interface exposes the live task/session of this agent." },
        recentErrors: { agent: "not-collected", provider: lockouts.length ? "see lockouts" : "none reported by router", reason: "Agent-side error logs are not read; only router-reported provider lockouts are shown." },
        project: data.project,
        configuration: data.configuration,
        usageCoverage: data.usageCoverage,
        quota: { source: mine.some((c) => c.quota?.support === "reported") ? "OmniRoute provider-reported relay" : "unavailable", state: mine.length ? worst : "unknown", connectionIds: mine.map((c) => c.shortId), nativeStatus: data.nativeStatus },
        configHealth: data.checks.some((c) => c.state === "fail") ? "attention" : data.checks.some((c) => c.state === "warn") ? "attention" : "ok",
        checks: data.checks,
        execution: EXECUTION_POLICY
      };
    });
    return { generatedAt: new Date().toISOString(), processListAvailable: processes.available, agents };
  }

  return { discover };
}
