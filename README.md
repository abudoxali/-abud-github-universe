# ABUD GitHub Universe

ABUD GitHub Universe is a bilingual visual map of the owner's GitHub projects, with a local-first layer for organizing real Git checkouts into explicit worlds.

## ABUD FUN Company OS: daily Windows use

Double-click `Start-ABUD-OS.cmd` in this checkout. It starts the native Node.js bridge on `http://127.0.0.1:4172`, waits for its health endpoint, and opens the browser. It requires Node.js 22.13+ and the existing `local/company.db`. It does not install dependencies or run tests at startup. The bridge uses the existing OmniRoute environment/configuration and never changes OmniRoute's settings.

Other actions (first argument of `Start-ABUD-OS.cmd`, or `./ABUD-OS.ps1 -Action <name>`):

| Action | What it does |
|---|---|
| `status` | Health, PID, uptime, memory, OmniRoute state, and how the previous session ended |
| `stop` / `restart` | Graceful stop (and start). Add `-Force` only if the app no longer answers: it then terminates that same verified bridge PID |
| `shortcut` | Creates a desktop shortcut |
| `autostart-on` / `autostart-off` / `autostart-status` | Start at Windows sign-in through a shortcut in your own Startup folder (no admin, no service). The shortcut runs `start -AtSignIn` |

**Sign-in start (`-AtSignIn`)**: up to three start attempts (5/15/45 s apart), the browser opened at most once and only if System → نظرة عامة → «فتح المتصفح عند الدخول» is on (stored in ignored `local/launcher.json`), then one hidden supervisor. The supervisor restarts the bridge only after an unclean exit (crash or external kill), at most three times per hour, and never after an owner `stop`/`stop -Force`. Attempts, successes, failures and supervisor restarts are written to ignored `local/runtime/launcher-state.json` and `local/logs/launcher.log`, and shown in System Center.

**OmniRoute at sign-in** uses OmniRoute's own supported mechanism, `omniroute autostart enable` (a hidden `OmniRoute.vbs` in the same Startup folder running `omniroute serve --no-open --tray`; it refuses to start a second instance when port 20128 is taken). The bridge never blocks on the router: it serves the company immediately, shows OmniRoute as offline, and the agents become available when the router answers. System → نظرة عامة shows both autostart states, the router's last successful connection and last failure, and offers enable/disable, «إعادة محاولة الاتصال» and «تشغيل OmniRoute» (`omniroute serve --daemon --no-open --no-tray`, only while it is offline). Recovery by hand:

```powershell
omniroute serve --daemon --no-open --no-tray   # start the router now
omniroute autostart status                      # or: enable / disable
.\Start-ABUD-OS.cmd status                      # bridge, router, database
.\Start-ABUD-OS.cmd autostart-off               # stop starting Company OS at sign-in
```

The launcher controls only the bridge PID it started (verified by command line and by the PID the health endpoint reports). It never touches OmniRoute or other Node.js processes and refuses to stop an unrelated listener. A stale PID file left by a crash or Windows restart is discarded without touching whatever process now owns that PID. Logs are saved under ignored `local/logs/` (the newest 30 starts are kept). `-NoBrowser` suppresses browser opening. No administrator privileges are needed.

The bridge keeps a heartbeat in ignored `local/runtime/bridge-state.json`. If a session ends without a clean stop, the next start classifies it as a Windows restart, a logged fatal error, or an unexplained termination. It records that in the activity log and, except for a Windows restart, raises a notification. System → نظرة عامة shows the result.

The internal Company OS has six Arabic workspaces: الرئيسية، المشاريع، العمل، الوكلاء، الموارد الذكية، النظام. Its SQLite database and backups stay under ignored `local/`. Project details show local Git state separately from read-only GitHub CLI data. GitHub intelligence requires an authenticated `gh` CLI; unavailable data is shown as unavailable. Backups are integrity checked. System → البيانات والنسخ → **اختبار الاستعادة** copies a backup into a temporary folder, opens it, compares its records with the live store, and deletes the copy; the live database is never replaced. GitHub-confirmed account renames and repository transfers are folded into one project identity automatically (read-only `gh api` lookups).

### VPS Operations Center (النظام → السيرفرات)

Hosts are registered in ignored `local/vps.json` (copy `local/vps.example.json`): address, SSH user, the pinned ED25519 host-key fingerprint (`ssh-keygen -F <address> -l`), the expected hostname, the linked project, the path of an SSH key that already works for that host, and a profile listing the PM2 services, systemd units, release folders and public URLs to watch. The key is used by path only; it is never read, copied, stored in SQLite, returned to the browser or sent to OmniRoute. The public repository contains only synthetic example host data, with no real server address or key path.

- **Transport:** Windows OpenSSH with `-F none`, one identity, `BatchMode`, `StrictHostKeyChecking=yes` against your `known_hosts`, the pinned fingerprint checked on every connection, no agent/X11/port forwarding, no TTY, bounded time and output. The remote command is always `bash -s`; the script comes from a fixed library built only from validated profile values. A changed or substituted host key fails closed.
- **Monitoring (no AI):** every 60 s one read-only probe (CPU sample, memory, swap, disks, uptime, systemd units, PM2 state filtered on the server so environment values never leave it); every 15 min the release/commit inventory, PostgreSQL availability and database sizes (no business data); HTTPS health every 2 min and TLS expiry every 6 h from this machine. No overlapping probes per host; failures back off up to 10 min. Raw samples are kept 3 days and rolled up hourly for 120 days; observations are kept 30 days.
- **Incidents:** debounced (e.g. 3 failed SSH checks for "unreachable", 2 for a stopped production service, 5 sustained readings for CPU/memory), deduplicated (one notification and one owner task per unresolved condition), and closed automatically on recovery. A failed SSH check never marks a service stopped; the last verified state is shown with its age. A retired environment answering HTTP 410, or a protected one answering 401, is not an outage.
- **Agents:** all six can read health, metrics, services, deployment and recent events (`vps.*` tools). ORI, NEX, REX and ZEN can run allowlisted read-only diagnostics; ORI, REX and ZEN can read bounded, redacted logs; ORI, NEX and REX can propose actions. No tool accepts a command. ORI's **تقييم البنية التحتية** workflow has NEX gather telemetry and REX review security indicators (both without AI), then ORI writes one assessment and LUNA files deduplicated follow-up tasks. Server-related chat requests receive fresh infrastructure evidence automatically.
- **Actions:** only *restart one PM2 service* and *reload Nginx after `nginx -t`* exist. An agent or the owner proposes; the owner types the exact target to approve; the bridge issues a single-use token valid 5 minutes, takes a per-host lock, re-verifies the host, runs the one command, and marks success only after post-checks (PM2 online with a newer start time, or Nginx active, plus public health). Deployment, rollback, migrations, Nginx edits, firewall/SSH changes, release deletion and database restore are refused by this path.

`maxCostUsd` is checked after a paid response because the router reports its cost only then. If the cap is exceeded or cost is unknown, later paid requests in that domain pause until owner acknowledgement. It cannot guarantee a spending ceiling for the request already sent. Paid routes still require per-run approval.

To archive a task, open its details in Work Hub and choose **أرشفة المهمة**. Confirm the action. Archived tasks remain in SQLite and appear under **العمل → المنجزة → الأرشيف**, where they can be restored. Tasks with an active agent run cannot be archived.

## What remains

- Interactive repository map, filters, relationships and Project Hub.
- Public GitHub metadata refresh for `abudoxali`.
- Device-local Workboard, journal and reports.
- Local worlds loaded from `local/worlds.json`.
- Read-only local Git status: branch, clean/dirty state, changed-file count, last commit and GitHub remote matching.

There is no in-app login, OAuth flow, local PostgreSQL data store, GitHub App or GitHub write operation.

## Local worlds

The browser cannot read arbitrary folders on the computer by itself. The optional Local Bridge serves the Universe on loopback and reads only the explicitly configured Git folders.

```powershell
Copy-Item local/worlds.example.json local/worlds.json
# Edit local/worlds.json and replace each project path and GitHub owner/repository.
cd apps/local-bridge
npm test
npm start
```

Open http://127.0.0.1:4170. The local worlds panel appears only on localhost. `local/worlds.json` is ignored by Git; only the example configuration is committed.

The bridge optionally reads the signed-in GitHub CLI account with `gh api user`. It never returns a token or local file contents. Install and authenticate GitHub CLI separately if you want the account badge; configured Git remotes work without it.

## ABUD FUN Company OS (internal, loopback only)

When the Local Bridge is running, the Universe becomes **ABUD FUN Company OS**, an Arabic-first (RTL) internal platform with six areas: الرئيسية, المشاريع, العمل, الوكلاء, الموارد الذكية, and النظام. These views are served only by the bridge from `internal/` and are **not** part of the GitHub Pages artifact. The public site is unchanged.

Company data (projects, tasks, agents, runs, budgets, routing policies, quota history, activity, notifications, approvals and memory) is stored durably in `local/company.db` (SQLite via Node's built-in `node:sqlite`, ignored by Git). Backups go to `local/backups/`.

```powershell
# Node.js 22.13+ (node:sqlite). The router key stays in the bridge's environment; it never reaches the browser or the database.
$env:OMNIROUTE_API_KEY = "<key from the OmniRoute dashboard>"
# optional: $env:OMNIROUTE_BASE_URL = "http://127.0.0.1:20128"
# optional, off by default: allow owner-APPROVED OmniRoute settings changes (PATCH /api/settings) to be applied
# $env:ABUD_ROUTER_WRITES = "1"

Copy-Item local/workspace.example.json local/workspace.json   # authorize your repositories folder ("roots")

cd apps/local-bridge
npm test
npm start            # http://127.0.0.1:4170 (daily use: Start-ABUD-OS.cmd on 4172)
cd ../..
node tests/ops.mjs      # browser checks on synthetic data
node tests/stress.mjs   # load, aborted clients, router outage/recovery in a child bridge (STRESS_HEAP=1 adds post-GC heap)
node tests/visual.mjs   # read-only screenshot sweep of a RUNNING bridge at five widths
```

Security model: the bridge binds to `127.0.0.1` and rejects foreign `Host`/`Origin` headers and cross-site requests. Company writes need a per-process session token, which only same-origin pages can read, plus a JSON body. Agent tool permissions are enforced on the server. There is no shell execution, arbitrary file access or open network tool. Paid inference and OmniRoute setting changes require explicit owner approval, and Google Antigravity consumer connections are never used by company agents. Nothing is written to GitHub or repositories.

## Static preview

```powershell
python -m http.server 8000
```

This serves the public Universe only. It does not expose local worlds because the Local Bridge API is not running there.

## Architecture

- `index.html`, `styles.css` — bilingual Universe shell and visual system
- `data.js`, `app.js` — curated public catalog and public GitHub reconciliation
- `command-center.js`, `intelligence.js`, `decisions.js` — public project evidence and relationships
- `workboard.js`, `reports.js` — browser-local execution notes and reports
- `local-worlds.js`, `local-worlds.css` — localhost-only local worlds UI
- `apps/local-bridge/src/git.mjs` — config validation and read-only Git metadata
- `apps/local-bridge/src/server.mjs` — loopback static server, host/origin guard and local API
- `apps/local-bridge/src/omniroute.mjs` — allowlisted read-only OmniRoute adapter and quota/usage normalizers
- `apps/local-bridge/src/agents.mjs` — Codex / Antigravity / Claude Code discovery adapters
- `apps/local-bridge/src/workspace.mjs` — read-only repository discovery with per-repository cache
- `apps/local-bridge/src/policy.mjs` — validated advisory quota/routing policy
- `apps/local-bridge/src/db.mjs` — SQLite company store, migrations, backups
- `apps/local-bridge/src/company.mjs` — company domain: projects, tasks, agents, budgets, policies, quota history, activity, notifications, approvals, memory
- `apps/local-bridge/src/catalog.mjs` — the six AI employees, tool registry, policy domains, provider billing classes
- `apps/local-bridge/src/runtime.mjs` — agent runtime: permission-checked tools, quota/budget/compliance-aware routing, run queue, multi-agent workflow, approval-gated router changes
- `apps/local-bridge/src/nex.mjs` — NEX recommendations and the bounded quota-snapshot/notification loop
- `internal/` — loopback-only Company OS views and agent artwork (not deployed to Pages)
- `local/worlds.example.json` — safe configuration template
- `.github/workflows/pages.yml` — public static validation and Pages deployment

## Safety boundary

The public catalog contains public repositories only. Local paths, private project names, credentials and file contents do not belong in `data.js`, the Pages artifact or committed configuration. The Local Bridge binds to `127.0.0.1` and exposes sanitized metadata only.

## License

Dashboard code is MIT licensed. Linked projects retain their own licenses and client rights.
