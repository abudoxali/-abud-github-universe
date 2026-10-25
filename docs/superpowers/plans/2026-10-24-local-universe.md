# Local Universe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the private authenticated product from this checkout and add a loopback-only bridge for configured local GitHub projects and worlds.

**Architecture:** A Node built-in HTTP bridge serves the existing static site and read-only local Git status APIs. A localhost-only browser module renders configured worlds; public GitHub Pages keeps its existing public-only behavior.

**Tech Stack:** Node.js 22+, built-in `node:http`, `node:child_process`, `node:test`, existing zero-build HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-24-local-universe-design.md`

## Global Constraints

- No OAuth, PostgreSQL, GitHub App, browser tokens or GitHub write operations.
- The bridge binds to `127.0.0.1` and returns sanitized metadata only.
- `local/worlds.json` remains untracked; only the example configuration is committed.
- Preserve existing public Universe behavior.

## Review Focus

- Missing or invalid local configuration must return a clear empty result, not crash the bridge.
- A missing, non-Git or inaccessible project path must be reported per project without leaking filesystem contents.
- Remote URLs must normalize to `owner/repository` safely.
- Path traversal and non-allowlisted static files must be rejected.
- The public static page must not expose local filesystem data.

### Task 1: Local bridge core

**Files:** Create `apps/local-bridge/package.json`, `apps/local-bridge/src/server.mjs`, `apps/local-bridge/src/git.mjs`, `apps/local-bridge/tests/local-bridge.test.mjs`, `local/worlds.example.json`, update `.gitignore`.

- Write failing tests for sanitized world/account responses, missing repos, path rejection and static allowlist.
- Implement the minimal bridge and Git metadata reader.
- Run `node --test apps/local-bridge/tests/*.mjs`.

### Task 2: Local worlds UI

**Files:** Create `local-worlds.js`, `local-worlds.css`; modify `index.html`.

- Add a local-only worlds panel and render project branch, clean/dirty state, last commit and GitHub remote link.
- Keep the panel graceful when the bridge is not running.
- Add syntax checks and browser coverage through the existing browser harness.

### Task 3: Remove private product path

**Files:** Delete `apps/private-server/**`, `.github/workflows/private-ci.yml`, `docs/V2_SECURE_WORKSPACE.md`; modify `command-center.js`, `README.md`, `STATUS.md`.

- Remove private-workspace routing hooks and auth language from the current product documentation.
- Keep historical safety notes limited to public-only behavior and the new local bridge.
- Verify no private-server, OAuth, PostgreSQL or `ABUD_PRIVATE_WORKSPACE` references remain in active source.

### Task 4: Full verification

- Run bridge unit tests, syntax checks, `git diff --check`, existing browser tests and static audit where available.
- Confirm the repository remains clean apart from intentional changes and report any unavailable dependency separately.
