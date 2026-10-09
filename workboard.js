/* ABUD OS V1.4 — offline, browser-only personal execution workboard.
 * PUBLIC-ONLY repo selection, capped WIP, no network write, no GitHub tokens.
 * LocalStorage is device-specific and NOT suitable for secrets.
 */
(() => {
  "use strict";
  const DB=window.ABUD_DATA,api=window.ABUD_RUNTIME;
  if(!DB||!api)return;
  const $=q=>document.querySelector(q);
  const store="abud-os-workboard-v1";
  const MAX_FOCUS=3,MAX_TASKS=20,MAX_TITLE=120,MAX_EVENTS=150;
  const stages=["backlog","progress","blocked","review","done"];
  const eventTypes=["focus","unfocus","stage","task_add","task_done","task_undo","task_remove","note"];
  const defaults=["Video_Factory","ReplyOps","RootRay"];
  const isArabic=()=>document.documentElement.lang!=="en";
  const choose=(a,en)=>isArabic()?a:en;
  const safe=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const names=()=>new Set(api.getRepos().map(r=>r.name));
  const getRepo=name=>api.getRepos().find(r=>r.name===name);
  const validName=name=>typeof name==="string"&&name.length<200&&names().has(name);
  const scrubText=v=>typeof v==="string"?v.trim().replace(/[\u0000-\u001f\u007f]/g," ").slice(0,MAX_TITLE):"";
  const blockSecrets=/(?:-----BEGIN .*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[\w]{10,}|sk-[A-Za-z0-9_-]{14,}|(?:password|passphrase|api[_ -]?key|secret|access[_ -]?token)\s*[:=])/i;
  const textOK=value=>value.length>0&&!blockSecrets.test(value);
  const repoPath=name=>"https://github.com/"+DB.owner+"/"+encodeURIComponent(name);
  const now=()=>new Date().toISOString();
  const initial=()=>({version:1,focus:defaults.filter(name=>names().has(name)).slice(0,MAX_FOCUS),projects:{},events:[],updatedAt:now()});
  function validate(raw){
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||raw.version!==1)throw new Error("Unsupported workspace format");
    if(!Array.isArray(raw.focus)||raw.focus.length>MAX_FOCUS)throw new Error("Focus limit exceeded");
    if(raw.projects===null||typeof raw.projects!=="object"||Array.isArray(raw.projects))throw new Error("Invalid project records");
    const allowed=names();
    const focus=[...new Set(raw.focus.filter(n=>typeof n==="string"&&allowed.has(n)))].slice(0,MAX_FOCUS);
    const projects={};
    for(const [key,value] of Object.entries(raw.projects)){
      if(!allowed.has(key))continue; // ignore hidden, renamed or deleted repos on import
      if(!value||typeof value!=="object"||Array.isArray(value))continue;
      const stage=stages.includes(value.stage)?value.stage:"backlog";
      const tasks=[];
      if(Array.isArray(value.tasks)){
        for(const entry of value.tasks.slice(0,MAX_TASKS)){
          if(!entry||typeof entry!=="object")continue;
          const title=scrubText(entry.title);
          if(!textOK(title))continue;
          tasks.push({
            id:typeof entry.id==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)?entry.id:generateId(),
            title,done:entry.done===true
          });
        }
      }
      const seen=new Set();
      projects[key]={stage,tasks:tasks.filter(task=>{
        if(seen.has(task.id))return false;seen.add(task.id);return true;
      })};
    }
    const events=Array.isArray(raw.events)?raw.events.slice(0,MAX_EVENTS).filter(x=>{
      return x&&typeof x==="object"&&allowed.has(x.project)&&eventTypes.includes(x.kind)&&
        typeof x.at==="string"&&!Number.isNaN(Date.parse(x.at));
    }).map(x=>({
      id:typeof x.id==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(x.id)?x.id:generateId(),
      project:x.project,kind:x.kind,
      detail:textOK(scrubText(x.detail))?scrubText(x.detail):"",
      at:new Date(x.at).toISOString()
    })).filter(x=>x.detail):[];
    return {version:1,focus,projects,events,updatedAt:now()};
  }
  function generateId(){
    if(typeof crypto!=="undefined"&&typeof crypto.randomUUID==="function")return crypto.randomUUID();
    return "t"+Date.now().toString(36)+Math.random().toString(36).slice(2,9);
  }
  function read(){
    try{
      const item=localStorage.getItem(store);
      return item?validate(JSON.parse(item)):initial();
    }catch(_){return initial();}
  }
  let state=read();
  let lastMessage="";
  const phrases=()=>isArabic()?{
    title:"لوحة التنفيذ الشخصية",subtitle:"3 مشاريع للتركيز كحد أقصى. نظّم الخطوات الحقيقية بدل تشتيت العمل على عشرات الـRepos.",
    local:"LOCAL BROWSER ONLY",choose:"اختار مشروع عام",add:"أضف للتركيز",
    export:"تصدير JSON",import:"استيراد JSON",reset:"مسح بيانات الجهاز",
    label:"لوحة التنفيذ",privacy:"المهام محفوظة في المتصفح على هذا الجهاز فقط. لا تكتب كلمات مرور أو بيانات خاصة. التصدير يحتاج حفظ الملف بنفسك ولا توجد مزامنة حسابات.",
    focus:"مشاريع التركيز",open:"مهام مفتوحة",done:"مهام منجزة",blocked:"مشاريع متعطلة",
    empty:"لم تختَر أي مشروع بعد. اختار مشروع من القائمة وأضفه للتركيز.",
    tasksEmpty:"لا توجد مهام مكتوبة. ابدأ بأصغر خطوة قابلة للتحقق.",
    taskHint:"اكتب خطوة عملية قصيرة...",taskAdd:"إضافة مهمة",remove:"إزالة من التركيز",
    link:"فتح ملف المشروع",progress:"من المهام المكتوبة اكتمل",saved:"محفوظ على الجهاز",
    unavailable:"متصفحك منع التخزين المحلي. التغييرات قد تضيع بعد إغلاق الصفحة.",
    cap:"الحد الأقصى 3 مشاريع للتركيز. أزل مشروعًا أولًا.",
    invalid:"استخدم ملف JSON صالحًا ببيانات الـWorkboard فقط (حد أقصى 1MB).",
    imported:"تم استيراد البيانات المحلية للمشاريع العامة الحالية فقط.",
    exported:"تم تنزيل نسخة JSON محلية.",
    confirm:"هل تريد حذف لوحة التنفيذ والمهام المحفوظة في هذا المتصفح؟",
    cleared:"تم مسح اللوحة المحلية.",rejected:"لا تضف كلمات مرور أو رموز API إلى المهام.",
    maxTasks:"الحد الأقصى 20 مهمة لكل مشروع.",
    backlog:"بانتظار البدء",progressStage:"قيد التنفيذ",blockedStage:"متوقف / Blocked",
    reviewStage:"يحتاج مراجعة",doneStage:"مكتمل (بتأكيدك)",
    noOptions:"لا توجد مشاريع عامة أخرى"
  }:{
    title:"Personal Execution Workboard",subtitle:"Focus on at most three projects. Track real next steps, not just repository activity.",
    local:"LOCAL BROWSER ONLY",choose:"Choose a public project",add:"Add to focus",
    export:"Export JSON",import:"Import JSON",reset:"Clear this device",
    label:"Workboard",privacy:"Tasks are saved in this browser only. Do not enter secrets or private information. Export files manually; this is not account sync.",
    focus:"Focus projects",open:"Open tasks",done:"Completed tasks",blocked:"Blocked projects",
    empty:"No focus projects selected. Choose one above to get started.",
    tasksEmpty:"No written tasks. Add the smallest verifiable next action.",
    taskHint:"Write a short actionable next step...",taskAdd:"Add task",remove:"Remove from focus",
    link:"Open project hub",progress:"of written tasks completed",saved:"Saved on this device",
    unavailable:"Browser storage is unavailable. Changes may not persist after closing this page.",
    cap:"Maximum three focus projects. Remove one first.",
    invalid:"Choose a valid Workboard JSON file (up to 1MB).",
    imported:"Imported local data for currently public projects only.",
    exported:"Local JSON backup downloaded.",
    confirm:"Delete all locally saved workboard tasks and preferences in this browser?",
    cleared:"Local workspace cleared.",rejected:"Do not store passwords or API tokens in tasks.",
    maxTasks:"Maximum 20 tasks per project.",
    backlog:"Backlog",progressStage:"In progress",blockedStage:"Blocked",
    reviewStage:"Needs review",doneStage:"Done (your confirmation)",
    noOptions:"No other public projects"
  };
  const stageLabels=(w)=>[
    ["backlog",w.backlog],["progress",w.progressStage],["blocked",w.blockedStage],
    ["review",w.reviewStage],["done",w.doneStage]
  ];
  function record(name){
    if(!state.projects[name])state.projects[name]={stage:"backlog",tasks:[]};
    return state.projects[name];
  }
  function announce(message){
    lastMessage=message;
    const el=$("#workSaveIndicator");el.textContent=message;
  }
  function persist(){
    state.updatedAt=now();
    try{localStorage.setItem(store,JSON.stringify(state));announce(phrases().saved);}
    catch(_){announce(phrases().unavailable);}
    window.dispatchEvent(new Event("abud:workboard"));
  }
  function reconcile(){
    const allowed=names();
    const old=JSON.stringify(state);
    state.focus=state.focus.filter(name=>allowed.has(name)).slice(0,MAX_FOCUS);
    state.projects=Object.fromEntries(Object.entries(state.projects).filter(([name])=>allowed.has(name)));
    state.events=(state.events||[]).filter(item=>allowed.has(item.project)).slice(0,MAX_EVENTS);
    // Invalidate hidden- or deleted-project records in browser storage too.
    if(JSON.stringify(state)!==old)persist();
  }
  function addEvent(project,kind,detail){
    if(!validName(project)||!eventTypes.includes(kind))return;
    const value=scrubText(detail);
    if(!textOK(value))return;
    state.events=[{id:generateId(),project,kind,detail:value,at:now()},...(state.events||[])].slice(0,MAX_EVENTS);
  }
  function summary(w){
    const focus=state.focus.filter(validName),records=focus.map(name=>record(name));
    const total=records.reduce((x,p)=>x+p.tasks.length,0),done=records.reduce((x,p)=>x+p.tasks.filter(t=>t.done).length,0);
    const cards=[
      [String(focus.length)+"/3",w.focus], [String(total-done),w.open],
      [String(done),w.done],[String(records.filter(p=>p.stage==="blocked").length),w.blocked]
    ];
    $("#workSummary").innerHTML=cards.map(([value,label])=>
      '<div class="work-summary-card"><strong>'+safe(value)+'</strong><span>'+safe(label)+'</span></div>'
    ).join("");
  }
  function stageOption(stage,selected,label){
    return '<option value="'+stage+'" '+(selected===stage?"selected":"")+'>'+safe(label)+'</option>';
  }
  function projectCard(name,index,w){
    const r=getRepo(name);if(!r)return "";
    const p=record(name),count=p.tasks.length,done=p.tasks.filter(t=>t.done).length;
    const ratio=count?Math.round(done/count*100):0;
    const options=stageLabels(w).map(([stage,label])=>stageOption(stage,p.stage,label)).join("");
    const tasks=p.tasks.length?p.tasks.map(task=>
      '<li class="work-task '+(task.done?"done":"")+'">'+
      '<input type="checkbox" data-task-toggle="'+safe(name)+'" data-task-id="'+safe(task.id)+'" '+
      (task.done?"checked ":"")+'aria-label="'+safe(task.title)+'">'+
      '<span>'+safe(task.title)+'</span>'+
      '<button type="button" data-task-remove="'+safe(name)+'" data-task-id="'+safe(task.id)+'" aria-label="Remove task">×</button></li>'
    ).join(""):'<li class="work-task-empty">'+safe(w.tasksEmpty)+'</li>';
    return '<article class="work-project" data-work-project="'+safe(name)+'">'+
      '<div class="work-project-head"><div><h3 class="work-project-title">'+safe(name)+'</h3>'+
      '<small>FOCUS '+(index+1)+' · '+safe(r.status)+'</small></div>'+
      '<button class="work-unpin" data-unpin="'+safe(name)+'" type="button" aria-label="'+safe(w.remove)+'" title="'+safe(w.remove)+'">×</button></div>'+
      '<select class="work-status-select" data-work-stage="'+safe(name)+'" aria-label="Project execution stage">'+options+'</select>'+
      '<div><div class="work-progress-bar" aria-label="'+ratio+'%"><i style="width:'+ratio+'%"></i></div>'+
      '<div class="work-progress-caption">'+done+' / '+count+' '+safe(w.progress)+'</div></div>'+
      '<ul class="work-task-list">'+tasks+'</ul>'+
      '<form class="work-add-task" data-task-form="'+safe(name)+'">'+
      '<input name="title" required maxlength="120" autocomplete="off" placeholder="'+safe(w.taskHint)+'" aria-label="'+safe(w.taskAdd)+'">'+
      '<button type="submit" title="'+safe(w.taskAdd)+'">+</button></form>'+
      '<a class="work-project-link" href="#project/'+encodeURIComponent(name)+'">'+safe(w.link)+' ↗</a></article>';
  }
  function renderHistory(){
    const w=phrases();
    const ar=isArabic();
    const word=ar?{
      title:"سجل الإنجاز والقرارات",intro:"أحداث سجلتها على هذا الجهاز، وليست بيانات GitHub أو دليل تشغيل Production.",
      choose:"اختار مشروع التركيز",hint:"اكتب قرارًا أو عقبة قصيرة...",add:"أضف قرار",
      filter:"الفترة",week:"7 أيام",month:"30 يومًا",all:"كل السجل",
      count:"حدث محلي",done:"مهمة مكتملة",notes:"ملاحظات وقرارات",empty:"مفيش أحداث محفوظة في الفترة دي.",
      eventNames:{focus:"تركيز جديد",unfocus:"خرج من التركيز",stage:"تغيير الحالة",
        task_add:"مهمة جديدة",task_done:"إنجاز مهمة",task_undo:"إلغاء الإنجاز",task_remove:"حذف مهمة",note:"قرار مسجل"}
    }:{
      title:"Progress & Decision Journal",intro:"Locally recorded actions, not GitHub commits or verified production evidence.",
      choose:"Choose focus project",hint:"Record a brief decision or blocker...",add:"Add decision",
      filter:"Period",week:"7 days",month:"30 days",all:"Full history",
      count:"local events",done:"completed tasks",notes:"decision notes",empty:"No locally recorded events in this period.",
      eventNames:{focus:"Added focus",unfocus:"Removed focus",stage:"Changed stage",
        task_add:"New task",task_done:"Completed task",task_undo:"Reopened task",task_remove:"Removed task",note:"Decision note"}
    };
    $("#historyTitle").textContent=word.title;
    $("#historyIntro").textContent=word.intro;
    $("#historyFilterLabel").textContent=word.filter;
    const select=$("#historyFilter"),period=select.value;
    select.querySelector('option[value="7"]').textContent=word.week;
    select.querySelector('option[value="30"]').textContent=word.month;
    select.querySelector('option[value="all"]').textContent=word.all;
    select.value=period||"7";
    $("#workNoteText").placeholder=word.hint;
    $("#workNoteText").setAttribute("aria-label",word.hint);
    $("#workNoteAdd").textContent="+ "+word.add;
    const projects=$("#workNoteProject"),before=projects.value;
    projects.replaceChildren();
    for(const n of state.focus.filter(validName)){
      const o=document.createElement("option");o.value=n;o.textContent=n;projects.appendChild(o);
    }
    if([...projects.options].some(o=>o.value===before))projects.value=before;
    $("#workNoteAdd").disabled=!projects.options.length;
    $("#workNoteText").disabled=!projects.options.length;
    const threshold=period==="all"?-Infinity:Date.now()-Number(period||7)*86400000;
    const events=(state.events||[]).filter(e=>validName(e.project)&&new Date(e.at).getTime()>=threshold);
    $("#workHistoryMetrics").innerHTML=[
      events.length+" "+word.count,
      events.filter(x=>x.kind==="task_done").length+" "+word.done,
      events.filter(x=>x.kind==="note").length+" "+word.notes
    ].map(x=>'<span>'+safe(x)+'</span>').join("");
    $("#workHistoryList").innerHTML=events.length?events.slice(0,50).map(event=>{
      const label=word.eventNames[event.kind]||event.kind;
      return '<li class="work-history-event"><div class="event-sign">'+safe(event.kind==="task_done"?"✓":event.kind==="note"?"✎":"↗")+'</div>'+
      '<div><strong>'+safe(event.project)+' · '+safe(label)+'</strong><p>'+safe(event.detail)+'</p>'+
      '<small>'+safe(new Date(event.at).toLocaleString(ar?"ar-EG":"en-GB"))+'</small></div></li>';
    }).join(""):'<li class="work-history-empty">'+safe(word.empty)+'</li>';
  }
  function addNote(project,value){
    if(!state.focus.includes(project)||!validName(project))return;
    const note=scrubText(value);
    if(!textOK(note)){announce(phrases().rejected);return;}
    addEvent(project,"note",note);persist();render();
  }
  function render(){
    reconcile();
    const w=phrases();
    $("#navWorkboard").textContent=w.label;
    $("#workTitle").textContent=w.title;$("#workSubtitle").textContent=w.subtitle;
    $("#workStorageLabel").textContent=w.local;
    $("#workChooseLabel").textContent=w.choose;
    $("#workPin").textContent="+ "+w.add;
    $("#workExport").textContent=w.export;$("#workImport").textContent=w.import;
    $("#workReset").textContent=w.reset;$("#workPrivacy").textContent=w.privacy;
    $("#workSaveIndicator").textContent=lastMessage||w.saved;
    summary(w);
    const options=api.getRepos().filter(r=>!state.focus.includes(r.name)).sort((a,b)=>a.name.localeCompare(b.name));
    const picker=$("#workProjectSelect");
    const previous=picker.value;
    picker.replaceChildren();
    if(!options.length){
      const op=document.createElement("option");op.value="";op.textContent=w.noOptions;picker.appendChild(op);
    }else{
      for(const r of options){const op=document.createElement("option");op.value=r.name;op.textContent=r.name;picker.appendChild(op);}
      if(options.some(x=>x.name===previous))picker.value=previous;
    }
    $("#workPin").disabled=state.focus.length>=MAX_FOCUS||!options.length;
    $("#workProjects").innerHTML=state.focus.length?
      state.focus.map((name,i)=>projectCard(name,i,w)).join(""):
      '<div class="work-empty">'+safe(w.empty)+'</div>';
    renderHistory();
  }
  function focus(name){
    if(!validName(name)||state.focus.includes(name))return;
    if(state.focus.length>=MAX_FOCUS){announce(phrases().cap);return;}
    state.focus.push(name);record(name);addEvent(name,"focus","Added to daily focus");persist();render();
  }
  function removeFocus(name){
    state.focus=state.focus.filter(n=>n!==name);
    addEvent(name,"unfocus","Removed from daily focus");
    // Keep tasks for this still-public repo, so re-adding does not erase work.
    persist();render();
  }
  function updateStage(name,stage){
    if(!state.focus.includes(name)||!stages.includes(stage)||!validName(name))return;
    record(name).stage=stage;addEvent(name,"stage","Stage changed to "+stage);persist();render();
  }
  function addTask(name,value){
    if(!validName(name)||!state.focus.includes(name))return;
    const title=scrubText(value);
    if(!textOK(title)){announce(phrases().rejected);return;}
    const p=record(name);
    if(p.tasks.length>=MAX_TASKS){announce(phrases().maxTasks);return;}
    p.tasks.push({id:generateId(),title,done:false});addEvent(name,"task_add",title);persist();render();
  }
  function taskChange(name,id,kind,checked){
    if(!validName(name)||!state.focus.includes(name))return;
    const p=record(name),task=p.tasks.find(t=>t.id===id);
    if(!task)return;
    if(kind==="remove"){p.tasks=p.tasks.filter(t=>t.id!==id);addEvent(name,"task_remove",task.title);}
    else if(kind==="toggle"){task.done=checked;addEvent(name,checked?"task_done":"task_undo",task.title);}
    persist();render();
  }
  function exported(){
    const allowed=names();
    return {
      version:1,source:"ABUD OS Personal Workboard — Local Browser Export",
      exportedAt:now(),
      focus:state.focus.filter(x=>allowed.has(x)),
      projects:Object.fromEntries(Object.entries(state.projects).filter(([name])=>allowed.has(name))),
      events:(state.events||[]).filter(event=>allowed.has(event.project)).slice(0,MAX_EVENTS)
    };
  }
  function download(){
    const data=JSON.stringify(exported(),null,2);
    const blob=new Blob([data],{type:"application/json"});
    const objectURL=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=objectURL;
    a.download="abud-os-workboard-"+new Date().toISOString().slice(0,10)+".json";
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(objectURL),1500);
    announce(phrases().exported);
  }
  async function importFile(file){
    if(!file||file.size<=0||file.size>1024*1024){announce(phrases().invalid);return;}
    try{
      const raw=JSON.parse(await file.text());
      const clean=validate(raw);
      state=clean;persist();render();announce(phrases().imported);
    }catch(_){announce(phrases().invalid);}
  }
  $("#historyFilter").addEventListener("change",renderHistory);
  $("#workNoteForm").addEventListener("submit",e=>{
    e.preventDefault();
    addNote($("#workNoteProject").value,$("#workNoteText").value);
    $("#workNoteText").value="";
  });
  $("#workPin").addEventListener("click",()=>focus($("#workProjectSelect").value));
  $("#workExport").addEventListener("click",download);
  $("#workImport").addEventListener("click",()=>$("#workImportFile").click());
  $("#workImportFile").addEventListener("change",async e=>{
    const file=e.target.files?.[0];await importFile(file);e.target.value="";
  });
  $("#workReset").addEventListener("click",()=>{
    if(!window.confirm(phrases().confirm))return;
    try{localStorage.removeItem(store);}catch(_){}
    state={version:1,focus:[],projects:{},events:[],updatedAt:now()};
    persist();render();announce(phrases().cleared);
  });
  $("#workProjects").addEventListener("submit",e=>{
    const form=e.target.closest("[data-task-form]");if(!form)return;
    e.preventDefault();
    const input=form.querySelector('input[name="title"]');
    addTask(form.dataset.taskForm,input.value);
  });
  $("#workProjects").addEventListener("click",e=>{
    const remove=e.target.closest("[data-unpin]");
    if(remove){removeFocus(remove.dataset.unpin);return;}
    const task=e.target.closest("[data-task-remove]");
    if(task)taskChange(task.dataset.taskRemove,task.dataset.taskId,"remove");
  });
  $("#workProjects").addEventListener("change",e=>{
    const stage=e.target.closest("[data-work-stage]");
    if(stage){updateStage(stage.dataset.workStage,stage.value);return;}
    const input=e.target.closest("[data-task-toggle]");
    if(input)taskChange(input.dataset.taskToggle,input.dataset.taskId,"toggle",input.checked);
  });
  window.addEventListener("abud:refresh",render);
  window.ABUD_WORKBOARD={
    getFocusNames:()=>state.focus.filter(validName),
    getSnapshot:()=>JSON.parse(JSON.stringify(exported())),
    setFocus:(name)=>focus(name),
    // Used by automated Chromium verification; stays public-only and device-local.
    getStorageKey:()=>store
  };
  render();
  window.dispatchEvent(new Event("abud:workboard"));
})();
