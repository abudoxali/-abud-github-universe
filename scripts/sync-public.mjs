/**
 * Scheduled public-only inventory reconciliation.
 * Never fetch or publish private repository data, tokens, or user-specific secrets.
 * This preserves editorial project statuses; it only adds/removes public repo membership.
 */
import { readFile, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const owner="abudoxali";
const target="data.js";
const original=await readFile(target,"utf8");
const scope={window:{}};
runInNewContext(original,scope);
const catalog=scope.window.ABUD_DATA;
if(!catalog||!Array.isArray(catalog.repos)||catalog.owner!==owner)throw new Error("Invalid catalog");

const publicRows=[];
for(let page=1;page<=10;page++){
 const url=`https://api.github.com/users/${owner}/repos?type=owner&per_page=100&page=${page}`;
 const headers={
  "Accept":"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28",
  "User-Agent":"abud-github-universe-inventory"
 };
 if(process.env.GH_TOKEN)headers.Authorization=`Bearer ${process.env.GH_TOKEN}`;
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`GitHub API HTTP ${response.status}`);
 const body=await response.json();
 if(!Array.isArray(body))throw new Error("Invalid GitHub response");
 publicRows.push(...body.filter(r=>
  r && typeof r.name==="string" && r.owner?.login?.toLowerCase()===owner &&
  r.private===false && r.visibility==="public"
 ));
 if(body.length<100)break;
 if(page===10)throw new Error("GitHub inventory exceeded 1,000 entries; abort rather than omit");
}
const currentNames=new Set(publicRows.map(r=>r.name));
if(!currentNames.has("-abud-github-universe"))throw new Error("Incomplete public inventory; self repo missing");

const originalNames=new Set(catalog.repos.map(r=>r.name));
const removed=[...originalNames].filter(n=>!currentNames.has(n));
const added=[...currentNames].filter(n=>!originalNames.has(n));
if(!removed.length&&!added.length){
 console.log(`Public repo inventory unchanged: ${currentNames.size} repositories`);
 process.exit(0);
}
catalog.repos=catalog.repos.filter(r=>currentNames.has(r.name));
for(const repo of publicRows){
 if(originalNames.has(repo.name)||catalog.repos.some(x=>x.name===repo.name))continue;
 catalog.repos.push({
  name:repo.name,
  category:"revive",
  status:"UNREVIEWED",
  ar:"مستودع عام جديد يحتاج مراجعة فعلية.",
  en:"New public repository requiring editorial review.",
  nextAr:"افحص المستودع وحدد وظيفته وحالته",
  nextEn:"Inspect and assign an evidence-backed project status",
  note:"Discovered automatically from GitHub's public repository API. Not yet reviewed."
 });
}
const updatedNames=new Set(catalog.repos.map(r=>r.name));
catalog.relationships=catalog.relationships.filter(x=>updatedNames.has(x.from)&&updatedNames.has(x.to));
catalog.inventorySyncedAt=new Date().toISOString();
const index=original.indexOf("window.ABUD_DATA = ");
if(index<0)throw new Error("Data declaration not found");
const output=original.slice(0,index)+"window.ABUD_DATA = "+JSON.stringify(catalog,null,2)+";\n";
await writeFile(target,output);
console.log(`Public inventory changed: ${catalog.repos.length} current; ${added.length} added, ${removed.length} removed. No private names logged.`);
