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

test("Full OAuth login, owner identity, single-use state, session and logout",async()=>{
 const states=new Set(),sessions=new Map();
 const pool={async query(sql,args=[]){
  if(sql.startsWith("INSERT INTO oauth_states")){states.add(args[0]);return {rowCount:1,rows:[]};}
  if(sql.startsWith("DELETE FROM oauth_states")){
   const present=states.delete(args[0]);return {rowCount:present?1:0,rows:present?[{state_hash:args[0]}]:[]};
  }
  if(sql.startsWith("INSERT INTO owner_sessions")){
   sessions.set(args[0],{github_user_id:"123456",csrf_secret:args[2]});return {rowCount:1,rows:[]};
  }
  if(sql.startsWith("SELECT github_user_id")){
   const value=sessions.get(args[0]);return {rows:value?[value]:[]};
  }
  if(sql.startsWith("DELETE FROM owner_sessions")){sessions.delete(args[0]);return {rowCount:1,rows:[]};}
  return {rowCount:0,rows:[]};
 }};
 const called=[];
 const fetchImpl=async(url,options)=>{
  called.push(url);
  if(url.includes("access_token"))return {ok:true,async json(){return {access_token:"test-only-session-token"};}};
  if(url==="https://api.github.com/user"){
   assert.match(options.headers.Authorization,/Bearer test-only-session-token/);
   return {ok:true,async json(){return {id:123456,login:"abudoxali"};}};
  }
  throw Error("Unexpected OAuth URL");
 };
 const server=createServer({env,pool,github,fetchImpl});
 try{
  const start=await server.inject({url:"/auth/start"});
  assert.equal(start.statusCode,302);
  const redirect=new URL(start.headers.location);
  const state=redirect.searchParams.get("state");
  assert.ok(state&&state.length>=32);
  assert.equal(redirect.searchParams.get("scope"),"read:user");
  const stateCookie=String(start.headers["set-cookie"]).split(";")[0];
  assert.match(stateCookie,/^__Host-abud_oauth=/);
  const verified=await server.inject({url:"/auth/callback?code=samplecode&state="+encodeURIComponent(state),
    headers:{cookie:stateCookie}});
  assert.equal(verified.statusCode,302);
  const rawSession=String(verified.headers["set-cookie"]).match(/__Host-abud_session=([a-f0-9]{64})/);
  assert.ok(rawSession,"Owner login must set a secure opaque session cookie");
  const loginCookie="__Host-abud_session="+rawSession[1];
  const me=await server.inject({url:"/api/me",headers:{cookie:loginCookie}});
  assert.equal(me.statusCode,200);
  assert.equal(me.json().owner,"abudoxali");
  assert.match(me.json().csrf,/^[a-f0-9]{64}$/);
  const replay=await server.inject({url:"/auth/callback?code=samplecode&state="+encodeURIComponent(state),
    headers:{cookie:stateCookie}});
  assert.equal(replay.statusCode,403);
  const logout=await server.inject({method:"POST",url:"/api/logout",
    headers:{cookie:loginCookie,origin:"https://os.abud.fun","x-os-csrf":me.json().csrf}});
  assert.equal(logout.statusCode,200);
  assert.equal((await server.inject({url:"/api/me",headers:{cookie:loginCookie}})).statusCode,401);
  assert.deepEqual(called,["https://github.com/login/oauth/access_token","https://api.github.com/user"]);
 }finally{await server.close();}
});
test("OAuth rejects another GitHub user and does not issue a session",async()=>{
 const states=new Set(),sessions=[];
 const pool={async query(sql,args=[]){
  if(sql.startsWith("INSERT INTO oauth_states")){states.add(args[0]);return {rowCount:1,rows:[]};}
  if(sql.startsWith("DELETE FROM oauth_states")){
   const exists=states.delete(args[0]);return {rowCount:exists?1:0,rows:exists?[{}]:[]};
  }
  if(sql.startsWith("INSERT INTO owner_sessions")){sessions.push(args[0]);return {rowCount:1,rows:[]};}
  return {rowCount:0,rows:[]};
 }};
 const githubOAuth=async(url)=>({
  ok:true,async json(){return url==="https://api.github.com/user"?{id:999999,login:"not-owner"}:{access_token:"fake-token"};}
 });
 const server=createServer({env,pool,github,fetchImpl:githubOAuth});
 try{
  const begin=await server.inject({url:"/auth/start"});
  const state=new URL(begin.headers.location).searchParams.get("state");
  const cookie=String(begin.headers["set-cookie"]).split(";")[0];
  const done=await server.inject({url:"/auth/callback?code=samplecode&state="+encodeURIComponent(state),
    headers:{cookie}});
  assert.equal(done.statusCode,403);
  assert.equal(done.json().error,"owner-only");
  assert.equal(sessions.length,0);
  assert.doesNotMatch(String(done.headers["set-cookie"]),/__Host-abud_session=/);
 }finally{await server.close();}
});

test("Revoking GitHub App repository membership hides private workboard, reports and STATUS",async()=>{
 let installed=true;
 const stored={version:1,focus:["sample-private"],projects:{
   "sample-private":{stage:"blocked",tasks:[{id:"test",title:"Confidential internal task",done:false}]}
 },events:[{project:"sample-private",kind:"note",detail:"Internal owner note",at:new Date().toISOString()}]};
 const server=createServer({env,pool:{async query(sql){
   if(sql.startsWith("SELECT github_user_id"))return {rows:[{github_user_id:"123456",csrf_secret:"b".repeat(64)}]};
   if(sql.startsWith("SELECT revision"))return {rows:[{revision:8,data:stored}]};
   return {rowCount:0,rows:[]};
 }},github:{
   async list(){return installed?validRepo:[];},
   async getStatus(){if(!installed)throw Error("Revoked repo must not be fetched");
     return {exists:true,claims:[],sha:"abc"};}
 },fetchImpl:async()=>{throw Error("No outbound network");}});
 try{
  const before=await server.inject({url:"/api/workboard",headers:authenticated});
  assert.equal(before.statusCode,200);
  assert.equal(before.json().data.focus[0],"sample-private");
  installed=false;
  const repos=await server.inject({url:"/api/repos",headers:authenticated});
  assert.deepEqual(repos.json().repos,[]);
  const denied=await server.inject({url:"/api/repos/sample-private/status",headers:authenticated});
  assert.equal(denied.statusCode,404);
  const after=await server.inject({url:"/api/workboard",headers:authenticated});
  assert.equal(after.statusCode,200);
  assert.deepEqual(after.json().data.focus,[]);
  assert.deepEqual(after.json().data.projects,{});
  assert.deepEqual(after.json().data.events,[]);
  const report=await server.inject({url:"/api/report.md",headers:authenticated});
  assert.equal(report.statusCode,200);
  assert.doesNotMatch(report.body,/Confidential internal task|Internal owner note|sample-private/);
 }finally{await server.close();}
});
test("OAuth start and callback are rate limited before untrusted database growth",async()=>{
 const server=createServer({env,pool:mockPool(),github,fetchImpl:async()=>{throw Error("No network");}});
 try{
  for(let i=0;i<20;i++){
   const r=await server.inject({url:"/auth/start",remoteAddress:"192.0.2.50"});
   assert.equal(r.statusCode,302,"First 20 requests allowed");
  }
  const blocked=await server.inject({url:"/auth/start",remoteAddress:"192.0.2.50"});
  assert.equal(blocked.statusCode,429);
  assert.equal(blocked.headers["retry-after"],"60");
  assert.deepEqual(blocked.json(),{error:"auth-rate-limited"});
 }finally{await server.close();}
});
