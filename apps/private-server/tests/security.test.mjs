import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "../src/server.js";
import {normalizeWorkspace,statusClaims,mustHaveValidConfig,repoName,hash} from "../src/security.js";
import {requireReadOnlyInstallation} from "../src/github.js";

const env={
 DATABASE_URL:"postgresql://test:disabled@127.0.0.1:5432/abud_os_test",
 PUBLIC_ORIGIN:"https://os.abud.fun",GITHUB_CLIENT_ID:"unit-test-client",
 GITHUB_CLIENT_SECRET:"dummy-local-unit-test-secret",GITHUB_OWNER_ID:"123456",
 GITHUB_OWNER_LOGIN:"abudoxali",GITHUB_APP_ID:"100",GITHUB_INSTALLATION_ID:"200",
 GITHUB_APP_PRIVATE_KEY_PATH:"/nonexistent/github-app.pem",LOG_LEVEL:"silent"
};
const validRepo=[{name:"sample-private",private:true,archived:false,defaultBranch:"main"}];
const github={
 async list(){return validRepo;},
 async getStatus(name){return name==="sample-private"?{exists:true,claims:[{key:"Status",value:"IN REVIEW"}],sha:"ab12"}:null;}
};
function mockPool(){
 let revision=0;
 let data={version:1,focus:[],projects:{},events:[]};
 return {
  async query(sql,values){
   if(sql.startsWith("SELECT github_user_id"))return {rows:[{
     github_user_id:"123456",csrf_secret:"b".repeat(64)
   }]};
   if(sql.startsWith("SELECT revision"))return {rows:[{revision,data}]};
   if(sql.startsWith("UPDATE owner_workspaces")){
     if(values[2]!==revision)return {rows:[]};
     data=JSON.parse(values[0]);revision++;
     return {rows:[{revision}]};
   }
   if(sql.startsWith("DELETE FROM oauth_states"))return {rowCount:0,rows:[]};
   return {rows:[],rowCount:0};
  }
 };
}
const authenticated={cookie:"__Host-abud_session="+"a".repeat(64)};
function app(){return createServer({env,pool:mockPool(),github,fetchImpl:async()=>{throw Error("No network allowed in test")}});}
test("Public safety and workspace input schema",()=>{
 assert.equal(repoName("../secrets"),false);
 assert.equal(repoName("sample-private"),true);
 assert.throws(()=>mustHaveValidConfig({...env,GITHUB_APP_ID:""}),/Missing mandatory/);
 assert.throws(()=>mustHaveValidConfig({...env,PUBLIC_ORIGIN:"http://os.abud.fun"}),/HTTPS/);
 assert.throws(()=>normalizeWorkspace({version:1,focus:["a","b","c","d"]},["a","b","c","d"]),/Focus limit/);
 const workspace=normalizeWorkspace({
  version:1,focus:["sample-private","rogue-repo"],
  projects:{
   "sample-private":{stage:"blocked",tasks:[
     {id:"task1",title:"Verify last release",done:true},
     {id:"token",title:"API_KEY=unsafe-value",done:false}
   ]},
   "rogue-repo":{stage:"done",tasks:[{id:"s",title:"Never show",done:true}]}
  },
  events:[
   {project:"sample-private",kind:"note",detail:"Awaiting approval",at:"2026-10-09T10:00:00Z"},
   {project:"rogue-repo",kind:"note",detail:"Hidden information",at:"2026-10-09T10:00:00Z"}
  ]
 },["sample-private"]);
 assert.deepEqual(workspace.focus,["sample-private"]);
 assert.equal(workspace.projects["sample-private"].tasks.length,1);
 assert.equal(workspace.events.length,1);
 assert.equal(Object.hasOwn(workspace.projects,"rogue-repo"),false);
 const claims=statusClaims("Status: Ready for review\nPassword: SUPERSECRET\nNext Action: Validate integration\napi_key: abc123456");
 assert.equal(claims.length,2);
 assert.equal(claims[0].key,"Status");
});
test("Unauthenticated callers never access private metadata or workspace",async()=>{
 const server=app();
 try{
  for(const u of ["/api/me","/api/repos","/api/repos/sample-private/status","/api/workboard","/api/report.md"]){
   const r=await server.inject({method:"GET",url:u});
   assert.equal(r.statusCode,401,u);assert.match(r.headers["cache-control"],/no-store/);
   assert.equal(r.body.includes("sample-private"),false);
  }
  const p=await server.inject({method:"PUT",url:"/api/workboard",payload:{revision:0,data:{version:1}}});
  assert.equal(p.statusCode,401);
 }finally{await server.close();}
});
test("Owner session, scoped installation membership, origin and CSRF gate",async()=>{
 const server=app();
 try{
  const me=await server.inject({url:"/api/me",headers:authenticated});
  assert.equal(me.statusCode,200);
  assert.equal(me.json().csrf,"b".repeat(64));
  assert.equal(me.headers["x-frame-options"],"DENY");
  assert.match(me.headers["content-security-policy"],/frame-ancestors 'none'/);
  const repos=await server.inject({url:"/api/repos",headers:authenticated});
  assert.equal(repos.statusCode,200);assert.equal(repos.json().repos[0].private,true);
  const deny=await server.inject({url:"/api/repos/not-installed/status",headers:authenticated});
  assert.equal(deny.statusCode,404);
  const ok=await server.inject({url:"/api/repos/sample-private/status",headers:authenticated});
  assert.equal(ok.statusCode,200);assert.equal(ok.json().claims[0].value,"IN REVIEW");
  const update={revision:0,data:{version:1,focus:["sample-private"],projects:{"sample-private":{stage:"blocked",tasks:[]}},events:[]}};
  for(const headers of [
    {...authenticated,"x-os-csrf":"b".repeat(64)},
    {...authenticated,origin:"https://evil.example","x-os-csrf":"b".repeat(64)},
    {...authenticated,origin:"https://os.abud.fun","x-os-csrf":"wrong"}
  ]){
   const r=await server.inject({method:"PUT",url:"/api/workboard",headers,payload:update});
   assert.equal(r.statusCode,403);
  }
  const headers={...authenticated,origin:"https://os.abud.fun","x-os-csrf":"b".repeat(64)};
  const good=await server.inject({method:"PUT",url:"/api/workboard",headers,payload:update});
  assert.equal(good.statusCode,200);assert.equal(good.json().revision,1);
  const conflict=await server.inject({method:"PUT",url:"/api/workboard",headers,payload:update});
  assert.equal(conflict.statusCode,409);
  const workspace=await server.inject({url:"/api/workboard",headers:authenticated});
  assert.equal(workspace.json().data.focus[0],"sample-private");
  const ownerReport=await server.inject({url:"/api/report.md?days=30",headers:authenticated});
  assert.equal(ownerReport.statusCode,200);
  assert.match(ownerReport.headers["content-disposition"],/attachment;/);
  assert.match(ownerReport.headers["cache-control"],/no-store/);
  assert.match(ownerReport.body,/sample-private/);
  assert.match(ownerReport.body,/Confidential owner export/);
  assert.doesNotMatch(ownerReport.body,/rogue-repo/);

 }finally{await server.close();}
});
test("OAuth callback rejects missing state without calling GitHub",async()=>{
 const server=app();
 try{
  const r=await server.inject({url:"/auth/callback?code=forged&state=forged"});
  assert.equal(r.statusCode,403);
  const login=await server.inject({url:"/auth/start"});
  assert.equal(login.statusCode,302);
  assert.match(login.headers.location,/github\.com\/login\/oauth\/authorize/);
  assert.match(login.headers["set-cookie"],/Secure/);
  assert.match(login.headers["set-cookie"],/Path=\//);
  assert.doesNotMatch(login.headers["set-cookie"],/Path=\/auth/);
 }finally{await server.close();}
});

test("GitHub App install must be owner-selected with read-only contents",()=>{
 const good={account:{id:123456,login:"abudoxali"},repository_selection:"selected",
   permissions:{metadata:"read",contents:"read",actions:"read"}};
 assert.equal(requireReadOnlyInstallation(good,{ownerId:123456,ownerLogin:"abudoxali"}),true);
 assert.throws(()=>requireReadOnlyInstallation({...good,repository_selection:"all"},{ownerId:123456,ownerLogin:"abudoxali"}),/SELECTED/);
 assert.throws(()=>requireReadOnlyInstallation({...good,permissions:{metadata:"read",contents:"write"}},{ownerId:123456,ownerLogin:"abudoxali"}),/non-read-only/);
 assert.throws(()=>requireReadOnlyInstallation({...good,account:{id:999,login:"attacker"}},{ownerId:123456,ownerLogin:"abudoxali"}),/SELECTED/);
 assert.throws(()=>requireReadOnlyInstallation({...good,permissions:{metadata:"read"}},{ownerId:123456,ownerLogin:"abudoxali"}),/Contents: Read/);
});
