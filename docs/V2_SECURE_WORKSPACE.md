# ABUD OS V2.0 — Secure Private Workspace: Release Contract

**Status:** Architecture and acceptance contract only. The V2.0 private backend, authorization, storage, migrations, and private-repository live E2E **are not implemented**.

The existing public GitHub Pages site remains public-only and can serve as the discovery/marketing interface. It must **never** include authenticated private repositories, a GitHub OAuth client secret, a GitHub App private key, server access tokens, or customer data in static assets, localStorage, Action logs, or frontend JavaScript.

## Scope of the actual private product

An authenticated owner-only workspace should give the owner access to:
- Public + explicitly authorized private GitHub repository metadata, revisions, release / workflow status, and repo `STATUS.md` evidence.
- Owner-controlled project focus, tasks, decisions, blockers and weekly reports synchronized across devices using a secure database.
- Clear separation between *documented project claims*, *CI success*, *runtime verification*, and *owner approval*. None may auto-increment product completion from GitHub commits.
- Explicit archive/rename/deletion state and source-of-truth timestamps, with privacy-filtered public exports.

## Architecture requirements

1. **Server-side authentication:** trusted identity via GitHub OAuth / GitHub App installation or another proven owner-only provider. Sessions use Secure + HttpOnly + SameSite cookies. Require CSRF protection on state changes, session rotation, logout/revocation, strict host/origin checks, rate limiting, and authentication on all private API endpoints.
2. **Least-privilege GitHub access:** Prefer an owner-installed GitHub App limited to selected repositories, read-only metadata/contents/actions permissions. Ask the owner to explicitly approve installation scopes. Store app signing keys and installation tokens only on the server; rotate and revoke them. Avoid a long-lived personal access token in any browser, repo or GitHub Pages asset.
3. **Private backend:** separated from the static public site; reverse proxy with TLS, explicit access policy, minimal attack surface and isolated service/process/storage resources. Choose the actual deployment host/domain from a verified, current server profile before any deployment.
4. **Database:** PostgreSQL with authorization/ownership checks on every data query. Persist tasks, decisions, evidence snapshots and audit events. Encrypt sensitive credentials at rest, restrict access, back up, and enforce retention/deletion rules.
5. **No private-data cache leakage:** `Cache-Control: private, no-store` for private API responses; never CDN-cache authenticated HTML, API JSON or exported private project reports. Clear private client state on logout. Separate private assets from the public `data.js`.
6. **Audit and safety:** structured audits must record action type and outcomes without tokens or private file contents. GitHub API rate limits, missing permissions and repo privacy changes must fail closed; never silently present stale private details as public.
7. **Report confidentiality:** private reports must require an authenticated owner session at creation/export; generated downloads must not have permanent public URLs.
8. **Migration:** only migrate owner-selected data. The current local-only workboard is exportable and can later be imported through a trusted authenticated endpoint after filtering/consent. Do not auto-send browser localStorage to a backend.

## Approval and acceptance gate

A V2.0 release cannot be labeled ready until:
- Owner explicitly confirms **deployment host and domain**, chosen GitHub authorization method and allowed repositories, storage/backup policy, and whether a public marketing view should remain.
- Backend/database/auth/authorization are actually deployed and tested with valid credentials, not placeholders.
- Unauthenticated and unauthorized users cannot request private metadata, contents, or local tasks (automated negative tests plus manual incognito verification).
- GitHub App permissions are proven read-only and limited to the approved selection; revoked access blocks subsequent reads.
- Real owner can log in and out, access one approved private repo, inspect actual `STATUS.md` with evidence, update a task, view from a second device, and export a report securely.
- CI, app smoke, access-control checks, TLS, logs, database restore and rollback are exercised in the real deployment.
- The owner inspects and manually accepts both Arabic RTL and English LTR UI.
- Current and older public repository history exposure is reviewed separately; switching to private today does **not** erase already public Git commit history.

## Current scope boundary

Do not add pseudo-login controls to GitHub Pages or use browser-side GitHub tokens as a substitute for secure server-side authorization. Incomplete secure infrastructure is preferable to exposing the owner's private repositories.

*Canonical implementation progress remains in the single root `STATUS.md`.*
