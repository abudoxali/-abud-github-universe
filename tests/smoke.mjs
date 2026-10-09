import { strict as assert } from "node:assert";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
const types = {".html":"text/html",".css":"text/css",".js":"text/javascript",".svg":"image/svg+xml"};
const errors = [];
const server = http.createServer(async (req,res) => {
  try {
    const name = decodeURI((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
    if (!["index.html","styles.css","data.js","app.js","favicon.svg"].includes(name)) {
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
  await desktop.goto(url,{waitUntil:"domcontentloaded"});
  await desktop.locator("#repoGrid .repo-card").first().waitFor();
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),43,"All 43 repositories should render");
  assert.equal(await desktop.locator("#graphClusters .graph-cluster").count(),8,"All 8 clusters should render");
  assert.equal(await desktop.locator("#metrics .stat").count(),5,"Metrics should render");
  assert.equal(await desktop.locator("html").getAttribute("dir"),"rtl","Default is Arabic RTL");
  console.log("PASS desktop: 43 cards, 8 clusters, 5 metrics, Arabic RTL");

  await desktop.locator("#languageButton").click();
  assert.equal(await desktop.locator("html").getAttribute("lang"),"en");
  assert.equal(await desktop.locator("html").getAttribute("dir"),"ltr");
  await desktop.locator("#repoSearch").fill("RootRay");
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),1,"Search should filter");
  await desktop.locator("#clearFilters").click();
  assert.equal(await desktop.locator("#repoGrid .repo-card").count(),43,"Clear restores all");
  await desktop.locator('#repoGrid [data-open="RootRay"]').first().click();
  assert.equal(await desktop.locator("#projectDrawer").getAttribute("aria-hidden"),"false");
  assert.match(await desktop.locator("#drawerGithub").getAttribute("href"),/RootRay$/);
  await desktop.locator("#drawerClose").click();
  assert.equal(await desktop.locator("#projectDrawer").getAttribute("aria-hidden"),"true");
  console.log("PASS interactions: English LTR, search/reset, detail drawer");

  const before = await desktop.locator("#zoomValue").textContent();
  await desktop.locator("#zoomIn").click();
  const after = await desktop.locator("#zoomValue").textContent();
  assert.notEqual(before,after,"Zoom buttons should modify map");
  await desktop.locator("#fitMap").click();
  console.log("PASS map: zoom and fit controls");

  const mobile = await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
  mobile.on("pageerror",(error)=>errors.push(error.message));
  await mobile.goto(url,{waitUntil:"domcontentloaded"});
  await mobile.locator("#repoGrid .repo-card").first().waitFor();
  assert.equal(await mobile.locator("#repoGrid .repo-card").count(),43);
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
  console.log("Mobile overlay debug:",JSON.stringify(overlayHit));
  await mobile.mouse.click(10,120);
  assert.equal(await mobile.locator("#mobileBackdrop").isVisible(),false,
    "Overlay tap did not close mobile nav: "+JSON.stringify(overlayHit));
  const dimensions=await mobile.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}));
  assert.ok(dimensions.scrollWidth<=dimensions.viewport+2,"Mobile horizontal overflow: "+JSON.stringify(dimensions));
  assert.equal(errors.length,0,"Uncaught browser errors: "+errors.join(" | "));
  console.log("PASS mobile: 43 cards, menu/backdrop, no page overflow, zero JS errors");
} finally {
  await browser.close();
  server.close();
}
