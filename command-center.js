/* V1.1 — Daily Command Center / public project intelligence
 * Safe static browser extension. No private GitHub API calls or browser credentials.
 */
(() => {
  "use strict";
  const DB=window.ABUD_DATA;
  if(!DB) return;
  const $=(selector)=>document.querySelector(selector);
  const escapeHTML=(value)=>String(value??"").replace(/[&<>"']/g,(c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const currentRepos=()=>window.ABUD_RUNTIME?.getRepos?.() || DB.repos;
  const currentMeta=()=>window.ABUD_RUNTIME?.getMetadata?.() || {};
  const currentLang=()=>document.documentElement.lang==="en"?"en":"ar";
  const isArabic=()=>currentLang()==="ar";
  const select=(ar,en)=>isArabic()?ar:en;
  const getRepo=(name)=>currentRepos().find(r=>r.name===name);
  const repoPath=(name)=>"https://github.com/"+encodeURIComponent(DB.owner)+"/"+encodeURIComponent(name);
  const hubHash=(name)=>"#project/"+encodeURIComponent(name);
  const statuses={Video_Factory:{ar:"التركيز الرئيسي",en:"MAIN DELIVERY"},ReplyOps:{ar:"التالي في التنفيذ",en:"NEXT IN QUEUE"},RootRay:{ar:"نمو وتوزيع",en:"GROWTH"}};
  const priorityNames=["Video_Factory","ReplyOps","RootRay"];
  let renderedName=null;
  let activityRequest=0;
  let activity=null;
  const ACTIVITY_TTL=15*60*1000;

  function getCopy(){
    return isArabic()?{
      title:"مركز القيادة اليومي",subtitle:"3 أولويات واضحة. مش كل Commit معناه تقدم.",date:"مراجعة يومية · ",
      lead:"01 / MAIN FOCUS",leadLink:"افتح ملف المشروع",queueLink:"عرض التفاصيل ↗",
      queueNext:"الخطوة التالية", note1:"المستودعات العامة",note1Detail:"ظاهرة في الـDashboard",
      note2:"تحتاج مراجعة",note2Detail:"مشاريع Cleanup / Archive",
      note3:"البيانات الحية",note3Detail:"GitHub metadata منفصلة عن جاهزية المنتج",
      back:"العودة للوحة التحكم",action:"الخطوة التالية المعتمدة",
      commit:"آخر Commit على GitHub",ci:"آخر GitHub Actions",
      source:"روابط المصادر",meta:"البيانات العامة",
      review:"ملاحظات المراجعة",repo:"فتح GitHub ↗",copy:"نسخ التكليف",
      loading:"جاري التحقق من GitHub...",empty:"لا توجد بيانات متاحة بعد",
      notAvailable:"غير متاح للتحقق حاليًا",notVerified:"لم يتم التحقق من CI",
      noWorkflow:"لا توجد Workflow Runs مثبتة لهذا الفرع",
      noCommits:"لا توجد Commits يمكن التحقق منها",
      public:"Public — تم التحقق من ظهور المستودع",
      stale:"معلومات GitHub وقت آخر جلب ناجح",
      privacy:"يظهر هنا المشاريع العامة فقط. نجاح CI لا يعني جاهزية المنتج للإنتاج. حالة المنتج المعروضة مستمدة من مراجعة مستقلة وقد تصبح قديمة.",
      notPublic:"المشروع لم يعد متاحًا ضمن المستودعات العامة.",
      copied:"تم نسخ الخطوة التالية.",copyFailed:"تعذر النسخ تلقائيًا.",
      pushed:"آخر Push",stars:"Stars",branch:"Branch",language:"Language",
      readme:"README",status:"STATUS.md (إن وجد)",actions:"GitHub Actions",noDetail:"لم يتم التحقق من وجود ملفات التوثيق بعد.",
      latest:"عرض آخر Commit",run:"عرض Workflow Run",pending:"قيد التنفيذ",unknown:"غير معروف",
      noActivity:"GitHub API غير متاح حاليًا. تم الاحتفاظ بالحالة التحريرية بدون افتراضات."
    }:{
      title:"Daily Command Center",subtitle:"Three clear priorities. Commits are not product outcomes.",date:"Daily view · ",
      lead:"01 / MAIN FOCUS",leadLink:"Open project hub",queueLink:"Open project ↗",
      queueNext:"Next action",note1:"Public repositories",note1Detail:"Visible in the dashboard",
      note2:"Need review",note2Detail:"Cleanup / Archive projects",
      note3:"Live information",note3Detail:"GitHub metadata ≠ product readiness",
      back:"Back to dashboard",action:"Curated next action",
      commit:"Last GitHub commit",ci:"Latest GitHub Actions run",
      source:"Evidence & links",meta:"Public GitHub metadata",
      review:"Review notes",repo:"Open GitHub ↗",copy:"Copy next action",
      loading:"Checking public GitHub...",empty:"No information yet",
      notAvailable:"Currently unavailable to verify",notVerified:"CI not verified",
      noWorkflow:"No workflow runs confirmed for this branch",
      noCommits:"No verifiable commits found",
      public:"Public — visibility confirmed",stale:"GitHub data from last successful fetch",
      privacy:"Only public repositories are displayed. A passing CI run is not production verification. Editorial product assessments are reviewed separately and can become stale.",
      notPublic:"This project is no longer in the public repository inventory.",
      copied:"Next action copied.",copyFailed:"Automatic copy failed.",
      pushed:"Last push",stars:"Stars",branch:"Branch",language:"Language",
      readme:"README",status:"STATUS.md (if present)",actions:"GitHub Actions",noDetail:"Documentation existence has not been checked.",
      latest:"View commit",run:"View workflow run",pending:"In progress",unknown:"Unknown",
      noActivity:"GitHub API is currently unavailable. No readiness claims were inferred."
    };
  }
  function dateLabel(date){
    const value=new Date(date);
    if(Number.isNaN(value.getTime()))return "";
    return value.toLocaleDateString(isArabic()?"ar-EG":"en-GB",{day:"numeric",month:"short",year:"numeric"});
  }
  function renderDaily(){
    const words=getCopy(), visible=currentRepos(), publicNames=new Set(visible.map(r=>r.name));
    $("#dailyTitle").textContent=words.title;
    $("#dailySubtitle").textContent=words.subtitle;
    $("#dailyDate").textContent=words.date+dateLabel(new Date());
    $("#navDailyLabel").textContent=isArabic()?"مركز اليوم":"Today";
    $("#drawerOpenHub").textContent=isArabic()?"افتح ملف المشروع التفصيلي ↗":"Open project hub ↗";
    const selected=window.ABUD_WORKBOARD?.getFocusNames?.() || priorityNames;
    const list=selected.map(name=>getRepo(name)).filter(Boolean);
    const lead=list[0];
    $("#dailyLead").innerHTML=lead?'<div class="mini-kicker"><i></i>'+escapeHTML(words.lead)+'</div>'+
      '<h3>'+escapeHTML(lead.name)+'</h3>'+
      '<div class="lead-state">'+escapeHTML(lead.status)+'</div>'+
      '<p class="lead-action">'+escapeHTML(select(lead.nextAr,lead.nextEn))+'</p>'+
      '<div class="daily-actions"><a class="btn btn-primary" href="'+hubHash(lead.name)+'">'+escapeHTML(words.leadLink)+' ↗</a>'+
      '<a class="btn btn-outline" target="_blank" rel="noopener noreferrer" href="'+repoPath(lead.name)+'">GitHub ↗</a></div>':
      '<div class="mini-kicker">'+escapeHTML(words.notAvailable)+'</div>';
    $("#dailyQueue").innerHTML=list.slice(1,3).map((r,i)=>{
      const tier=statuses[r.name]||{};
      return '<article class="queue-card" style="--accent:'+(i===0?'#fbbf24':'#2dd4bf')+'">'+
        '<div><div class="queue-label">'+escapeHTML(select(tier.ar||r.status,tier.en||r.status))+'</div>'+
        '<h3>'+escapeHTML(r.name)+'</h3><p>'+escapeHTML(select(r.nextAr,r.nextEn))+'</p></div>'+
        '<div class="queue-action"><span>'+escapeHTML(r.status)+'</span><a href="'+hubHash(r.name)+'">'+escapeHTML(words.queueLink)+'</a></div></article>';
    }).join("");
    const risk=visible.filter(r=>r.category==="cleanup"||r.category==="archive").length;
    const notes=[
      [String(publicNames.size).padStart(2,"0"),words.note1,words.note1Detail],
      [String(risk).padStart(2,"0"),words.note2,words.note2Detail],
      ["↻",words.note3,words.note3Detail]
    ];
    $("#dailyNotes").innerHTML=notes.map(([num,title,body])=>
      '<div class="daily-note"><div class="note-symbol">'+escapeHTML(num)+'</div>'+
      '<div><strong>'+escapeHTML(title)+'</strong><span>'+escapeHTML(body)+'</span></div></div>'
    ).join("");
  }
  function showHub(name){
    const r=getRepo(name);
    if(!r){
      // Never reveal private or deleted data through stale deep links.
      document.body.classList.remove("project-mode");
      $("#projectHub").hidden=true;
      if(location.hash.startsWith("#project/"))history.replaceState(null,"","#daily");
      renderedName=null;
      return;
    }
    const c=getCopy();
    document.body.classList.add("project-mode");
    $("#projectHub").hidden=false;
    $("#hubBackLabel").textContent=c.back;
    $("#hubCategory").textContent=r.status+"  /  "+r.category.toUpperCase();
    $("#hubTitle").textContent=r.name;
    $("#hubDescription").textContent=select(r.ar,r.en);
    $("#hubRepoLink").href=repoPath(name);
    $("#hubNext").textContent=select(r.nextAr,r.nextEn);
    $("#hubReview").textContent=r.note||c.noDetail;
    $("#hubActionLabel").textContent=c.action;
    $("#hubCommitLabel").textContent=c.commit;
    $("#hubCiLabel").textContent=c.ci;
    $("#hubEvidenceLabel").textContent=c.source;
    $("#hubMetaLabel").textContent=c.meta;
    $("#hubDisclaimer").textContent=c.privacy;
    $("#hubCopyBrief").textContent=c.copy;
    const gh=repoPath(name);
    $("#hubEvidence").innerHTML='<div class="evidence-links">'+
      '<a target="_blank" rel="noopener noreferrer" href="'+gh+'/blob/HEAD/README.md">'+escapeHTML(c.readme)+' ↗</a>'+
      '<a target="_blank" rel="noopener noreferrer" href="'+gh+'/blob/HEAD/STATUS.md">'+escapeHTML(c.status)+' ↗</a>'+
      '<a target="_blank" rel="noopener noreferrer" href="'+gh+'/actions">'+escapeHTML(c.actions)+' ↗</a></div>';
    if(renderedName!==name){
      renderedName=name;
      activity=null;
      $("#hubCommit").textContent=c.loading;
      $("#hubCi").textContent=c.loading;
      $("#hubInfo").textContent=c.loading;
      void refreshProjectActivity(name);
    }else if(activity)renderActivity(activity);
    window.scrollTo({top:0,behavior:"instant"});
  }

  async function fetchPublic(url){
    const response=await fetch(url,{headers:{"Accept":"application/vnd.github+json"}});
    if(response.status===403||response.status===429)throw new Error("RATE_LIMITED");
    if(response.status===404||response.status===409)return null;
    if(!response.ok)throw new Error("GitHub API "+response.status);
    return response.json();
  }
  async function fetchActivity(name){
    // Explicitly re-check PUBLIC repo visibility before reading commits or CI.
    const endpoint="https://api.github.com/repos/"+encodeURIComponent(DB.owner)+"/"+encodeURIComponent(name);
    const rep=await fetchPublic(endpoint);
    if(!rep||rep.private===true||rep.visibility==="private"||rep.owner?.login?.toLowerCase()!==DB.owner.toLowerCase()){
      return {notPublic:true};
    }
    const branch=rep.default_branch||"main";
    const results=await Promise.allSettled([
      fetchPublic(endpoint+"/commits?per_page=1&sha="+encodeURIComponent(branch)),
      fetchPublic(endpoint+"/actions/runs?per_page=5&branch="+encodeURIComponent(branch))
    ]);
    const commit=results[0].status==="fulfilled" && Array.isArray(results[0].value)?results[0].value[0]||null:null;
    const runs=results[1].status==="fulfilled"?results[1].value?.workflow_runs||[]:[];
    const latestRun=runs[0]||null;
    return {
      repo:{default_branch:branch,language:rep.language||null,stargazers_count:rep.stargazers_count||0,pushed_at:rep.pushed_at||null},
      commit,latestRun,
      commitError:results[0].status==="rejected",
      ciError:results[1].status==="rejected",
      obtainedAt:Date.now()
    };
  }
  function readCache(name){
    try{
      const item=JSON.parse(localStorage.getItem("abud-v11-activity:"+name)||"null");
      return item&&item.obtainedAt&&Date.now()-item.obtainedAt<ACTIVITY_TTL?item:null;
    }catch(_){return null;}
  }
  function writeCache(name,data){
    try{localStorage.setItem("abud-v11-activity:"+name,JSON.stringify(data));}catch(_){}
  }
  async function refreshProjectActivity(name){
    const token=++activityRequest,cached=readCache(name);
    if(cached){activity=cached;renderActivity(cached);return;}
    try{
      const fresh=await fetchActivity(name);
      if(token!==activityRequest||renderedName!==name)return;
      if(fresh.notPublic){
        // Membership may change between background inventory checks.
        location.hash="#daily";
        return;
      }
      activity=fresh;writeCache(name,fresh);renderActivity(fresh);
    }catch(_){
      if(token!==activityRequest||renderedName!==name)return;
      const c=getCopy();
      $("#hubCommit").textContent=c.noActivity;
      $("#hubCi").textContent=c.noActivity;
      $("#hubInfo").textContent=c.notAvailable;
    }
  }
  function renderActivity(data){
    const c=getCopy();
    const commit=$("#hubCommit"),ci=$("#hubCi"),info=$("#hubInfo");
    if(!data?.repo)return;
    const last=data.commit;
    if(last?.sha){
      const message=last.commit?.message?.split("\n")[0]||last.sha.slice(0,8);
      const ref=last.sha.slice(0,8);
      commit.innerHTML='<div class="activity-head">'+escapeHTML(message)+'</div>'+
        '<div class="activity-time">'+escapeHTML(ref)+' · '+escapeHTML(dateLabel(last.commit?.committer?.date||last.commit?.author?.date))+'</div>'+
        '<a class="activity-link" target="_blank" rel="noopener noreferrer" href="'+repoPath(renderedName)+'/commit/'+encodeURIComponent(last.sha)+'">'+escapeHTML(c.latest)+' ↗</a>';
    }else commit.textContent=data.commitError?c.notAvailable:c.noCommits;
    const run=data.latestRun;
    if(run){
      const conclusion=run.conclusion||(run.status==="completed"?"neutral":"in_progress");
      const kind=conclusion==="success"?"success":["failure","cancelled","timed_out","action_required"].includes(conclusion)?"failure":"pending";
      ci.innerHTML='<span class="activity-status '+kind+'">'+escapeHTML(conclusion.toUpperCase())+'</span>'+
        '<div class="activity-head">'+escapeHTML(run.name||"GitHub Workflow")+'</div>'+
        '<div class="activity-time">'+escapeHTML(dateLabel(run.updated_at||run.created_at))+'</div>'+
        (run.html_url&&run.html_url.startsWith("https://github.com/")?
          '<a class="activity-link" rel="noopener noreferrer" target="_blank" href="'+escapeHTML(run.html_url)+'">'+escapeHTML(c.run)+' ↗</a>':"");
    }else ci.textContent=data.ciError?c.notVerified:c.noWorkflow;
    info.innerHTML='<div class="detail-list">'+[
      c.public,
      c.branch+": "+data.repo.default_branch,
      c.language+": "+(data.repo.language||c.unknown),
      c.stars+": "+String(data.repo.stargazers_count),
      c.pushed+": "+(dateLabel(data.repo.pushed_at)||c.unknown),
      c.stale+": "+dateLabel(data.obtainedAt)
    ].map(x=>'<span>'+escapeHTML(x)+'</span>').join("")+'</div>';
  }
  function route(){
    const hash=window.location.hash;
    if(hash.startsWith("#project/")){
      let name;
      try{name=decodeURIComponent(hash.slice("#project/".length));}
      catch(_){window.location.hash="#daily";return;}
      if(!getRepo(name)){
        document.body.classList.remove("project-mode");
        $("#projectHub").hidden=true;
        renderedName=null;
        window.location.hash="#daily";
        return;
      }
      showHub(name);
    }else{
      if(document.body.classList.contains("project-mode")){
        document.body.classList.remove("project-mode");
        $("#projectHub").hidden=true;
        renderedName=null;
        activityRequest++;
        activity=null;
        const anchor=hash.slice(1);
        if(anchor&&document.getElementById(anchor))document.getElementById(anchor).scrollIntoView({block:"start"});
      }
    }
  }
  function brief(){
    const name=renderedName,r=getRepo(name);
    if(!r)return "";
    return "Project: "+r.name+"\nStatus: "+r.status+
      "\nCurrent objective: "+r.nextEn+
      "\nReview context: "+(r.note||"Review STATUS.md")+
      "\nRepository: "+repoPath(name)+
      "\nInspect the repository and canonical STATUS.md first. Execute verified highest-priority work directly, test it, avoid unrelated changes, and update only STATUS.md. Do not create a roadmap.";
  }
  async function copyBrief(){
    if(!renderedName)return;
    try{await navigator.clipboard.writeText(brief());$("#hubCopyBrief").textContent=getCopy().copied;}
    catch(_){$("#hubCopyBrief").textContent=getCopy().copyFailed;}
    setTimeout(()=>{$("#hubCopyBrief").textContent=getCopy().copy;},2000);
  }
  function start(){
    renderDaily();
    route();
    window.addEventListener("hashchange",route);
    window.addEventListener("abud:workboard",renderDaily);
    window.addEventListener("abud:refresh",()=>{
      renderDaily();
      if(document.body.classList.contains("project-mode")||location.hash.startsWith("#project/"))route();
    });
    document.addEventListener("click",(e)=>{
      const hub=e.target.closest("[data-hub]");
      if(hub){e.preventDefault();location.hash=hubHash(hub.dataset.hub);}
    });
    $("#drawerOpenHub").addEventListener("click",()=>{
      const title=$("#drawerName").textContent;
      if(getRepo(title)){
        $("#drawerClose").click();
        location.hash=hubHash(title);
      }
    });
    $("#hubCopyBrief").addEventListener("click",copyBrief);
    $("#hubBack").addEventListener("click",()=>{
      $("#projectHub").hidden=true;
      document.body.classList.remove("project-mode");
    });
  }
  window.ABUD_COMMAND={
    renderDaily,route,
    getPublicActivity:(name)=>{
      if(renderedName!==name || !activity?.repo)return null;
      return {
        sha:activity.commit?.sha||null,
        ci:activity.latestRun?.conclusion||activity.latestRun?.status||null,
        observedAt:activity.obtainedAt||null
      };
    }
  };
  start();
})();
