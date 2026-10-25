/* SSH transport for the VPS Operations Center. Uses the Windows-hosted OpenSSH client with the owner's existing key by
 * path only (the key is never read, copied or returned). Every connection:
 *   - reads no ssh_config (-F none) and offers exactly one identity (IdentitiesOnly, BatchMode: never prompts);
 *   - verifies the host key against known_hosts (StrictHostKeyChecking=yes) AND against the fingerprint pinned in the host
 *     registry, parsed from ssh's own "Server host key" line, so a changed or substituted key fails closed;
 *   - disables agent/X11/port forwarding and allocates no TTY;
 *   - runs one fixed remote command (`bash -s`) whose script is sent on stdin — never a model- or browser-supplied string;
 *   - is bounded in connect time, total time and output size, and decodes output as UTF-8.
 * Errors are reduced to a safe category; raw stderr (which names local paths) never leaves this module. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const SSH_ERRORS = {
  "not-configured": "لم يُحدَّد مفتاح SSH لهذا الخادم في الإعداد المحلي",
  "ssh-client-missing": "عميل OpenSSH غير موجود على Windows",
  "host-key-unknown": "مفتاح الخادم غير موجود في known_hosts؛ لا يُقبل تلقائيًا",
  "host-key-changed": "مفتاح الخادم تغيّر عن المسجّل؛ أُوقف الاتصال (احتمال انتحال)",
  "host-key-mismatch": "بصمة مفتاح الخادم لا تطابق البصمة المثبّتة في سجل الخوادم",
  "auth-failed": "رفض الخادم مصادقة المفتاح",
  "connect-timeout": "انتهت مهلة الاتصال بالخادم",
  "unreachable": "الخادم غير قابل للوصول من هذا الجهاز (شبكة أو DNS أو منفذ)",
  "command-timeout": "انتهت مهلة تنفيذ الفحص على الخادم",
  "output-too-large": "تجاوز ناتج الفحص الحد المسموح",
  "remote-error": "انتهى الفحص على الخادم بخطأ",
  "ssh-failed": "فشل اتصال SSH لسبب غير مصنف"
};

const DEFAULT_SSH = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh";

/** Classifies ssh's stderr/exit status into one SSH_ERRORS key (255 is ssh's own failure; anything else is the script). */
export function classifySshFailure(stderr, code) {
  const s = String(stderr || "");
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(s)) return "host-key-changed";
  if (/No (?:ED25519 |RSA |ECDSA )?host key is known|Host key verification failed/i.test(s)) return "host-key-unknown";
  if (/Permission denied \(|Too many authentication failures/i.test(s)) return "auth-failed";
  if (/Connection timed out|Operation timed out|timed out during banner exchange/i.test(s)) return "connect-timeout";
  if (/Could not resolve hostname|Connection refused|No route to host|Network is unreachable|Connection reset|Connection closed by/i.test(s)) return "unreachable";
  return code === 255 ? "ssh-failed" : "remote-error";
}

/** The "debug1: Server host key: ssh-ed25519 SHA256:…" line (printed at LogLevel=DEBUG1, not at VERBOSE). */
export const serverFingerprint = (stderr) => String(stderr || "").match(/Server host key: (\S+) (SHA256:[A-Za-z0-9+/=]+)/)?.[2] ?? null;

/** Pure: the full argument vector for one connection. Nothing in it comes from a request body. */
export function sshArgs({ host, identityFile, knownHostsFile, connectTimeoutSec = 8 }) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(host.sshUser)) throw new Error("invalid-ssh-user");
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host.address)) throw new Error("invalid-address");
  return [
    "-F", "none", "-i", identityFile,
    "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "GlobalKnownHostsFile=none", "-o", "UpdateHostKeys=no",
    "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", `ConnectTimeout=${connectTimeoutSec}`, "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no",
    "-o", "LogLevel=DEBUG1", "-T", "-p", String(host.port), `${host.sshUser}@${host.address}`,
    "/bin/bash --noprofile --norc -s"
  ];
}

/** Creates a transport bound to local, owner-controlled settings. `exec(host, script, opts)` resolves
 * { ok, code, stdout, ms, fingerprint } or { ok:false, category, ms }; it never throws for remote failures. */
export function createSshTransport({ sshPath = DEFAULT_SSH, identityFor, knownHostsFile, spawnImpl = spawn, maxConcurrent = 2 } = {}) {
  let active = 0;
  const queue = [];
  const slot = () => new Promise((resolve) => { if (active < maxConcurrent) { active++; resolve(); } else queue.push(resolve); });
  const release = () => { const next = queue.shift(); if (next) next(); else active--; };

  async function exec(host, script, { timeoutMs = 25_000, maxBytes = 512 * 1024, connectTimeoutSec = 8 } = {}) {
    const started = Date.now();
    const identityFile = identityFor?.(host.id);
    if (!identityFile) return { ok: false, category: "not-configured", ms: 0 };
    if (spawnImpl === spawn && !existsSync(sshPath)) return { ok: false, category: "ssh-client-missing", ms: 0 };
    await slot();
    try {
      return await new Promise((resolve) => {
        let child;
        try { child = spawnImpl(sshPath, sshArgs({ host, identityFile, knownHostsFile, connectTimeoutSec }), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
        catch (_) { resolve({ ok: false, category: "ssh-client-missing", ms: Date.now() - started }); return; }
        const out = [];
        let outBytes = 0, err = "", settled = false, overflow = false;
        const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...value, ms: Date.now() - started }); };
        const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* already gone */ } done({ ok: false, category: "command-timeout" }); }, timeoutMs);
        child.stdout.on("data", (chunk) => {
          outBytes += chunk.length;
          if (outBytes > maxBytes) { overflow = true; try { child.kill(); } catch (_) { /* already gone */ } return; }
          out.push(chunk);
        });
        child.stderr.on("data", (chunk) => { if (err.length < 256 * 1024) err += chunk.toString("utf8"); });
        child.on("error", () => done({ ok: false, category: "ssh-client-missing" }));
        child.on("close", (code) => {
          if (overflow) return done({ ok: false, category: "output-too-large" });
          const fingerprint = serverFingerprint(err);
          // The pinned fingerprint is checked even when known_hosts accepted the key.
          if (fingerprint && host.hostKeyFingerprint && fingerprint !== host.hostKeyFingerprint) return done({ ok: false, category: "host-key-mismatch" });
          if (code === 255 || (!fingerprint && code !== 0)) return done({ ok: false, category: classifySshFailure(err, code) });
          if (!fingerprint) return done({ ok: false, category: "host-key-mismatch" });
          done({ ok: true, code, stdout: Buffer.concat(out).toString("utf8"), fingerprint });
        });
        child.stdin.on("error", () => { /* the remote end closed early; close/exit decides the outcome */ });
        child.stdin.end(script);
      });
    } finally { release(); }
  }
  return { exec };
}
