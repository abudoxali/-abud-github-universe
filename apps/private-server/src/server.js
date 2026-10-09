import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {createGitHubInstallation} from "./github.js";
import {hash,randomSecret,equal,repoName,normalizeWorkspace,mustHaveValidConfig} from "./security.js";

const SESSION="__Host-abud_session",OAUTH="__Host-abud_oauth";
const COOKIE={path:"/",secure:true,httpOnly:true,sameSite:"lax"};
const safeOrigin=(request,origin)=>request.headers.origin===origin;
const loginRedirect=()=>"/?error=login";
const self=(path)=>fileURLToPath(new URL(path,import.meta.url));

export function createServer({env=process.env,pool,github,fetchImpl=fetch}={}){
  const config=mustHaveValidConfig(env);
  const server=Fastify({
    logger:{level:env.LOG_LEVEL||"warn",redact:[
      "req.headers.authorization","req.headers.cookie","res.headers.set-cookie",
      "req.body","req.query.code","req.query.state"
    ]},bodyLimit:131072,trustProxy:"127.0.0.1"
  });
  server.register(cookie);
  server.addHook("onRequest",async(request,reply)=>{
    reply.header("Cache-Control","private, no-store, max-age=0");
    reply.header("X-Content-Type-Options","nosniff");
    reply.header("Referrer-Policy","no-referrer");
    reply.header("X-Frame-Options","DENY");
    reply.header("Strict-Transport-Security","max-age=31536000; includeSubDomains");
    reply.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; object-src 'none'");
  });
  server.setErrorHandler((error,request,reply)=>{
    if(error.statusCode===400||error.statusCode===413)reply.code(error.statusCode).send({error:"invalid-request"});
    else{
      request.log.error({message:error.message,code:error.code},"Request failed");
      reply.code(503).send({error:"temporarily-unavailable"});
    }
  });
  async function session(request){
    const raw=request.cookies?.[SESSION];
    if(typeof raw!=="string"||!/^[a-f0-9]{64}$/.test(raw))return null;
    const result=await pool.query(
      "SELECT github_user_id, csrf_secret FROM owner_sessions WHERE token_hash=$1 AND expires_at>NOW()",
      [hash(raw)]
    );
    const row=result.rows[0];
    return row&&Number(row.github_user_id)===config.ownerId?{id:config.ownerId,csrf:row.csrf_secret,raw}:null;
  }
  async function authorized(request,reply,{write=false}={}){
    const user=await session(request);
    if(!user){reply.code(401).send({error:"unauthorized"});return null;}
    if(write){
      const csrf=request.headers["x-os-csrf"];
      if(!safeOrigin(request,config.origin)||!equal(csrf,user.csrf)){
        reply.code(403).send({error:"csrf-or-origin-denied"});return null;
      }
    }
    return user;
  }
  server.get("/health/live",async()=>({status:"ok",service:"abud-os-private"}));
  server.get("/",async(request,reply)=>{
    reply.type("text/html; charset=utf-8");
    return readFile(self("../public/index.html"),"utf8");
  });
  server.get("/assets/app.js",async(request,reply)=>{
    reply.type("text/javascript; charset=utf-8");return readFile(self("../public/app.js"),"utf8");
  });
  server.get("/assets/style.css",async(request,reply)=>{
    reply.type("text/css; charset=utf-8");return readFile(self("../public/style.css"),"utf8");
  });
  server.get("/auth/start",async(request,reply)=>{
    const state=randomSecret(),until=new Date(Date.now()+600000);
    await pool.query("INSERT INTO oauth_states(state_hash,expires_at) VALUES ($1,$2)",[hash(state),until]);
    reply.setCookie(OAUTH,state,{...COOKIE,maxAge:600,path:"/auth"});
    const url=new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id",env.GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri",config.origin+"/auth/callback");
    url.searchParams.set("state",state);
    url.searchParams.set("scope","read:user");
    return reply.redirect(url.toString());
  });
  server.get("/auth/callback",async(request,reply)=>{
    const {code,state}=request.query||{};
    const cookieState=request.cookies?.[OAUTH];
    reply.clearCookie(OAUTH,{path:"/auth",secure:true,sameSite:"lax"});
    if(typeof code!=="string"||code.length>300||typeof state!=="string"||!equal(state,cookieState)){
      return reply.code(403).send({error:"invalid-oauth-state"});
    }
    const consumed=await pool.query(
      "DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>NOW() RETURNING state_hash",
      [hash(state)]
    );
    if(consumed.rowCount!==1)return reply.code(403).send({error:"expired-oauth-state"});
    const tokenRes=await fetchImpl("https://github.com/login/oauth/access_token",{
      method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},
      body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,
        code,redirect_uri:config.origin+"/auth/callback"})
    });
    if(!tokenRes.ok)return reply.code(502).send({error:"github-oauth-unavailable"});
    const payload=await tokenRes.json();
    if(typeof payload.access_token!=="string")return reply.code(403).send({error:"github-oauth-denied"});
    const identity=await fetchImpl("https://api.github.com/user",{
      headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+payload.access_token,
        "User-Agent":"ABUD-OS-Owner-Login"}
    });
    if(!identity.ok)return reply.code(403).send({error:"identity-verification-failed"});
    const who=await identity.json();
    if(who.id!==config.ownerId||who.login?.toLowerCase()!==config.ownerLogin.toLowerCase())
      return reply.code(403).send({error:"owner-only"});
    // OAuth user tokens are not retained; read-only private access uses the separate GitHub App.
    const raw=randomSecret(),csrf=randomSecret();
    await pool.query(
      "INSERT INTO owner_sessions(token_hash,github_user_id,csrf_secret,expires_at) VALUES($1,$2,$3,$4)",
      [hash(raw),config.ownerId,csrf,new Date(Date.now()+7*86400000)]
    );
    reply.setCookie(SESSION,raw,{...COOKIE,maxAge:7*86400});
    return reply.redirect("/");
  });
  server.get("/api/me",async(request,reply)=>{
    const user=await authorized(request,reply);if(!user)return;
    return {owner:config.ownerLogin,csrf:user.csrf};
  });
  server.post("/api/logout",async(request,reply)=>{
    const user=await authorized(request,reply,{write:true});if(!user)return;
    await pool.query("DELETE FROM owner_sessions WHERE token_hash=$1",[hash(user.raw)]);
    reply.clearCookie(SESSION,{path:"/",secure:true,sameSite:"lax"});
    return {ok:true};
  });
  server.get("/api/repos",async(request,reply)=>{
    const user=await authorized(request,reply);if(!user)return;
    return {repos:await github.list(),updatedAt:new Date().toISOString()};
  });
  server.get("/api/repos/:name/status",async(request,reply)=>{
    const user=await authorized(request,reply);if(!user)return;
    const name=request.params.name;
    if(!repoName(name))return reply.code(404).send({error:"not-installed"});
    // Re-check installation membership on EVERY request; never read by raw repo name alone.
    const list=await github.list();
    if(!list.some(r=>r.name===name))return reply.code(404).send({error:"not-installed"});
    const data=await github.getStatus(name);
    if(data===null)return reply.code(404).send({error:"not-installed"});
    return {repo:name,...data};
  });
  server.get("/api/workboard",async(request,reply)=>{
    const user=await authorized(request,reply);if(!user)return;
    const permitted=new Set((await github.list()).map(r=>r.name));
    const {rows}=await pool.query("SELECT revision,data FROM owner_workspaces WHERE github_user_id=$1",[user.id]);
    const revision=rows[0]?.revision??0;
    const source=rows[0]?.data??{version:1,focus:[],projects:{},events:[]};
    // Fail closed when installation access was revoked or repo became private elsewhere.
    const filtered=normalizeWorkspace(source,permitted);
    return {revision,data:filtered};
  });
  server.put("/api/workboard",async(request,reply)=>{
    const user=await authorized(request,reply,{write:true});if(!user)return;
    const body=request.body;
    if(!body||!Number.isInteger(body.revision)||body.revision<0||
      !body.data||typeof body.data!=="object")return reply.code(400).send({error:"invalid-workspace"});
    const permitted=new Set((await github.list()).map(r=>r.name));
    let data;
    try{data=normalizeWorkspace(body.data,permitted);}catch{return reply.code(400).send({error:"invalid-workspace"});}
    await pool.query(
      "INSERT INTO owner_workspaces(github_user_id,revision,data) VALUES($1,0,$2::jsonb) ON CONFLICT DO NOTHING",
      [user.id,JSON.stringify({version:1,focus:[],projects:{},events:[]})]
    );
    const {rows}=await pool.query(
      "UPDATE owner_workspaces SET data=$1::jsonb,revision=revision+1,updated_at=NOW() WHERE github_user_id=$2 AND revision=$3 RETURNING revision",
      [JSON.stringify(data),user.id,body.revision]
    );
    if(!rows.length)return reply.code(409).send({error:"version-conflict"});
    return {revision:rows[0].revision,data};
  });
  server.get("/api/report.md",async(request,reply)=>{
    const user=await authorized(request,reply);if(!user)return;
    const allowedList=await github.list();
    const allowed=new Set(allowedList.map(r=>r.name));
    const {rows}=await pool.query("SELECT revision,data FROM owner_workspaces WHERE github_user_id=$1",[user.id]);
    const data=normalizeWorkspace(rows[0]?.data??{version:1,focus:[],projects:{},events:[]},allowed);
    const days=request.query?.days==="30"?30:7;
    const cutoff=Date.now()-days*86400000;
    const date=new Date().toISOString();
    const clean=str=>String(str||"").replace(/[\r\n\x00-\x1f]+/g," ").replace(/[\x60*\[\]<>]/g," ").slice(0,130);
    const lines=[
      "# ABUD OS — Private Owner Report",
      "",
      "Generated: "+date,
      "Period: "+days+" days",
      "Authorized repositories: "+allowedList.length,
      "Current focus: "+data.focus.length,
      "Source: authenticated server-side PostgreSQL workspace and selected GitHub App installation.",
      "","## Owner-selected focus",""
    ];
    for(const name of data.focus){
      const p=data.projects[name]||{stage:"backlog",tasks:[]};
      lines.push("### "+clean(name),"","- Stage: "+clean(p.stage));
      const total=p.tasks.length,done=p.tasks.filter(t=>t.done).length;
      lines.push("- Tracked tasks completed: "+done+"/"+total,"");
      for(const task of p.tasks)lines.push("- ["+(task.done?"x":" ")+"] "+clean(task.title));
      lines.push("");
    }
    lines.push("## Locally recorded decisions and events","");
    for(const event of data.events.filter(e=>Date.parse(e.at)>=cutoff).slice(0,100))
      lines.push("- "+event.at.slice(0,16)+" / "+clean(event.project)+" / "+
        clean(event.kind)+": "+clean(event.detail));
    lines.push("","---",
      "Owner-entered status is not independent proof of production readiness.",
      "Confidential owner export. Do not publish on GitHub Pages.");
    reply.header("Content-Disposition",'attachment; filename="abud-os-private-'+days+'d.md"');
    reply.type("text/markdown; charset=utf-8");
    return lines.join("\n")+"\n";
  });
  return server;
}
async function main(){
  const env=process.env,config=mustHaveValidConfig(env);
  if((env.HOST||"127.0.0.1")!=="127.0.0.1")throw Error("Only local reverse-proxy binding is permitted");
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5,connectionTimeoutMillis:7000,
    ssl:env.DB_SSL==="true"?{rejectUnauthorized:true}:undefined});
  try{
    await pool.query("SELECT 1");
    const github=await createGitHubInstallation(env,config);
    const server=createServer({env,pool,github});
    server.addHook("onClose",async()=>pool.end());
    await server.listen({port:Number(env.PORT||3164),host:"127.0.0.1"});
  }catch(error){await pool.end();throw error;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL("file://"+process.argv[1])))
  main().catch(error=>{process.stderr.write("Fatal startup: "+error.message+"\n");process.exitCode=1;});
