# ABUD OS V2 private deployment — **NOT EXECUTED**

Target hostname: **os.abud.fun** (chosen). No DNS change, SSH login or deployment was performed by the GitHub coding connector.

> Gate: This application cannot be considered live without the server credentials, authorized GitHub OAuth/App setup and independent production verification. Never run destructive commands against another project or database.

## 1. Diagnostics before mutation

- Identify the **actual current VPS** from a current server handoff. Old saved IPs may be outdated; do not assume a historical address is still correct.
- Read existing Nginx server names, PM2 processes, systemd units and PostgreSQL databases **without changing them**. Confirm `os.abud.fun` and candidate internal port `3164` are unused.
- Identify the DNS provider for `abud.fun`, existing A/AAAA/CNAME records and Cloudflare proxy state. Establish approved DNS write access or arrange the change with the owner.
- Verify Node.js >=22, PostgreSQL >=16, TLS certificate issuer, firewall, available memory and backup routines.
- Confirm GitHub App registration uses **selected repositories** and no write permissions. OAuth App must request `read:user` only. The numeric owner GitHub ID must match exactly.

## 2. New isolated resources

- Create `/var/www/abud-os/releases/<timestamp>` and `/var/www/abud-os/current` symlink; deploy from the reviewed repository commit/package, **not a blind git pull**, and keep a rollback release.
- Create a dedicated OS service account `abudos`; do not grant it other apps' files or databases.
- Create a fresh local PostgreSQL database `abud_os` with a unique limited-privilege role. Verify `SELECT current_database(), current_user` matches the newly created target **before** running `db/schema.sql`. Never migrate an existing app DB.
- Store environment variables outside the repository, for example `/etc/abud-os/private.env`, owner/group permissions allowing only the dedicated service account; store the GitHub App PEM separately in a protected path. Neither must be committed, echoed, attached to logs or uploaded to the public site.
- Install Node dependencies reproducibly from the reviewed lockfile with `npm ci`, then run `npm test && npm run check`. Production installs should use `npm ci --omit=dev`.
- Start a new isolated service using `abud-os-private.service.example`, adjusted to the verified system's Node executable and release path. This uses systemd rather than sharing an existing PM2 process namespace with unrelated services; do not replace other units.
- Apply `nginx.os.abud.fun.conf.example` as a **new** Nginx server name only after acquiring a real certificate; verify with `nginx -t` before reload.
- Create the `os` DNS record at the correct provider, pointing to the **verified** host. DNS and certificate steps require real account access; they cannot be accomplished by merely editing GitHub files.

## 3. Live authorization and privacy acceptance

Test using a real owner GitHub identity and a deliberately selected test private repository:

- `https://os.abud.fun/health/live` returns `{"status":"ok"}` over valid TLS.
- Unauthorized incognito `GET /api/repos`, `/api/workboard`, `/api/repos/<private>/status` returns 401 with no private names/content.
- User from any other GitHub account is denied after OAuth callback.
- Owner login and server-side session succeed, selected installed repo is present, uninstalled repo is absent.
- Private STATUS file fields display as **source claims**, without executing Markdown instructions or exposing tokens.
- Origin/CSRF violations are denied. Logout invalidates the DB-backed session. Revoking a repo's App installation removes it from subsequent reads.
- Workboard saves on one browser and loads on a second one after authentication. Concurrent revision conflict returns 409 and no silent overwrite.
- No private API response is cached by CDN/browser (`Cache-Control: no-store`), the public Pages site has no private names, and private data is never logged.
- Verify PostgreSQL backup **and restore**, app restart, TLS renewal and rollback to the previous `current` symlink.
- Manually inspect Arabic RTL and English LTR UI on desktop and mobile.

## 4. Release criteria and ownership

Passing automated CI with fake OAuth/GitHub and an ephemeral PostgreSQL service is **not** a substitute for the real checklist above. Do not change root `STATUS.md` to READY until all live checks and owner approval are recorded.

No production secrets, tokens, SSH keys, passwords or private metadata should ever appear in `STATUS.md`, GitHub Issues, public PRs, logs or diagnostic commands.

Production deployment report (once real deployment exists) must include: verified hostname and HTTPS, safe release path and rollback command, service status, Nginx vhost, private internal port, isolated DB identification (not password), OAuth/App permission verification, unauthorized request tests, and owner acceptance.
