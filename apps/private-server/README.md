# ABUD OS V2.0 — Private Backend (Alpha, NOT DEPLOYED)

This server is a **separate, owner-only, authenticated application** intended for `https://os.abud.fun`. It is deliberately **not** included in the public GitHub Pages artifact. The existing static Universe continues to work unchanged.

## Implemented in this branch

- GitHub OAuth login (identity-only `read:user`), enforced numeric owner ID **and** login, one-time OAuth `state`, ten-minute expiry; GitHub user token discarded after verifying identity.
- Opaque database-backed, SHA-256-hashed 7-day session tokens using `__Host-` Secure, HttpOnly, SameSite cookies; server-side logout deletes the session.
- Same-origin + dedicated CSRF header on all private mutations; HTTPS origin required. Private API responses are `no-store`, with CSP, HSTS, no-referrer, no-sniff and clickjacking defense.
- Read-only GitHub App installation access, server-only signing key, fresh installation membership checks before every private STATUS.md read; no browser GitHub token, no organization-wide personal access token, no inferred access to uninstalled repos.
- PostgreSQL owner-scoped workspace persistence, optimistic revision check (409 conflict), task/event validation, and owner-specific data queries.
- Bilingual Arabic RTL / English LTR private responsive dashboard, authorized public/private repo listing, limited project focus, task tracking, STATUS.md field summaries.
- Node security tests for unauthenticated access, owner session validation, CSRF, origin checks, blocked repo access and concurrent editing conflicts.

## V2 Beta verification and owner workflow

**Status:** beta source code on Draft PR #1, NOT a working production login.

The owner dashboard now supports GitHub-App-authorized public/private repository cards, explicit owner-defined project stages, tasks, a bounded local-draft event journal, and manually authored decisions. Changes persist between devices **only after** the owner presses **Save to server**; the backend stores and version-checks them in PostgreSQL. The private application never uses browser `localStorage` for private project data.

**Optional migration from V1:** open the authenticated private dashboard and select a V1 Workboard JSON export. The owner must explicitly choose the file (max 80 KB), confirm replacement of the current unsaved draft, review the allowed project names/tasks, and press Save separately. The importer drops repos not installed in the authorized GitHub App and rejects obvious secret-looking entries. It does not automatically read another origin's browser storage. Owner should back up the previous state first.

**Security improvements:** single-use OAuth state verified through a complete mocked callback/login/logout test, selected-repository installation checks, revoked-permission fail-closed project/status/report reads, CSRF plus exact Origin checks, and a bounded in-process 20/minute OAuth request throttle. Nginx rate limits are still required in production. CI runs an actual isolated PostgreSQL 16 test and Chromium desktop/mobile UI smoke.

**Latest passing CI:** https://github.com/abudoxali/-abud-github-universe/actions/runs/37917892804 — 10/10 backend tests passed, 0 skipped, plus Chromium UI tests. This is **not** real GitHub OAuth validation or live private access.

## Required configuration: not available in the current GitHub connection

1. Register a dedicated GitHub OAuth App redirecting to `https://os.abud.fun/auth/callback`. Avoid any `repo` scope; identity-only `read:user`.
2. Register a separate **GitHub App** with selected-repository installation, **Contents: Read**, **Metadata: Read** (mandatory), optionally Actions: Read; no repository write permissions. Install it on the repositories the owner chooses.
3. Supply server-side-only `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, installation ID, private key path, numeric `GITHUB_OWNER_ID`, an isolated database and its connection string. Store sensitive configuration off-repo under restrictive permissions.
4. Point `os.abud.fun` DNS to the confirmed deployment host, configure a **new** Nginx TLS server block using an actual certificate, and proxy to the dedicated local app port. The user must connect a DNS service or supply an authorized automation channel; **GitHub access alone cannot edit Cloudflare DNS**.
5. Only after confirming the database target is a fresh isolated DB, apply `db/schema.sql`. Never apply migrations to an existing business database.
6. Install dependencies, run automated tests, start behind TLS, then test real owner login, unauthorized/incognito access, revoked app permission, live private repo read, cross-device saves, report confidentiality, rollback and database restore.

## Local testing

```bash
cd apps/private-server
npm install
npm test
npm run check
```

The tests use a fake database and GitHub client. They **do not** verify production OAuth, live private repositories, Nginx, DNS, or PostgreSQL.

## Domain and deployment

**Chosen target domain:** `os.abud.fun`.

**Private app status:** code available for staging review only. Not a live private product, not a full V2.0 release.

The public GitHub Pages site cannot offer private data confidentially. Do not copy authenticated API JSON, private GitHub responses, or user secrets into public `data.js`.

See `/docs/V2_SECURE_WORKSPACE.md` for the completion and security acceptance contract.
