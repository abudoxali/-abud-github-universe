/* Pure mapping between locally discovered repositories and the public Universe catalog. UMD so the same code is unit
 * tested in Node and used in the browser. It never mutates its inputs and never invents a link: name-based matches are
 * only *suggestions* until the operator confirms them. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AbudWorkspaceMap = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = (value) => String(value || "").toLowerCase();

  /**
   * @param {object} input
   * @param {Array}  input.repos     discovered repositories from the bridge ({rel,name,state,remote:{github}})
   * @param {Array}  input.folders   non-git folders ({rel,name})
   * @param {Array}  input.catalog   public catalog entries ({name})
   * @param {string} input.owner     public catalog owner login
   * @param {object} input.links     manual overrides: { [rel]: catalogName | null }  (null = explicitly unlinked)
   */
  function mapWorkspace({ repos = [], folders = [], catalog = [], owner = "", links = {} }) {
    const catalogByName = new Map(catalog.map((entry) => [key(entry.name), entry]));
    const catalogByFull = new Map(catalog.map((entry) => [key(`${owner}/${entry.name}`), entry]));
    const catalogByNormalized = new Map();
    for (const entry of catalog) {
      const n = normalize(entry.name);
      catalogByNormalized.set(n, catalogByNormalized.has(n) ? null : entry); // null marks an ambiguous normalized name
    }

    const rows = [];
    const classify = (item, isRepo) => {
      const remote = item.remote?.github ? key(item.remote.github) : null;
      const manual = Object.hasOwn(links, item.rel) ? links[item.rel] : undefined;
      const row = {
        key: item.rel, rel: item.rel, name: item.name, kind: isRepo ? "repo" : "folder", item,
        state: null, catalogName: null, link: null, suggestion: null, duplicate: false, duplicateWith: [], worlds: item.worlds || []
      };
      if (typeof manual === "string" && catalogByName.has(key(manual))) {
        row.state = "linked-manual"; row.catalogName = catalogByName.get(key(manual)).name; row.link = "manual";
        return row;
      }
      if (isRepo && manual !== null && remote && catalogByFull.has(remote)) {
        row.state = "linked"; row.catalogName = catalogByFull.get(remote).name; row.link = "remote";
        return row;
      }
      if (!isRepo) row.state = "local-folder";
      else if (item.state !== "ready") row.state = "unreadable";
      else if (remote) row.state = "local-only-github";
      else if (item.remote?.kind === "none") row.state = "local-no-remote";
      else row.state = "local-other-remote";
      // Suggestions only (never auto-linked): same normalized folder or repository name as a catalog entry.
      if (manual !== null) {
        const candidates = [item.name, item.remote?.github?.split("/")[1]].map(normalize).filter(Boolean);
        for (const candidate of candidates) {
          const hit = catalogByNormalized.get(candidate);
          if (hit) { row.suggestion = hit.name; break; }
        }
      }
      return row;
    };
    for (const repo of repos) rows.push(classify(repo, true));
    for (const folder of folders) rows.push(classify(folder, false));

    // Duplicate detection: the same effective identity checked out more than once.
    const groups = new Map();
    for (const row of rows) {
      if (row.kind !== "repo") continue;
      const identity = row.catalogName ? `catalog:${key(row.catalogName)}` : row.item.remote?.github ? `remote:${key(row.item.remote.github)}` : null;
      if (!identity) continue;
      groups.set(identity, [...(groups.get(identity) || []), row]);
    }
    const duplicates = [];
    for (const [identity, group] of groups) {
      if (group.length < 2) continue;
      duplicates.push({ identity, rels: group.map((row) => row.rel) });
      for (const row of group) { row.duplicate = true; row.duplicateWith = group.filter((other) => other !== row).map((other) => other.rel); }
    }

    const claimed = new Set(rows.filter((row) => row.catalogName).map((row) => key(row.catalogName)));
    const catalogOnly = catalog.filter((entry) => !claimed.has(key(entry.name))).map((entry) => entry.name);

    const count = (state) => rows.filter((row) => row.state === state).length;
    return {
      rows, duplicates, catalogOnly,
      summary: {
        repos: rows.filter((row) => row.kind === "repo").length,
        linked: count("linked") + count("linked-manual"), manual: count("linked-manual"),
        localOnlyGithub: count("local-only-github"), noRemote: count("local-no-remote"), otherRemote: count("local-other-remote"),
        folders: count("local-folder"), unreadable: count("unreadable"),
        duplicateGroups: duplicates.length, catalogOnly: catalogOnly.length,
        suggestions: rows.filter((row) => row.suggestion).length
      }
    };
  }

  return { mapWorkspace, normalize };
});
