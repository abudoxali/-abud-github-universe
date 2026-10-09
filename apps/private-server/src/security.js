import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
export const hash = value=>createHash("sha256").update(value).digest("hex");
export const randomSecret=()=>randomBytes(32).toString("hex");
export const equal=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.length===b.length&&
  timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const repoName=name=>typeof name==="string"&&/^[A-Za-z0-9._-]{1,100}$/.test(name);
export const secretText=/(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[\w]{12,}|sk-[\w-]{15,}|-----BEGIN [^-]*PRIVATE KEY-----|(?:token|secret|password|api[_ -]?key)\s*[:=]\s*\S{6,})/i;
const clean=(text,max=160)=>typeof text==="string"?text.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max):"";
const stageSet=new Set(["backlog","progress","blocked","review","done"]);
const kinds=new Set(["note","focus","unfocus","stage","task_add","task_done","task_undo","task_remove"]);
export function normalizeWorkspace(input,approved){
  if(!input||typeof input!=="object"||Array.isArray(input)||input.version!==1)throw Error("Invalid workspace version");
  const allowed=new Set(approved);
  if(!Array.isArray(input.focus)||input.focus.length>3)throw Error("Focus limit exceeded");
  const focus=[...new Set(input.focus.filter(v=>repoName(v)&&allowed.has(v)))];
  const projects={};
  if(input.projects&&typeof input.projects==="object"&&!Array.isArray(input.projects)){
    for(const [name,rec] of Object.entries(input.projects)){
      if(!allowed.has(name)||!rec||typeof rec!=="object"||Array.isArray(rec))continue;
      const tasks=[],seen=new Set();
      for(const t of (Array.isArray(rec.tasks)?rec.tasks:[]).slice(0,20)){
        const title=clean(t?.title,120),id=clean(t?.id,64);
        if(!title||secretText.test(title)||!/^[\w-]{1,64}$/.test(id)||seen.has(id))continue;
        seen.add(id);tasks.push({id,title,done:t?.done===true});
      }
      projects[name]={stage:stageSet.has(rec.stage)?rec.stage:"backlog",tasks};
    }
  }
  const events=[];
  for(const e of (Array.isArray(input.events)?input.events:[]).slice(0,150)){
    const detail=clean(e?.detail,120);
    if(!allowed.has(e?.project)||!kinds.has(e?.kind)||!detail||secretText.test(detail))continue;
    const at=new Date(e?.at);
    if(Number.isNaN(at.getTime()))continue;
    events.push({project:e.project,kind:e.kind,detail,at:at.toISOString()});
  }
  return {version:1,focus,projects,events};
}
export function statusClaims(content){
  const claims=[],keys=new Set(["status","current state","release status","overall completion","completion","next action","next step","blocker","blockers","phase"]);
  for(const row of content.split(/\r?\n/).slice(0,1100)){
    const m=row.replace(/^\s*[-*]\s+/,"").replace(/\*\*/g,"").match(/^(?:#{1,6}\s*)?([a-zA-Z ]{3,30})\s*:\s*(.+)$/);
    if(!m||!keys.has(m[1].trim().toLowerCase()))continue;
    const key=clean(m[1],30),value=clean(m[2].replace(/\[([^\]]+)\]\([^)]+\)/g,"$1"),200);
    if(value&&!secretText.test(value)&&!claims.some(c=>c.key===key))claims.push({key,value});
    if(claims.length>=10)break;
  }
  return claims;
}
export function mustHaveValidConfig(env){
  const fields=["DATABASE_URL","PUBLIC_ORIGIN","GITHUB_CLIENT_ID","GITHUB_CLIENT_SECRET","GITHUB_OWNER_ID","GITHUB_OWNER_LOGIN","GITHUB_APP_ID","GITHUB_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY_PATH"];
  for(const k of fields)if(!env[k]||String(env[k]).startsWith("SET_"))throw Error("Missing mandatory server configuration: "+k);
  const origin=new URL(env.PUBLIC_ORIGIN);
  if(origin.protocol!=="https:"||origin.pathname!=="/"||origin.search||origin.hash)throw Error("PUBLIC_ORIGIN must be a single HTTPS origin");
  if(!/^\d+$/.test(env.GITHUB_OWNER_ID)||!/^\d+$/.test(env.GITHUB_APP_ID)||!/^\d+$/.test(env.GITHUB_INSTALLATION_ID))throw Error("GitHub identifiers must be numeric");
  if(!/^[A-Za-z0-9-]{1,39}$/.test(env.GITHUB_OWNER_LOGIN))throw Error("Invalid GitHub login");
  return {origin:origin.origin,ownerId:Number(env.GITHUB_OWNER_ID),ownerLogin:env.GITHUB_OWNER_LOGIN};
}
