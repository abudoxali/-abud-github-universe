/* ABUD FUN Company OS V2 — internal module loader. Loaded by the public page only after the loopback bridge identifies
 * itself; served only by the Local Bridge. Order matters: core → shared company helpers → workspaces. */
(async () => {
  "use strict";
  const health = window.AbudInternalHealth || {};
  const style = document.createElement("link");
  style.rel = "stylesheet"; style.href = "./internal/os.css";
  document.head.append(style);
  const loadScript = (src) => new Promise((resolve, reject) => {
    const node = document.createElement("script");
    node.src = src; node.async = false; node.onload = resolve; node.onerror = () => reject(new Error(`internal-asset-unavailable: ${src}`));
    document.head.append(node);
  });
  const modules = ["workspace-map", "ops-core", "robot-specs", "robot-engine"];
  if (health.capabilities?.company) modules.push("ops-company", "ops-hq", "ops-projects-hub", "ops-work", "ops-workforce", "ops-resources", "ops-usage", "ops-agents", "ops-system", "ops-servers");
  else modules.push("ops-usage", "ops-agents", "ops-system");
  for (const file of modules) await loadScript(`./internal/${file}.js`);
  window.AbudOps?.boot();
})();
