import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { mapWorkspace } = createRequire(import.meta.url)(resolve(process.cwd(), "../../internal/workspace-map.js"));

const repo = (rel, github, extra = {}) => ({ rel, name: rel, state: "ready", remote: { kind: github ? "github" : "none", github: github || null }, ...extra });
const catalog = [{ name: "Alpha" }, { name: "Beta-App" }, { name: "Gamma" }];
const base = { owner: "acme", catalog };

test("matches by remote identity (case-insensitive) and leaves unmatched repositories unmatched", () => {
  const { rows, catalogOnly, summary } = mapWorkspace({ ...base, repos: [repo("alpha", "ACME/alpha"), repo("private", "acme/private-thing"), repo("loose", null)] });
  const by = Object.fromEntries(rows.map((r) => [r.rel, r]));
  assert.equal(by.alpha.state, "linked");
  assert.equal(by.alpha.catalogName, "Alpha");
  assert.equal(by.private.state, "local-only-github");
  assert.equal(by.loose.state, "local-no-remote");
  assert.deepEqual(catalogOnly, ["Beta-App", "Gamma"]);
  assert.equal(summary.linked, 1);
});

test("a same-named repository under a different owner is only a suggestion, never an automatic link", () => {
  const { rows } = mapWorkspace({ ...base, repos: [repo("Gamma", "someone-else/Gamma")] });
  assert.equal(rows[0].state, "local-only-github");
  assert.equal(rows[0].suggestion, "Gamma");
  assert.equal(rows[0].catalogName, null);
});

test("folder-name normalization suggests but does not link (Beta App vs Beta-App)", () => {
  const { rows } = mapWorkspace({ ...base, repos: [repo("Beta App", null)], folders: [{ rel: "gamma", name: "gamma" }] });
  assert.equal(rows.find((r) => r.rel === "Beta App").suggestion, "Beta-App");
  assert.equal(rows.find((r) => r.rel === "Beta App").state, "local-no-remote");
  assert.equal(rows.find((r) => r.rel === "gamma").state, "local-folder");
});

test("manual link wins over remote matching; unlink override blocks the automatic link and its suggestion", () => {
  const manual = mapWorkspace({ ...base, repos: [repo("renamed", "x/y")], links: { renamed: "Gamma" } });
  assert.equal(manual.rows[0].state, "linked-manual");
  assert.equal(manual.rows[0].catalogName, "Gamma");
  const unlinked = mapWorkspace({ ...base, repos: [repo("Alpha", "acme/Alpha")], links: { Alpha: null } });
  assert.equal(unlinked.rows[0].state, "local-only-github");
  assert.equal(unlinked.rows[0].suggestion, null);
  assert.deepEqual(unlinked.catalogOnly.includes("Alpha"), true);
  const stale = mapWorkspace({ ...base, repos: [repo("x", null)], links: { x: "Deleted-Project" } });
  assert.equal(stale.rows[0].state, "local-no-remote", "links to catalog entries that no longer exist are ignored");
});

test("duplicate checkouts of the same identity are detected, flagged on both rows, and nothing is merged", () => {
  const { rows, duplicates, summary } = mapWorkspace({ ...base, repos: [repo("alpha", "acme/Alpha"), repo("alpha-copy", "acme/alpha"), repo("solo", "acme/solo")] });
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].rels.sort(), ["alpha", "alpha-copy"]);
  assert.ok(rows.filter((r) => r.duplicate).length === 2);
  assert.equal(summary.duplicateGroups, 1);
  const manualDup = mapWorkspace({ ...base, repos: [repo("a1", null), repo("a2", null)], links: { a1: "Gamma", a2: "Gamma" } });
  assert.equal(manualDup.duplicates.length, 1);
});

test("mapping never mutates its inputs", () => {
  const input = { ...base, repos: [repo("alpha", "acme/alpha")], folders: [], links: { alpha: null } };
  const snapshot = JSON.stringify(input);
  mapWorkspace(input);
  assert.equal(JSON.stringify(input), snapshot);
});
