/* Read-only VPS probes: fixed bash scripts built only from validated host-profile values (never from a request body or a
 * model), and pure parsers that turn their output into bounded, sanitized structures. Scripts print sections delimited by
 * "@@name" lines. Nothing here mutates the server. Remote output is untrusted data and is parsed, never interpreted. */

const RX = {
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  service: /^[a-z0-9][a-z0-9_.-]{0,63}$/,
  unit: /^[a-z0-9][a-z0-9@_.-]{0,63}$/,
  base: /^\/var\/www\/[a-z0-9._-]{1,64}$/,
  db: /^[a-z_][a-z0-9_]{0,62}$/
};
const need = (value, rx, what) => { if (typeof value !== "string" || !rx.test(value)) throw new Error(`invalid-profile-${what}`); return value; };

/** Validates a host profile; returns the normalized profile or throws. */
export function normalizeProfile(profile = {}) {
  const environments = {};
  for (const [env, def] of Object.entries(profile.environments || {})) {
    if (!["production", "staging"].includes(env)) throw new Error("invalid-profile-environment");
    let url = null;
    if (def.url) { const u = new URL(def.url); if (u.protocol !== "https:" || u.username || u.password) throw new Error("invalid-profile-url"); url = u.origin; }
    environments[env] = { base: def.base ? need(def.base, RX.base, "base") : null, url, healthPath: def.healthPath && /^\/[a-z0-9/_-]{0,60}$/.test(def.healthPath) ? def.healthPath : null,
      expected: ["active", "retired"].includes(def.expected) ? def.expected : "active", note: typeof def.note === "string" ? def.note.slice(0, 200) : null };
  }
  const pm2 = (profile.pm2 || []).map((group) => ({ user: need(group.user, RX.user, "user"),
    services: (group.services || []).map((s) => ({ name: need(s.name, RX.service, "service"), environment: environments[s.environment] ? s.environment : "production" })) }));
  return {
    environments, pm2,
    systemd: (profile.systemd || []).map((u) => need(u, RX.unit, "unit")),
    databases: (profile.databases || []).map((d) => need(d, RX.db, "db"))
  };
}

const q = (value) => `'${String(value).replace(/'/g, "")}'`; // values are regex-validated; quoting is defence in depth

// One python filter for `pm2 jlist`: only non-secret fields leave the server (pm2_env also carries environment values).
const PM2_FILTER = `python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("pm2-unreadable"); sys.exit(0)
for p in d:
  e=p.get("pm2_env",{}); m=p.get("monit",{})
  print("\\t".join(str(x) for x in [p.get("name"), e.get("status"), e.get("restart_time"), e.get("unstable_restarts"), e.get("pm_uptime"), m.get("memory"), m.get("cpu"), e.get("exec_mode")]))'`;

export function basicScript(profile) {
  const lines = [
    "export LC_ALL=C TZ=UTC",
    "echo @@hostname; hostname",
    "echo @@machine; sha256sum /etc/machine-id 2>/dev/null | cut -c1-16",
    "echo @@os; . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"; uname -r",
    "echo @@uptime; cat /proc/uptime",
    "echo @@load; cat /proc/loadavg; nproc",
    "echo @@cpu; head -1 /proc/stat; sleep 1; head -1 /proc/stat",
    "echo @@mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    "echo @@df; df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | tail -n +2",
    "echo @@systemd"
  ];
  for (const unit of profile.systemd) lines.push(`printf '%s %s\\n' ${q(unit)} "$(systemctl is-active ${q(unit)} 2>/dev/null)"`);
  lines.push("echo @@failed; systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -20");
  for (const group of profile.pm2) lines.push(`echo @@pm2:${group.user}; timeout 15 su -s /bin/bash ${q(group.user)} -c 'pm2 jlist' 2>/dev/null | ${PM2_FILTER}`);
  return lines.join("\n") + "\n";
}

export function inventoryScript(profile) {
  const lines = ["export LC_ALL=C TZ=UTC"];
  for (const [env, def] of Object.entries(profile.environments)) {
    if (!def.base) continue;
    lines.push(`echo @@deploy:${env}`,
      `readlink -f ${q(`${def.base}/current`)} 2>/dev/null || echo -`,
      `python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1]+"/.release-meta.json"))
  print(d.get("commitSha") or "-"); print(d.get("branch") or "-"); print(d.get("deployedAt") or "-")
except Exception: print("-"); print("-"); print("-")' ${q(`${def.base}/current`)}`,
      `ls -1 ${q(`${def.base}/releases`)} 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}$' | tail -n 12`);
  }
  lines.push("echo @@pg; pg_isready -q 2>/dev/null && echo accepting || echo not-accepting",
    "sudo -u postgres psql -XAtqc 'show server_version' 2>/dev/null | head -1",
    "sudo -u postgres psql -XAtqc 'select count(*) from pg_stat_activity' 2>/dev/null | head -1");
  for (const db of profile.databases) lines.push(`printf 'db %s %s\\n' ${q(db)} "$(sudo -u postgres psql -XAtqc "select pg_database_size('${db}')" 2>/dev/null | head -1)"`);
  lines.push("echo @@nginx; nginx -v 2>&1 | head -1; ts=$(systemctl show nginx -p ActiveEnterTimestamp --value 2>/dev/null); [ -n \"$ts\" ] && date -u -d \"$ts\" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo -");
  lines.push("echo @@boots; journalctl --list-boots --no-pager 2>/dev/null | tail -n 3 | awk '{print $4\"T\"$5\"Z\"}'");
  return lines.join("\n") + "\n";
}

/** Allowlisted Tier-1 diagnostics (read-only). Keys are the only accepted inputs. */
export const DIAGNOSTICS = {
  "nginx-config-test": { ar: "فحص صحة إعداد Nginx (nginx -t)", script: () => "nginx -t 2>&1 | tail -n 4" },
  "failed-units": { ar: "خدمات systemd الفاشلة", script: () => "systemctl --failed --no-legend --plain 2>/dev/null | head -20" },
  "pm2-restarts": { ar: "عدادات إعادة تشغيل PM2", script: (p) => p.pm2.map((g) => `echo @@pm2:${g.user}; timeout 15 su -s /bin/bash ${q(g.user)} -c 'pm2 jlist' 2>/dev/null | ${PM2_FILTER}`).join("\n") },
  "postgres-health": { ar: "حالة PostgreSQL (اتصالات حسب الحالة، بلا بيانات)", script: () => "pg_isready 2>&1; sudo -u postgres psql -XAtqc \"select coalesce(state,'background'), count(*) from pg_stat_activity group by 1 order by 2 desc\" 2>/dev/null | head -10" },
  "disk-usage": { ar: "استخدام الأقراص والإنودات", script: () => "df -P -h -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null; df -P -i / 2>/dev/null | tail -1" },
  "network-summary": { ar: "ملخص منافذ الشبكة (عدد فقط)", script: () => "ss -s 2>/dev/null | head -8" },
  "recent-boots": { ar: "آخر مرات الإقلاع", script: () => "journalctl --list-boots --no-pager 2>/dev/null | tail -n 5" }
};
export function diagnosticScript(profile, key) {
  const def = DIAGNOSTICS[key];
  if (!def) throw new Error("unknown-diagnostic");
  return `export LC_ALL=C TZ=UTC\n${def.script(profile)}\n`;
}

/** Allowlisted log sources. Output is redacted locally and capped; complete raw logs are never returned. */
export const LOG_SOURCES = {
  "nginx-error": { ar: "أخطاء Nginx (سطور تخص elhabak فقط)", lines: 30 },
  "pm2-error": { ar: "سجل أخطاء خدمة PM2", lines: 25, needsService: true },
  "system-warnings": { ar: "تحذيرات النظام آخر 6 ساعات", lines: 30 }
};
export function logScript(profile, source, service = null) {
  if (source === "nginx-error") return "export LC_ALL=C TZ=UTC\ntail -n 2000 /var/log/nginx/error.log 2>/dev/null | grep -i 'elhabak' | tail -n 60\n";
  if (source === "system-warnings") return "export LC_ALL=C TZ=UTC\njournalctl -p warning --since '-6 hours' --no-pager -o short-iso -q 2>/dev/null | tail -n 60\n";
  if (source === "pm2-error") {
    const group = profile.pm2.find((g) => g.services.some((s) => s.name === service));
    if (!group) throw new Error("unknown-service");
    return `export LC_ALL=C TZ=UTC\ntimeout 15 su -s /bin/bash ${q(group.user)} -c ${q(`pm2 jlist`)} 2>/dev/null | python3 -c 'import json,sys
for p in json.load(sys.stdin):
  if p.get("name")==sys.argv[1]: print(p.get("pm2_env",{}).get("pm_err_log_path") or "")' ${q(service)} | head -1 | xargs -r -I{} tail -n 60 {}\n`;
  }
  throw new Error("unknown-log-source");
}

// ------------------------------------------------------------------ parsing
export function sections(stdout) {
  const out = {};
  let key = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^@@([a-z0-9:_.-]+)$/i);
    if (m) { key = m[1]; out[key] = []; continue; }
    if (key) out[key].push(line);
  }
  for (const k of Object.keys(out)) while (out[k].length && out[k].at(-1) === "") out[k].pop();
  return out;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (part, whole) => (Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function parsePm2(lines = []) {
  if (lines[0] === "pm2-unreadable") return { readable: false, processes: [] };
  const processes = lines.filter(Boolean).map((line) => {
    const [name, status, restarts, unstable, uptimeMs, memory, cpu, mode] = line.split("\t");
    return { name, status, restarts: num(restarts), unstableRestarts: num(unstable), startedAt: num(uptimeMs) ? new Date(Number(uptimeMs)).toISOString() : null,
      memoryMb: num(memory) != null ? Math.round(Number(memory) / 1048576) : null, cpuPct: num(cpu), mode: mode || null };
  }).filter((p) => p.name && RX.service.test(p.name));
  return { readable: lines.length > 0, processes };
}

export function parseBasic(stdout) {
  const s = sections(stdout);
  const [cpuA, cpuB] = (s.cpu || []).map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  let cpuPct = null;
  if (cpuA?.length >= 4 && cpuB?.length >= 4) {
    const total = (a) => a.slice(0, 8).reduce((x, y) => x + (y || 0), 0);
    const idle = (a) => (a[3] || 0) + (a[4] || 0);
    const dt = total(cpuB) - total(cpuA);
    cpuPct = dt > 0 ? Math.round((1 - (idle(cpuB) - idle(cpuA)) / dt) * 1000) / 10 : null;
  }
  const mem = Object.fromEntries((s.mem || []).map((l) => { const m = l.match(/^(\w+):\s+(\d+)/); return m ? [m[1], Number(m[2]) * 1024] : null; }).filter(Boolean));
  const [load1, load5, load15] = (s.load?.[0] || "").split(/\s+/).map(num);
  const filesystems = (s.df || []).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 6).map((p) => ({ device: p[0], mount: p[5], totalBytes: num(p[1]), usedBytes: num(p[2]), availBytes: num(p[3]), usedPct: num(String(p[4]).replace("%", "")) }));
  const root = filesystems.find((f) => f.mount === "/") || null;
  const pm2 = Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith("pm2:")).map(([k, v]) => [k.slice(4), parsePm2(v)]));
  return {
    hostname: s.hostname?.[0]?.trim() || null, machine: s.machine?.[0]?.trim() || null,
    os: s.os?.[0]?.trim() || null, kernel: s.os?.[1]?.trim() || null,
    uptimeSec: num(s.uptime?.[0]?.split(/\s+/)[0]) != null ? Math.round(Number(s.uptime[0].split(/\s+/)[0])) : null,
    cpu: { pct: cpuPct, load1, load5, load15, cores: num(s.load?.[1]) },
    memory: { totalBytes: mem.MemTotal ?? null, availableBytes: mem.MemAvailable ?? null, usedPct: mem.MemTotal ? pct(mem.MemTotal - mem.MemAvailable, mem.MemTotal) : null,
      swapTotalBytes: mem.SwapTotal ?? null, swapUsedPct: mem.SwapTotal ? pct(mem.SwapTotal - mem.SwapFree, mem.SwapTotal) : 0 },
    disk: root ? { mount: "/", totalBytes: root.totalBytes, usedBytes: root.usedBytes, availBytes: root.availBytes, usedPct: root.usedPct } : null,
    filesystems: filesystems.slice(0, 8).map(({ mount, totalBytes, usedBytes, availBytes, usedPct }) => ({ mount, totalBytes, usedBytes, availBytes, usedPct })),
    systemd: Object.fromEntries((s.systemd || []).map((l) => l.trim().split(/\s+/)).filter((p) => RX.unit.test(p[0] || "")).map(([unit, state]) => [unit, state || "unknown"])),
    failedUnits: (s.failed || []).map((l) => l.trim()).filter((u) => RX.unit.test(u)).slice(0, 20),
    pm2
  };
}

export function parseInventory(stdout) {
  const s = sections(stdout);
  const deployments = {};
  for (const [key, lines] of Object.entries(s)) {
    if (!key.startsWith("deploy:")) continue;
    const [current, sha, branch, deployedAt, ...releases] = lines.map((l) => l.trim());
    const clean = (v) => (v && v !== "-" ? v : null);
    deployments[key.slice(7)] = {
      currentRelease: clean(current)?.match(/^\/var\/www\/[\w./-]+$/) ? current : null,
      commitSha: /^[0-9a-f]{7,40}$/.test(sha || "") ? sha : null,
      branch: clean(branch) && /^[\w./-]{1,100}$/.test(branch) ? branch : null,
      deployedAt: clean(deployedAt) && !Number.isNaN(Date.parse(deployedAt)) ? new Date(deployedAt).toISOString() : null,
      releases: releases.filter((r) => /^\d{8}-\d{6}$/.test(r))
    };
  }
  for (const d of Object.values(deployments)) {
    const name = d.currentRelease?.split("/").at(-1) ?? null;
    d.currentName = name;
    d.rollbackCandidate = d.releases.filter((r) => r !== name && (!name || r < name)).at(-1) ?? null;
  }
  const pg = s.pg || [];
  const databases = pg.filter((l) => l.startsWith("db ")).map((l) => { const [, name, bytes] = l.split(/\s+/); return { name, bytes: num(bytes) }; }).filter((d) => RX.db.test(d.name || ""));
  return {
    deployments,
    postgres: { accepting: pg[0] === "accepting", version: pg[1] && /^[\d.]+/.test(pg[1]) ? pg[1].trim().slice(0, 60) : null, connections: num(pg[2]), databases },
    nginx: { version: (s.nginx?.[0] || "").replace(/^nginx version:\s*/, "").slice(0, 60) || null, activeSince: /^\d{4}-\d{2}-\d{2}T[\d:]{8}Z$/.test(s.nginx?.[1] || "") ? s.nginx[1] : null },
    recentBoots: (s.boots || []).map((l) => l.trim()).filter((l) => /^\d{4}-\d{2}-\d{2}T[\d:]{8}Z$/.test(l)).slice(-3)
  };
}

// ------------------------------------------------------------------ redaction of remote text (logs, diagnostics)
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "[jwt]"],
  [/\b(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*[:=]\s*[^\n]*/gi, "$1: [redacted]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session|sid|otp)\b\s*[:=]\s*["']?[^\s"'&,;]+/gi, "$1=[redacted]"],
  [/\b[a-z]+:\/\/[^\s:@/]+:[^\s@/]+@/gi, "[scheme]://[credentials]@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\?[^\s"']+/g, "?[query]"],
  [/\/var\/www\/[\w.-]+\/shared\/[^\s"',)]*/g, "[shared-path]"],
  [/[^\s"']*\.env\b[^\s"']*/g, "[env-file]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, "[token]"],
  [/(?<![\d:.-])\+?\d{10,15}(?![\d:.-])/g, "[number]"]
];
export function redactRemote(text, { maxLines = 30, maxLineChars = 220 } = {}) {
  const lines = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split(/\r?\n/).filter((l) => l.trim());
  const kept = lines.slice(-maxLines).map((line) => {
    let out = line;
    for (const [rx, rep] of REDACTIONS) out = out.replace(rx, rep);
    return out.length > maxLineChars ? `${out.slice(0, maxLineChars)}…` : out;
  });
  return { totalLines: lines.length, shown: kept.length, lines: kept, errorLike: lines.filter((l) => /\b(error|crit|alert|emerg|fatal|exception|failed)\b/i.test(l)).length };
}

// ------------------------------------------------------------------ public website / TLS checks (from Windows, not SSH)
export function classifySite(expected, status, body) {
  if (status == null) return "unreachable";
  if (expected === "retired") return status === 410 ? "retired" : status === 401 ? "protected" : status >= 500 ? "degraded" : "unexpected";
  if (status === 401) return "protected";
  if (status >= 500) return "down";
  if (status !== 200) return "degraded";
  if (body && typeof body === "object") {
    if (body.status && body.status !== "ok") return "degraded";
    if (body.database && body.database !== "connected") return "degraded";
  }
  return "ok";
}
