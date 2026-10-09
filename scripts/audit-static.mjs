/* V1.7: fail-closed static publication audit. Runs after public inventory reconciliation.
 * Protects the new release tree, not historical Git revisions.
 */
import {readFile,readdir} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {resolve} from "node:path";
import {strict as assert} from "node:assert";
const root=resolve(process.cwd(),"_site");
const files=(await readdir(root)).sort();
const approved=[
 "app.js","command-center.css","command-center.js","data.js",
 "decisions.css","decisions.js","favicon.svg","index.html",
 "intelligence.css","intelligence.js","reports.css","reports.js",
 "styles.css","workboard.css","workboard.js"
].sort();
assert.deepEqual(files,approved,"Unexpected files in publicly deployed artifact");
const read=path=>readFile(resolve(root,path),"utf8");
const [html,data,report,workspace]=await Promise.all([
 read("index.html"),read("data.js"),read("reports.js"),read("workboard.js")
]);
assert.match(html,/<meta http-equiv="Content-Security-Policy"/);
assert.match(html,/<meta name="referrer" content="no-referrer"/);
for(const file of ["data.js","app.js","command-center.js","intelligence.js",
    "decisions.js","workboard.js","reports.js"]){
 const code=await read(file);
 if(/-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) PRIVATE KEY-----/.test(code))
  throw Error("Private key signature found in public asset: "+file);
 if(/(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/.test(code)&&file==="data.js")
  throw Error("Credential pattern found in catalog");
}
const sandbox={window:{}};
runInNewContext(data,sandbox,{timeout:5000});
const DB=sandbox.window.ABUD_DATA;
assert.equal(DB.owner,"abudoxali");
assert.equal(DB.snapshot,"PUBLIC_ONLY");
assert.ok(Array.isArray(DB.repos)&&DB.repos.length>0);
const members=new Set();
for(const r of DB.repos){
 assert.equal(typeof r.name,"string");
 assert.match(r.name,/^[A-Za-z0-9._-]{1,100}$/);
 assert.ok(!members.has(r.name),"Duplicate public repo");
 members.add(r.name);
}
for(const rel of DB.relationships||[]){
 assert.ok(members.has(rel.from)&&members.has(rel.to),"Private/stale relationship in published catalog");
}
assert.match(report,/public-only|public project|currently displayed public/i);
assert.match(workspace,/LocalStorage|localStorage/);
console.log("PASS static privacy & content audit: "+members.size+" public catalog entries, "+files.length+" allowlisted assets, CSP, no-referrer, no stale links");
