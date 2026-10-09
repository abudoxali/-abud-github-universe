/* ABUD OS V1.6 — client-only evidence-qualified project review. No API write or private files. */
(() => {
 "use strict";
 const $=(id)=>document.getElementById(id);
 const runtime=window.ABUD_RUNTIME, board=window.ABUD_WORKBOARD, DB=window.ABUD_DATA;
 if(!runtime||!board||!DB)return;
 const ar=()=>document.documentElement.lang!=="en";
 const tr=(a,b)=>ar()?a:b;
 const iso=(x)=>{const d=new Date(x);return Number.isFinite(d.getTime())?d.toISOString():"";};
 const repoURL=(name)=>"https://github.com/"+encodeURIComponent(DB.owner)+"/"+encodeURIComponent(name);
 const clean=(s)=>String(s??"").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,220);
 const html=(s)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const md=(s)=>clean(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/([\\[\]\x60*_])/g,"\\$1");
 const dates=(v)=>new Date(v).toLocaleString(ar()?"ar-EG":"en-GB",{year:"numeric",month:"short",day:"numeric"});
 const state={period:7};
 const texts=()=>ar()?{
  title:"تقرير تنفيذ المشاريع",intro:"مراجعة للأولويات والمهام والقرارات المسجلة يدويًا، مع تغطية بيانات GitHub العامة.",
  period:"الفترة",week:"7 أيام",month:"30 يومًا",download:"تنزيل Markdown",print:"طباعة / PDF",
  focus:"مشاريع التركيز",done:"مهام منجزة",blocked:"مشاريع معلّمة Blocked",events:"أحداث الجهاز",
  recent:"مستودعات عامة حصل لها Push",coverage:"تغطية بيانات GitHub",stage:"الحالة المختارة",
  completed:"المهام المنجزة",next:"المهام المفتوحة",projectEmpty:"مفيش مشاريع للتركيز حاليًا.",
  history:"الأحداث والقرارات المسجلة",noEvents:"لا توجد أحداث محلية خلال الفترة.",
  uncategorized:"لا توجد مهام مفتوحة",date:"صدر محليًا",
  freshness:"التقرير يستخدم قائمة المستودعات العامة المتاحة حاليًا. أي تغيير جديد للخصوصية يحتاج مزامنة GitHub ناجحة.",
  coverageNote:"Last Push لا يساوي إنجازًا أو استخدامًا للمنتج.",
  disclaimer:"تقرير محلي: نسب إنجاز المهام والقرارات يسجلها المستخدم. نجاح CI أو GitHub Push ليس دليلًا على جاهزية Production. لا تدخل بيانات سرية.",
 }:{
  title:"Project Execution Report",intro:"Owner-authored tasks, decisions, and coverage-qualified public GitHub metadata.",
  period:"Period",week:"7 days",month:"30 days",download:"Download Markdown",print:"Print / PDF",
  focus:"Focus projects",done:"Completed tasks",blocked:"Projects marked Blocked",events:"Local journal events",
  recent:"Public repos pushed",coverage:"Public metadata coverage",stage:"Owner-selected stage",
  completed:"Completed tasks",next:"Open tasks",projectEmpty:"No current focus projects.",
  history:"Logged events and decisions",noEvents:"No locally recorded events in the selected period.",
  uncategorized:"No open tasks",date:"Generated locally",
  freshness:"The report uses the currently displayed public inventory. New visibility changes require a successful GitHub sync.",
  coverageNote:"Last Push does not prove product completion or usage.",
  disclaimer:"Local-only report: task completion and decisions are owner-entered. CI and GitHub push do not prove production readiness. Never include secrets."
 };
 function collect(){
  const cutoff=Date.now()-state.period*86400000;
  const w=board.getSnapshot(),publicList=runtime.getRepos(),allowed=new Set(publicList.map(r=>r.name));
  const metadata=runtime.getMetadata()||{};
  const focus=(Array.isArray(w.focus)?w.focus:[]).filter(name=>allowed.has(name)).slice(0,3);
  const events=(Array.isArray(w.events)?w.events:[])
   .filter(e=>allowed.has(e.project)&&iso(e.at)&&Date.parse(e.at)>=cutoff&&Date.parse(e.at)<=Date.now()+60000).slice(0,150);
  const projects=focus.map(name=>{
    const record=w.projects?.[name]||{stage:"backlog",tasks:[]};
    const tasks=(Array.isArray(record.tasks)?record.tasks:[]).slice(0,20);
    return {name,stage:record.stage||"backlog",completed:tasks.filter(t=>t.done===true).length,
      total:tasks.length,open:tasks.filter(t=>!t.done).map(t=>clean(t.title)),url:repoURL(name)};
  });
  const known=publicList.map(r=>({name:r.name,at:metadata[r.name]?.pushed_at}))
   .filter(x=>x.at&&iso(x.at));
  const recent=known.filter(x=>Date.parse(x.at)>=cutoff&&Date.parse(x.at)<=Date.now()+60000);
  return {at:new Date().toISOString(),days:state.period,projects,events,publicCount:publicList.length,
    knownCount:known.length,recentCount:recent.length,
    completed:projects.reduce((n,p)=>n+p.completed,0),blocked:projects.filter(p=>p.stage==="blocked").length};
 }
 function render(){
  const t=texts(),r=collect();
  $("reportTitle").textContent=t.title;$("reportIntro").textContent=t.intro;
  $("reportPeriodLabel").textContent=t.period;
  $("reportPeriod").querySelector('option[value="7"]').textContent=t.week;
  $("reportPeriod").querySelector('option[value="30"]').textContent=t.month;
  $("reportPeriod").value=String(state.period);
  $("reportMarkdown").textContent=t.download;$("reportPrint").textContent=t.print;
  $("reportHistoryTitle").textContent=t.history;
  $("reportFooter").textContent=t.disclaimer;
  $("reportFreshness").textContent=t.freshness+" "+t.recent+": "+r.recentCount+
   " · "+t.coverage+": "+r.knownCount+"/"+r.publicCount+". "+t.coverageNote;
  const cards=[[r.projects.length,t.focus],[r.completed,t.done],[r.blocked,t.blocked],[r.events.length,t.events]];
  $("reportStats").innerHTML=cards.map(([num,label])=>
    '<div class="report-stat"><strong>'+num+'</strong><span>'+html(label)+'</span></div>').join("");
  $("reportProjects").innerHTML=r.projects.length?r.projects.map(p=>{
    const tasks=p.open.slice(0,6).map(item=>'<li>'+html(item)+'</li>').join("");
    return '<article class="report-project"><h4>'+html(p.name)+'</h4>'+
      '<span class="report-stage">'+html(p.stage)+'</span>'+
      '<p>'+html(t.completed)+': '+p.completed+'/'+p.total+'</p><small>'+html(t.next)+'</small>'+
      (tasks?'<ul>'+tasks+'</ul>':'<p>'+html(t.uncategorized)+'</p>')+'</article>';
  }).join(""):'<div class="report-placeholder">'+html(t.projectEmpty)+'</div>';
  $("reportEvents").innerHTML=r.events.length?'<ul>'+r.events.slice(0,30).map(e=>
    '<li><strong>'+html(e.project)+'</strong> · '+html(e.kind)+' · '+html(e.detail)+
      '<small> · '+html(dates(e.at))+'</small></li>').join("")+'</ul>':
    '<div class="report-placeholder">'+html(t.noEvents)+'</div>';
 }
 function markdown(r){
  const t=texts(),lines=[
   "# ABUD OS — "+t.title,"",
   "- "+t.date+": "+r.at,"- "+t.period+": "+r.days,
   "- "+t.focus+": "+r.projects.length,"- "+t.done+": "+r.completed,
   "- "+t.blocked+": "+r.blocked,"- "+t.events+": "+r.events.length,
   "- "+t.recent+": "+r.recentCount,"- "+t.coverage+": "+r.knownCount+"/"+r.publicCount,
   "","## "+t.focus,""
  ];
  if(!r.projects.length)lines.push(t.projectEmpty,"");
  for(const p of r.projects){
   lines.push("### "+md(p.name),"","- "+t.stage+": "+md(p.stage),
    "- "+t.completed+": "+p.completed+"/"+p.total,"- GitHub: "+p.url,"",
    "**"+t.next+"**","");
   lines.push(...(p.open.length?p.open.map(item=>"- [ ] "+md(item)):[t.uncategorized]),"");
  }
  lines.push("## "+t.history,"");
  if(!r.events.length)lines.push(t.noEvents,"");
  for(const e of r.events.slice(0,50)){
   lines.push("- "+md(e.at.slice(0,16))+" · "+md(e.project)+" · "+md(e.kind)+" · "+md(e.detail));
  }
  lines.push("","---",t.disclaimer,t.freshness);
  return lines.join("\n")+"\n";
 }
 function download(){
  const blob=new Blob([markdown(collect())],{type:"text/markdown;charset=utf-8"});
  const objectURL=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=objectURL;a.download="abud-os-review-"+state.period+"d-"+new Date().toISOString().slice(0,10)+".md";
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(objectURL),1500);
 }
 $("reportPeriod").addEventListener("change",e=>{
  const n=Number(e.target.value);if(n===7||n===30){state.period=n;render();}
 });
 $("reportMarkdown").addEventListener("click",download);
 $("reportPrint").addEventListener("click",()=>window.print());
 window.addEventListener("abud:workboard",render);
 window.addEventListener("abud:refresh",render);
 window.ABUD_REPORT={collect,getMarkdown:()=>markdown(collect()),render};
 render();
})();
