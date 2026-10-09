import {strict as assert} from "node:assert";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {chromium} from "playwright";

const ROOT=resolve(process.cwd(),"public"),ORIGIN="https://os.abud.fun";
const browser=await chromium.launch({headless:true});
const failures=[];
const baseWorkspace=()=>({version:1,focus:[],projects:{},events:[]});
let current={revision:0,data:baseWorkspace()},saves=0;
const privateRepos=[
 {name:"repo-private",private:true,archived:false,defaultBranch:"main"},
 {name:"repo-public",private:false,archived:false,defaultBranch:"main"}
];
function mockJSON(route,status,data){
 return route.fulfill({status,contentType:"application/json",headers:{"Cache-Control":"private, no-store"},body:JSON.stringify(data)});
}
async function setup(page,{guest=false}={}){
 await page.route("**/*",async(route)=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(url.origin!==ORIGIN)throw Error("Unexpected external origin: "+url.origin);
  if(path==="/"&&route.request().method()==="GET")
   return route.fulfill({status:200,contentType:"text/html",body:await readFile(resolve(ROOT,"index.html"),"utf8")});
  if(path==="/assets/app.js"||path==="/assets/style.css")
   return route.fulfill({status:200,contentType:path.endsWith(".js")?"text/javascript":"text/css",body:await readFile(resolve(ROOT,path.split("/").at(-1)),"utf8")});
  if(path==="/api/me")return mockJSON(route,guest?401:200,guest?{error:"unauthorized"}:{owner:"abudoxali",csrf:"f".repeat(64)});
  if(path==="/api/repos")return mockJSON(route,200,{repos:privateRepos,updatedAt:new Date().toISOString()});
  if(path==="/api/workboard"){
    if(route.request().method()==="PUT"){
      const json=route.request().postDataJSON();
      assert.equal(route.request().headers()["x-os-csrf"],"f".repeat(64));
      assert.equal(json.revision,current.revision);
      assert.ok(json.data.focus.every(n=>privateRepos.some(r=>r.name===n)));
      current={revision:current.revision+1,data:json.data};saves++;
    }
    return mockJSON(route,200,current);
  }
  if(path.endsWith("/status"))return mockJSON(route,200,{exists:true,sha:"abc",claims:[{key:"Status",value:"REVIEW"}]});
  throw Error("Unexpected browser request: "+route.request().method()+" "+url);
 });
 page.on("pageerror",e=>failures.push(e.message));
}
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});
 await setup(page);
 await page.goto(ORIGIN+"/",{waitUntil:"domcontentloaded"});
 await page.locator("#protected").waitFor({state:"visible"});
 assert.equal(await page.locator("#privateRepos").textContent(),"1");
 assert.equal(await page.locator("#repoList button.repo").count(),2);
 await page.locator("#repoList button.repo").filter({hasText:"repo-private"}).click();
 await page.locator("#projectStage").selectOption("blocked");
 await page.locator("#taskText").fill("Verify private test release");
 await page.locator("#taskForm button").click();
 assert.match(await page.locator("#taskList").textContent(),/Verify private test release/);
 await page.locator("#taskList input[type=checkbox]").check();
 await page.locator("#noteText").fill("Blocked on owner approval");
 await page.locator("#noteForm button").click();
 assert.match(await page.locator("#eventList").textContent(),/Blocked on owner approval/);
 await page.locator("#save").click();
 await page.waitForFunction(()=>document.querySelector("#saveStatus")?.textContent?.includes("تم حفظ"));
 assert.equal(saves,1);
 assert.equal(current.data.projects["repo-private"].stage,"blocked");
 assert.equal(current.data.projects["repo-private"].tasks[0].done,true);
 assert.equal(current.data.events.some(e=>e.kind==="note"),true);
 await page.locator("#language").click();
 assert.equal(await page.locator("html").getAttribute("dir"),"ltr");
 assert.equal(await page.locator("#projectStage").inputValue(),"blocked");
 assert.equal(await page.locator("#reportTitle").textContent(),"Authenticated owner reports");
 await page.locator("#repoList button.repo").filter({hasText:"repo-private"}).click();
 await page.locator("#statusFacts .fact").first().waitFor();
 assert.match(await page.locator("#statusFacts").textContent(),/REVIEW/);
 console.log("PASS V2 browser: owner dashboard, private catalog, stages, task, journal, server save, EN/RTL, STATUS claims");

 // Opt-in import never reads public localStorage, requires confirmation and Save.
 const file={version:1,focus:["repo-public","unapproved"],projects:{
   "repo-public":{stage:"review",tasks:[{id:"old",title:"Verify public edge",done:false}]},
   "unapproved":{stage:"done",tasks:[{id:"hidden",title:"Do not import",done:true}]}
 },events:[]};
 page.once("dialog",dialog=>dialog.accept());
 await page.locator("#importFile").setInputFiles({name:"workboard.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(file))});
 await page.waitForFunction(()=>document.querySelector("#saveStatus")?.textContent?.includes("تم استيراد"));
 assert.equal(await page.locator("#focusList .focus").count(),1);
 assert.match(await page.locator("#focusList").textContent(),/repo-public/);
 assert.ok(!(await page.locator("#focusList").textContent()).includes("unapproved"));
 assert.equal(saves,1,"Imported draft must NOT autosave");
 await page.locator("#save").click();
 await page.waitForFunction(()=>document.querySelector("#saveStatus")?.textContent?.includes("تم حفظ"));
 assert.equal(saves,2);
 assert.deepEqual(current.data.focus,["repo-public"]);
 assert.ok(!Object.hasOwn(current.data.projects,"unapproved"));
 assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),[]);
 console.log("PASS V2 browser: opt-in import, rejects unauthorized repo, manual save, no localStorage private data");

 const guest=await browser.newPage({viewport:{width:390,height:844}});
 await setup(guest,{guest:true});
 await guest.goto(ORIGIN+"/",{waitUntil:"domcontentloaded"});
 await guest.locator("#loginView").waitFor({state:"visible"});
 assert.equal(await guest.locator("#protected").isHidden(),true);
 const overflow=await guest.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
 assert.equal(overflow,false,"Mobile must not have horizontal overflow");
 assert.equal(failures.length,0,failures.join("\n"));
 console.log("PASS V2 browser: unauthorized mobile remains on login; no console errors or page overflow");
}finally{await browser.close();}
