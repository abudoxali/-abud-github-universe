import { strict as assert } from "node:assert";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import { runInNewContext } from "node:vm";

const root = process.cwd();
const types = {".html":"text/html",".css":"text/css",".js":"text/javascript",".svg":"image/svg+xml"};
const errors = [];
const context = {window:{}};
runInNewContext(await readFile(resolve(root,"data.js"),"utf8"),context);
const catalog = context.window.ABUD_DATA;
assert.ok(catalog && catalog.snapshot==="PUBLIC_ONLY");
const expected = catalog.repos.length;
assert.ok(expected > 0);
const publicSnapshot=catalog.repos.map(r=>({
  name:r.name,owner:{login:"abudoxali"},visibility:"public",private:false,
  stargazers_count:2,language:"TypeScript",pushed_at:"2026-10-09T10:00:00Z"
}));
let livePublic=publicSnapshot.slice();
async function mockPublicGitHub(page){
  await page.route(/^https:\/\/api\.github\.com\/users\/abudoxali\/repos\?/,async route=>{
    const url=new URL(route.request().url());
    await route.fulfill({
      status:200,contentType:"application/json",
      body:JSON.stringify(url.searchParams.get("page")==="1"?livePublic:[])
    });
  });
  await page.route(/^https:\/\/api\.github\.com\/repos\/abudoxali\/[^/]+(?:\?|\/|$)/,async route=>{
    const target=new URL(route.request().url());
    const parts=target.pathname.split("/");
    const name=decodeURIComponent(parts[3]||"");
    const exists=livePublic.find(r=>r.name===name&&r.private===false);
    if(!exists || target.pathname.includes("/contents/")){
      await route.fulfill({status:404,contentType:"application/json",body:"{}"});return;
    }
    let payload;
    if(target.pathname.includes("/commits"))payload=[];
    else if(target.pathname.includes("/actions/runs"))payload={workflow_runs:[]};
    else payload={
      name,owner:{login:"abudoxali"},visibility:"public",private:false,
      default_branch:"main",language:"JavaScript",stargazers_count:0,
      pushed_at:new Date().toISOString()
    };
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(payload)});
  });
  await page.route(/^https:\/\/api\.github\.com\/repos\/abudoxali\/RootRay(?:\?|\/|$)/,async route=>{
    const url=route.request().url();
    let payload;
    if(url.includes("/contents/STATUS.md"))payload={
      type:"file",encoding:"base64",sha:"aabbccddeeff0011223344556677889900aabbcc",
      size:126,
      content:Buffer.from("# RootRay\nUpdated: 2026-10-09\nStatus: VERIFIED IN DOCUMENT\nNext Action: Public release review\nAPI_KEY=example-secret-value\n","utf8").toString("base64")
    };
    else if(url.includes("/commits?"))payload=[{
      sha:"aaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      commit:{message:"test: verified public build",committer:{date:"2026-10-09T08:15:00Z"}}
    }];
    else if(url.includes("/actions/runs"))payload={workflow_runs:[{
      name:"CI / Tests",conclusion:"success",status:"completed",
      updated_at:"2026-10-09T08:20:00Z",
      html_url:"https://github.com/abudoxali/RootRay/actions/runs/123"
    }]};
    else payload={
      name:"RootRay",owner:{login:"abudoxali"},visibility:"public",private:false,
      default_branch:"main",language:"TypeScript",stargazers_count:14,
      pushed_at:"2026-10-09T08:15:00Z"
    };
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(payload)});
  });
}
const server = http.createServer(async (req,res) => {
  try {
    const name = decodeURI((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    if (!["index.html","styles.css","data.js","app.js","command-center.js","command-center.css","intelligence.js","intelligence.css","decisions.js","decisions.css","workboard.js","workboard.css","reports.js","reports.css","favicon.svg"].includes(name)) {
      res.writeHead(404).end("Not found");return;
    }
    const buf = await readFile(resolve(root,name));
    res.setHeader("Content-Type",types[extname(name)] || "text/plain");
    res.writeHead(200).end(buf);
  } catch {
    res.writeHead(500).end("Internal error");
  }
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const url = "http://127.0.0.1:" + server.address().port + "/";
const browser = await chromium.launch({headless:true,args:["--no-sandbox"]});
try {
  const desktop = await browser.newPage({viewport:{width:1440,height:900}});
  desktop.on("pageerror",(error)=>errors.push(error.message));
  await mockPublicGitHub(desktop);
  await desktop.goto(url,{waitUntil:"domcontentloaded"});
  await desktop.locator("#repoGrid .repo-card").first().waitFor();
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),expected,"The public repository catalog should render");
  assert.equal(await desktop.locator("#graphClusters .graph-cluster").count(),8,"All 8 clusters should render");
  assert.equal(await desktop.locator("#metrics .stat").count(),5,"Metrics should render");
  assert.equal(await desktop.locator("html").getAttribute("dir"),"rtl","Default is Arabic RTL");
  await desktop.waitForFunction(()=>document.querySelector("#weeklyIndicator")?.textContent==="PUBLIC GITHUB");
  assert.ok((await desktop.locator("#weeklySummary").textContent()).includes(expected+"/"+expected),"Weekly report must state how many public repositories have metadata");
  console.log("PASS V1.2 weekly: last push review sourced from public metadata");
  assert.match(await desktop.locator("#decisionTitle").textContent(),/قرارات المشاريع/);
  assert.equal(await desktop.locator("#decisionKpis .decision-kpi").count(),4);
  console.log("PASS desktop: ${expected} public cards, 8 clusters, 5 metrics, Arabic RTL");

  await desktop.locator("#languageButton").click();
  assert.equal(await desktop.locator("html").getAttribute("lang"),"en");
  assert.equal(await desktop.locator("html").getAttribute("dir"),"ltr");
  await desktop.locator("#repoSearch").fill("RootRay");
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),1,"Search should filter");
  await desktop.locator("#clearFilters").click();
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),expected,"Clear restores the public catalog");
  await desktop.locator('#repoGrid [data-open="RootRay"]').first().click();
  assert.equal(await desktop.locator("#projectDrawer").getAttribute("aria-hidden"),"false");
  assert.match(await desktop.locator("#drawerGithub").getAttribute("href"),/RootRay$/);
  await desktop.locator("#drawerClose").click();
  assert.equal(await desktop.locator("#projectDrawer").getAttribute("aria-hidden"),"true");
  console.log("PASS interactions: English LTR, search/reset, detail drawer");
  // V1.3 — strict curated relationship type and explainable decision signals.
  await desktop.waitForFunction(()=>document.querySelectorAll("#graphLines .repo-connection").length===6);
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(),6);
  assert.equal(await desktop.locator("#decisionKpis .decision-kpi").count(),4);
  await desktop.locator('#relationModes [data-relation-type="overlap"]').click();
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(),1);
  assert.match(await desktop.locator("#relationGrid .relation-explanation").textContent(),/Potential|scope overlap/i);
  await desktop.locator("#relationGrid [data-edge]").click();
  await desktop.waitForFunction(()=>document.querySelectorAll("#graphLines .repo-connection.is-focused").length===1);
  assert.equal(await desktop.locator("#graphClusters .graph-repo.is-related-focus").count(),2);
  await desktop.locator('#relationModes [data-relation-type="all"]').click();
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(),6);
  await desktop.locator('#decisionFilters [data-decision-filter="security"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(),2);
  await desktop.locator('#decisionFilters [data-decision-filter="release"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(),4);
  await desktop.locator('#decisionFilters [data-decision-filter="overlap"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(),1);
  await desktop.locator('#decisionFilters [data-decision-filter="all"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(),10);
  await desktop.locator("#decisionSort").selectOption("name");
  assert.equal(await desktop.locator("#decisionSort").inputValue(),"name");
  assert.match(await desktop.locator("#decisionDisclaimer").textContent(),/not verified duplication/i);
  console.log("PASS V1.3: six editorial edges, graph focus, filters, release/privacy/overlap signals and sorting");


  // V1.1: daily homepage and deep-linked detail show *real mocked* GitHub evidence,
  // rather than inferring production readiness from the CI outcome.
  assert.equal(await desktop.locator("#dailyLead h3").textContent(),"Video_Factory");
  assert.equal(await desktop.locator("#dailyQueue .queue-card").count(),2);
  await desktop.locator('#repoGrid [data-hub="RootRay"]').first().click();
  await desktop.waitForURL(/#project\/RootRay$/);
  await desktop.locator("#projectHub").waitFor({state:"visible"});
  assert.equal(await desktop.locator("body").getAttribute("class"),"project-mode");
  assert.equal(await desktop.locator("#hubTitle").textContent(),"RootRay");
  await desktop.locator("#hubCommit").getByText("test: verified public build").waitFor();
  assert.match(await desktop.locator("#hubCi").textContent(),/SUCCESS/);
  assert.match(await desktop.locator("#hubDisclaimer").textContent(),/production/i);
  const hubLink=await desktop.locator("#hubRepoLink").getAttribute("href");
  assert.equal(hubLink,"https://github.com/abudoxali/RootRay");
  // V1.2: status facts are displayed as source claims, not execution instructions.
  await desktop.locator("#intelligenceState").getByText("FOUND / PUBLIC").waitFor();
  const statusText=await desktop.locator("#intelligenceFacts").textContent();
  assert.match(statusText,/VERIFIED IN DOCUMENT/);
  assert.ok(!statusText.includes("example-secret-value"));
  const handoff=await desktop.locator("#agentPrompt").inputValue();
  assert.match(handoff,/Agent 1/);
  assert.match(handoff,/aabbccddeeff/);
  assert.match(handoff,/Latest publicly observed commit SHA:/);
  assert.doesNotMatch(handoff,/example-secret-value/);
  await desktop.locator("#agentExecute").click();
  const exec=await desktop.locator("#agentPrompt").inputValue();
  assert.match(exec,/Agent 2/);
  assert.match(exec,/Inspect → Run → Diagnose → Execute → Test → Verify → Update STATUS.md/);
  assert.ok(exec.includes("CI outcome alone is not product acceptance"));
  console.log("PASS V1.2: safe public STATUS source, Agent 1/2 prompts, qualified commit and CI evidence");
  await desktop.locator("#hubBack").click();
  await desktop.waitForURL(/#daily$/);
  assert.equal(await desktop.locator("#projectHub").isVisible(),false);


  console.log("PASS V1.1: daily priorities, routed project hub, mocked public commit and CI");

  // V1.4: user-owned project focus, short tasks, stage, persistence and safe import.
  assert.equal(await desktop.locator("#workProjects .work-project").count(),3);
  assert.equal(await desktop.locator("#workPin").isDisabled(),true);
  await desktop.locator('#workProjects [data-task-form="RootRay"] input').fill("Review the public release checklist");
  await desktop.locator('#workProjects [data-task-form="RootRay"] button[type="submit"]').click();
  assert.equal(await desktop.locator('#workProjects [data-work-project="RootRay"] .work-task').count(),1);
  await desktop.locator('#workProjects [data-task-toggle="RootRay"]').check();
  await desktop.locator('#workProjects [data-work-stage="RootRay"]').selectOption("review");
  const workSaved=await desktop.evaluate(()=>{
    const raw=JSON.parse(localStorage.getItem("abud-os-workboard-v1")||"null");
    return raw&&{focus:raw.focus,stage:raw.projects.RootRay.stage,done:raw.projects.RootRay.tasks[0].done};
  });
  assert.equal(workSaved.stage,"review");
  assert.equal(workSaved.done,true);
  assert.equal(workSaved.focus.length,3);
  assert.ok((await desktop.locator("#workHistoryList .work-history-event").count())>=3);
  await desktop.locator("#workNoteProject").selectOption("RootRay");
  await desktop.locator("#workNoteText").fill("Release blockers need review");
  await desktop.locator("#workNoteAdd").click();
  assert.match(await desktop.locator("#workHistoryList").textContent(),/Release blockers need review/);
  await desktop.locator("#historyFilter").selectOption("all");
  assert.equal(await desktop.locator("#historyFilter").inputValue(),"all");
  const snapshot=await desktop.evaluate(()=>window.ABUD_REPORT.collect());
  assert.equal(snapshot.projects.length,3);
  assert.equal(snapshot.completed,1);
  assert.ok(snapshot.events.some(e=>e.kind==="note"&&e.project==="RootRay"));
  assert.ok(snapshot.publicCount===expected);
  await desktop.locator("#reportPeriod").selectOption("30");
  assert.equal(await desktop.locator("#reportPeriod").inputValue(),"30");
  const reportMd=await desktop.evaluate(()=>window.ABUD_REPORT.getMarkdown());
  assert.match(reportMd,/RootRay/);
  assert.match(reportMd,/Release blockers need review/);
  assert.match(reportMd,/1/);
  assert.match(reportMd,/GitHub Push does not prove|GitHub push do not prove|CI and GitHub push do not prove/i);
  const downloadPromise=desktop.waitForEvent("download");
  await desktop.locator("#reportMarkdown").click();
  const file=await downloadPromise;
  assert.match(file.suggestedFilename(),/^abud-os-review-30d-\d{4}-\d{2}-\d{2}\.md$/);
  await desktop.evaluate(()=>{window.__printCalled=false;window.print=()=>{window.__printCalled=true;};});
  await desktop.locator("#reportPrint").click();
  assert.equal(await desktop.evaluate(()=>window.__printCalled),true);
  console.log("PASS V1.6: period, owner evidence, Markdown download, Print/PDF action"); 
  console.log("PASS V1.5: local task/stage journal and authored project decision");
  await desktop.reload({waitUntil:"domcontentloaded"});
  await desktop.locator('#workProjects [data-work-project="RootRay"] .work-task.done').waitFor();
  assert.equal(await desktop.locator('#workProjects [data-work-stage="RootRay"]').inputValue(),"review");
  await desktop.locator('#workProjects [data-unpin="RootRay"]').click();
  assert.equal(await desktop.locator("#workProjects .work-project").count(),2);
  await desktop.locator("#workProjectSelect").selectOption("ThreadForm");
  await desktop.locator("#workPin").click();
  assert.equal(await desktop.locator("#workProjects .work-project").count(),3);
  assert.equal(await desktop.locator("#dailyQueue .queue-card").count(),2);
  const exported=await desktop.evaluate(()=>window.ABUD_WORKBOARD.getSnapshot());
  assert.equal(exported.version,1);
  assert.equal(exported.focus.includes("ThreadForm"),true);
  assert.equal(exported.projects.RootRay.tasks.length,1);
  assert.ok(exported.events.some(event=>event.project==="RootRay"&&event.kind==="note"));
  assert.ok(exported.events.some(event=>event.project==="RootRay"&&event.kind==="task_done"));

  const safeImport={
    version:1,focus:["ThreadForm","Video_Factory","synthetic-private-test-repo"],
    projects:{
      ThreadForm:{stage:"blocked",tasks:[{id:"t1",title:"Verify real 3D workflow",done:false}]},
      "synthetic-private-test-repo":{stage:"blocked",tasks:[{id:"secret",title:"Never display private data",done:false}]}
    },
    events:[
      {id:"private1",project:"synthetic-private-test-repo",kind:"note",detail:"Do not import this",at:"2026-10-09T08:00:00Z"},
      {id:"public1",project:"ThreadForm",kind:"note",detail:"Check 3D flow",at:"2026-10-09T08:00:00Z"}
    ]
  };
  await desktop.locator("#workImportFile").setInputFiles({
    name:"workboard.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(safeImport))
  });
  await desktop.waitForFunction(()=>document.querySelectorAll("#workProjects .work-project").length===2);
  assert.equal(await desktop.locator('#workProjects [data-work-stage="ThreadForm"]').inputValue(),"blocked");
  assert.ok(!(await desktop.locator("#workProjects").textContent()).includes("synthetic-private-test-repo"));
  const sanitized=await desktop.evaluate(()=>window.ABUD_WORKBOARD.getSnapshot());
  assert.ok(!Object.keys(sanitized.projects).includes("synthetic-private-test-repo"));
  assert.ok(!sanitized.focus.includes("synthetic-private-test-repo"));
  assert.equal(sanitized.events.length,1);
  assert.equal(sanitized.events[0].project,"ThreadForm");
  assert.ok(!(await desktop.locator("#workHistoryList").textContent()).includes("Do not import this"));
  // Restore initial editorial focus for unrelated acceptance checks.
  await desktop.evaluate(()=>{
    localStorage.removeItem("abud-os-workboard-v1");
    location.reload();
  });
  await desktop.locator('#workProjects [data-work-project="RootRay"]').waitFor();
  assert.equal(await desktop.locator("#dailyLead h3").textContent(),"Video_Factory");
  assert.equal(await desktop.locator("#workProjects .work-project").count(),3);
  assert.equal(await desktop.locator("#workHistoryList .work-history-event").count(),0);
  console.log("PASS V1.4: 3-project WIP cap, tasks, progress, persistence, custom daily focus, sanitized JSON import");


  // Mock a newly private/deleted repository and a new public repository.
  // These are synthetic names, not names from the user's hidden repositories.
  livePublic = publicSnapshot.filter(r=>r.name!=="RootRay");
  livePublic.push({
    name:"synthetic-public-test-repo",owner:{login:"abudoxali"},
    visibility:"public",private:false,stargazers_count:0,language:"JavaScript",
    pushed_at:"2026-10-09T10:00:00Z"
  });
  livePublic.push({
    name:"synthetic-private-test-repo",owner:{login:"abudoxali"},
    visibility:"private",private:true,stargazers_count:0
  });
  await desktop.locator("#syncButton").click();
  await desktop.waitForFunction(()=>{
    return [...document.querySelectorAll("#repoGrid .repo-name")]
      .some(el=>el.textContent==="synthetic-public-test-repo");
  });
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),expected);
  assert.equal(await desktop.locator('#repoGrid [data-open="RootRay"]').count(),0);
  assert.equal(await desktop.locator('#workProjects [data-work-project="RootRay"]').count(),0);
  const pruned=await desktop.evaluate(()=>JSON.parse(localStorage.getItem("abud-os-workboard-v1")));
  assert.ok(!pruned.focus.includes("RootRay"));
  assert.ok(!Object.keys(pruned.projects).includes("RootRay"));
  assert.ok(!pruned.events.some(event=>event.project==="RootRay"));
  assert.ok(!(await desktop.evaluate(()=>window.ABUD_REPORT.getMarkdown())).includes("RootRay"),
    "Private/removed project may not be exported in Markdown");

  await desktop.goto(url+"#project/RootRay",{waitUntil:"domcontentloaded"});
  await desktop.waitForURL(/#daily$/);
  assert.equal(await desktop.locator("#projectHub").isVisible(),false,
    "Stale deep links cannot reveal a removed/private repository");
  console.log("PASS V1.1 privacy: private/removed deep links are blocked");
  assert.equal(await desktop.locator("#relationGrid .relation-card").count(),5,
    "Private or removed repo relationships must disappear");
  assert.ok(!(await desktop.locator("#relationGrid").textContent()).includes("RootRay"));
  await desktop.waitForFunction(()=>document.querySelectorAll("#graphLines .repo-connection").length===5);
  assert.ok(!(await desktop.locator("#decisionList").textContent()).includes("synthetic-private-test-repo"));
  assert.equal(await desktop.getByText("synthetic-private-test-repo").count(),0);
  console.log("PASS public reconciliation: hidden/deleted removed; new public discovered; private rejected");

  // A 90+-day public push gap is a *review signal*, never proof of abandonment.
  livePublic=livePublic.map(r=>r.name==="ThreadForm"?{...r,pushed_at:"2025-01-01T00:00:00Z"}:r);
  await desktop.locator("#syncButton").click();
  await desktop.waitForFunction(()=>{
    return [...document.querySelectorAll("#decisionFilters [data-decision-filter]")]
      .some(b=>b.dataset.decisionFilter==="quiet"&&b.textContent.includes("1"));
  });
  await desktop.locator('#decisionFilters [data-decision-filter="quiet"]').click();
  assert.equal(await desktop.locator("#decisionList .decision-item").count(),1);
  assert.match(await desktop.locator("#decisionList").textContent(),/ThreadForm/);
  assert.match(await desktop.locator("#decisionList").textContent(),/does not mean.*broken/i);
  await desktop.locator('#decisionFilters [data-decision-filter="all"]').click();
  console.log("PASS V1.3 low-activity: 90+ day public push signal, not product failure");

  const before = await desktop.locator("#zoomValue").textContent();
  await desktop.locator("#zoomIn").click();
  const after = await desktop.locator("#zoomValue").textContent();
  assert.notEqual(before,after,"Zoom buttons should modify map");
  await desktop.locator("#fitMap").click();
  console.log("PASS map: zoom and fit controls");

  // Restore the full public snapshot after the preceding privacy-removal scenario.
  livePublic = publicSnapshot.slice();
  const mobile = await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
  mobile.on("pageerror",(error)=>errors.push(error.message));
  await mockPublicGitHub(mobile);
  await mobile.goto(url,{waitUntil:"domcontentloaded"});
  await mobile.locator("#repoGrid .repo-card").first().waitFor();
  assert.equal(await mobile.locator("#repoGrid .repo-card").count(),expected);
  await mobile.locator("#mobileMenu").click();
  assert.equal(await mobile.locator("#mobileBackdrop").isVisible(),true);
  const overlayHit = await mobile.evaluate(() => {
    const overlay=document.getElementById("mobileBackdrop");
    const menu=document.getElementById("sidebar");
    const rect=overlay.getBoundingClientRect();
    const nav=menu.getBoundingClientRect();
    return {overlay:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      sidebar:{x:nav.x,width:nav.width},
      hit:document.elementFromPoint(10,120)?.id||document.elementFromPoint(10,120)?.tagName};
  });
  await mobile.waitForFunction(() => {
    const menu=document.getElementById("sidebar");
    const box=menu.getBoundingClientRect();
    return menu.classList.contains("mobile-open") &&
      box.left >= -3 && box.right <= window.innerWidth + 3;
  },null,{timeout:5000});
  console.log("Mobile sidebar visually opened; initial overlay debug:",JSON.stringify(overlayHit));
  await mobile.mouse.click(10,120);
  assert.equal(await mobile.locator("#mobileBackdrop").isVisible(),false,
    "Overlay tap did not close mobile nav: "+JSON.stringify(overlayHit));
  const dimensions=await mobile.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}));
  assert.ok(dimensions.scrollWidth<=dimensions.viewport+2,"Mobile horizontal overflow: "+JSON.stringify(dimensions));
  assert.equal(errors.length,0,"Uncaught browser errors: "+errors.join(" | "));
  await mobile.locator("#decisionKpis .decision-kpi").first().waitFor();
  assert.equal(await mobile.locator("#decisionKpis .decision-kpi").count(),4);
  assert.equal(await mobile.locator("#relationGrid .relation-card").count(),6);
    assert.equal(await mobile.locator("#workProjects .work-project").count(),3);
  assert.equal(await mobile.locator("#workHistoryList .work-history-empty").count(),1);
  assert.equal(await mobile.locator("#reportStats .report-stat").count(),4);
  assert.equal(await mobile.locator("#reportPeriod").inputValue(),"7");
    await mobile.locator("#dailyLead h3").waitFor();
  assert.equal(await mobile.locator("#dailyQueue .queue-card").count(),2);
  await mobile.locator("#dailyLead a").first().click();
  await mobile.waitForURL(/#project\/Video_Factory$/);
  await mobile.locator("#projectHub").waitFor({state:"visible"});
  assert.equal(await mobile.locator("#projectHub").isVisible(),true);
  await mobile.locator("#intelligenceState").getByText("NOT FOUND").waitFor();
  assert.match(await mobile.locator("#intelligenceExcerpt").textContent(),/STATUS.md/);
  assert.equal(errors.length,0);
  console.log("PASS mobile: public cards, daily priorities, project hub, no overflow, zero errors");
} finally {
  await browser.close();
  server.close();
}
