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
    if (!["index.html","styles.css","data.js","app.js","command-center.js","command-center.css","intelligence.js","intelligence.css","favicon.svg"].includes(name)) {
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
  assert.match(await desktop.locator("#weeklySummary").textContent(),/public repositories|projects|repositories/i);
  console.log("PASS V1.2 weekly: last push review sourced from public metadata");
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
  await desktop.locator("#hubBack").click();
  await desktop.waitForURL(/#daily$/);
  assert.equal(await desktop.locator("#projectHub").isVisible(),false);

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
  console.log("PASS V1.1: daily priorities, routed project hub, mocked public commit and CI");

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
  await desktop.goto(url+"#project/RootRay",{waitUntil:"domcontentloaded"});
  await desktop.waitForURL(/#daily$/);
  assert.equal(await desktop.locator("#projectHub").isVisible(),false,
    "Stale deep links cannot reveal a removed/private repository");
  console.log("PASS V1.1 privacy: private/removed deep links are blocked");
  assert.equal(await desktop.locator('#relationGrid [data-open="RootRay"]').count(),0);
  assert.equal(await desktop.getByText("synthetic-private-test-repo").count(),0);
  console.log("PASS public reconciliation: hidden/deleted removed; new public discovered; private rejected");

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
