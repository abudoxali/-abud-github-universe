/* ABUD OS Private V2.0 alpha. No private data in localStorage or global cross-origin calls. */
(() => {
 "use strict";
 const $=id=>document.getElementById(id);
 const lang={current:"ar"};
 const i18n={
  ar:{private:"PRIVATE WORKSPACE",overview:"لوحة التحكم",repositories:"المستودعات",tasks:"لوحة التنفيذ",privacy:"الوصول للـPrivate Repositories يتم من السيرفر فقط. لا يوجد GitHub Token في المتصفح.",public:"الموقع العام",
   signTitle:"مساحة عملك الخاصة، بصلاحياتك.",signInfo:"سجّل بحساب GitHub المصرّح به. الوصول للمشاريع الخاصة يتطلب GitHub App مثبتة على المستودعات المختارة.",sign:"تسجيل دخول GitHub ↗",authNote:"النسخة دي مش جزءًا من GitHub Pages العام.",
   title:"كل شغلك. مكان واحد.",subtitle:"بيانات من GitHub App للـRepos المصرح بها، ومهام محفوظة على السيرفر.",
   repoCount:"مستودعات متاحة",privateCount:"مستودعات خاصة",focusCount:"مشاريع التركيز",completedCount:"مهام منجزة",browse:"مستودعاتك المصرح بها",refresh:"تحديث ↻",workboard:"لوحة التنفيذ",three:"3 مشاريع كحد أقصى",
   workHelp:"اختار مشروع للتركيز، وأضف مهامك. اضغط حفظ لتزامن التغييرات مع السيرفر.",selectRepo:"اختار مشروع تركيز",addTask:"+ إضافة",save:"حفظ على السيرفر",source:"اختار Repo لمراجعة STATUS.md",sourceNote:"الحالة مقتبسة من الملف المصرح بقراءته. مش دليل على جاهزية التشغيل.",disclaimer:"جلسات على السيرفر · البيانات الخاصة لا تُخزن على GitHub Pages · GitHub activity مش اكتمال المنتج.",
   empty:"مفيش مستودعات مصرح بها. ثبّت GitHub App بصلاحيات read-only على المشاريع المختارة.",focusEmpty:"اختر مشروع من القائمة",noTasks:"مفيش مهام لهذا المشروع",taskHint:"خطوة واضحة قابلة للاختبار",saved:"تم حفظ التعديلات",unsaved:"عندك تعديلات غير محفوظة",conflict:"فيه تغييرات أحدث على جهاز تاني؛ حمّل البيانات قبل إعادة الحفظ.",remove:"إزالة",done:"تم",statusLoading:"جاري قراءة ملف الحالة...",sourceAbsent:"STATUS.md غير موجود أو غير متاح",blocked:"وصلت لحد 3 مشاريع",privateRepo:"PRIVATE",publicRepo:"PUBLIC",logout:"خروج",fail:"تعذر الاتصال بالخدمة الخاصة؛ مفيش بيانات تم حفظها"},
  en:{private:"PRIVATE WORKSPACE",overview:"Overview",repositories:"Repositories",tasks:"Workboard",privacy:"Private repositories are retrieved by the server only. No GitHub token is stored in the browser.",public:"Public Universe",
   signTitle:"Your work. Your private access.",signInfo:"Sign in using the approved GitHub account. Selected private repositories require a read-only GitHub App installation.",sign:"Sign in with GitHub ↗",authNote:"This is separate from the public GitHub Pages website.",
   title:"All your work. One command center.",subtitle:"Authorized GitHub App repository data and server-backed tasks.",
   repoCount:"Authorized repos",privateCount:"Private repos",focusCount:"Focus projects",completedCount:"Completed tasks",browse:"Authorized repositories",refresh:"Refresh ↻",workboard:"Personal Workboard",three:"Max three projects",
   workHelp:"Choose focus repos and add tasks. Save to synchronize changes with the server.",selectRepo:"Choose focus repo",addTask:"+ Add task",save:"Save to server",source:"Select a repository to inspect STATUS.md",sourceNote:"Documented claims from an authorized file are not verified production readiness.",disclaimer:"Server-side sessions · No private data published on GitHub Pages · Activity is not completion.",
   empty:"No authorized repos. Install the read-only GitHub App on selected repositories.",focusEmpty:"Select a repository from the list",noTasks:"No tracked tasks for this repo",taskHint:"A short verifiable action",saved:"Saved",unsaved:"Unsaved changes",conflict:"Another device updated the workboard. Reload before saving.",remove:"Remove",done:"Done",statusLoading:"Reading source status...",sourceAbsent:"STATUS.md missing or unavailable",blocked:"Maximum three focus projects",privateRepo:"PRIVATE",publicRepo:"PUBLIC",logout:"Sign out",fail:"Private service unavailable. No changes were saved."}
 };
 const labels=()=>i18n[lang.current];
 let csrf="",repos=[],revision=0,workspace={version:1,focus:[],projects:{},events:[]},changed=false;
 const escape=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const allowed=name=>repos.some(r=>r.name===name);
 const record=name=>{
   if(!workspace.projects[name])workspace.projects[name]={stage:"backlog",tasks:[]};
   return workspace.projects[name];
 };
 const renderLang=()=>{
   const t=labels();document.documentElement.lang=lang.current;document.documentElement.dir=lang.current==="ar"?"rtl":"ltr";
   document.querySelectorAll("[data-i18n]").forEach(el=>{const key=el.dataset.i18n;if(t[key])el.textContent=t[key];});
   $("language").textContent=lang.current==="ar"?"EN":"AR";$("logout").textContent=t.logout;
   $("search").placeholder=lang.current==="ar"?"ابحث في المشاريع المصرح بها...":"Search authorized repositories...";
   $("taskText").placeholder=t.taskHint;render();
 };
 const api=async(path,opts={})=>{
   const res=await fetch(path,{...opts,credentials:"same-origin",
     headers:{"Accept":"application/json",...(opts.body?{"Content-Type":"application/json"}:{}),...(opts.headers||{})}});
   let body=null;try{body=await res.json();}catch{}
   if(!res.ok){const e=new Error(body?.error||"request-failed");e.status=res.status;throw e;}
   return body;
 };
 const showError=message=>{$("fatal").textContent=message;$("fatal").hidden=false;};
 const touch=()=>{changed=true;$("saveStatus").textContent=labels().unsaved;render();};
 const metrics=()=>{
   $("totalRepos").textContent=repos.length;
   $("privateRepos").textContent=repos.filter(r=>r.private).length;
   $("focusRepos").textContent=workspace.focus.length;
   $("doneTasks").textContent=Object.values(workspace.projects).reduce((n,p)=>n+(p.tasks||[]).filter(t=>t.done).length,0);
 };
 const renderRepos=()=>{
   const q=$("search").value.trim().toLowerCase(),filtered=repos.filter(r=>r.name.toLowerCase().includes(q));
   $("repoList").replaceChildren();
   if(!filtered.length){const div=document.createElement("p");div.className="help";div.textContent=labels().empty;$("repoList").append(div);return;}
   for(const repo of filtered){
     const b=document.createElement("button");b.className="repo";b.type="button";
     const name=document.createElement("span");name.className="name";name.textContent=repo.name;
     const privacy=document.createElement("span");privacy.className=repo.private?"private":"public";
     privacy.textContent=repo.private?labels().privateRepo:labels().publicRepo;
     const add=document.createElement("span");add.className="add";add.textContent="+";
     b.append(name,privacy,add);
     b.onclick=()=>{void showStatus(repo.name);if(workspace.focus.includes(repo.name)){$("taskRepo").value=repo.name;renderTasks();return;}
       if(workspace.focus.length>=3){$("saveStatus").textContent=labels().blocked;return;}
       workspace.focus.push(repo.name);record(repo.name);touch();
     };
     $("repoList").append(b);
   }
 };
 const renderTasks=()=>{
   const select=$("taskRepo"),name=select.value,p=workspace.projects[name];
   $("taskList").replaceChildren();
   if(!p||!p.tasks?.length){$("taskList").textContent=labels().noTasks;return;}
   p.tasks.forEach((task,index)=>{
     const row=document.createElement("div");row.className="task"+(task.done?" done":"");
     const input=document.createElement("input");input.type="checkbox";input.checked=task.done;
     input.onchange=()=>{task.done=input.checked;touch();};
     const title=document.createElement("span");title.textContent=task.title;
     const del=document.createElement("button");del.type="button";del.textContent="×";
     del.onclick=()=>{p.tasks.splice(index,1);touch();};
     row.append(input,title,del);$("taskList").append(row);
   });
 };
 const renderFocus=()=>{
   const selected=$("taskRepo").value,options=$("taskRepo");
   options.replaceChildren();$("focusList").replaceChildren();
   for(const name of workspace.focus.filter(allowed)){
     const label=document.createElement("option");label.value=name;label.textContent=name;options.append(label);
     const row=document.createElement("div");row.className="focus";
     const title=document.createElement("strong");title.textContent=name;
     const del=document.createElement("button");del.textContent="×";del.type="button";
     del.onclick=()=>{workspace.focus=workspace.focus.filter(x=>x!==name);touch();};
     row.append(title,del);$("focusList").append(row);
   }
   if(workspace.focus.includes(selected))options.value=selected;
   $("taskText").disabled=!workspace.focus.length;
   $("taskForm").querySelector("button").disabled=!workspace.focus.length;
   renderTasks();
 };
 const render=()=>{if(!$("protected")||$("protected").hidden)return;metrics();renderRepos();renderFocus();};
 async function showStatus(name){
   $("sourceTitle").textContent=name;$("statusFacts").textContent=labels().statusLoading;
   try{
     const result=await api("/api/repos/"+encodeURIComponent(name)+"/status");
     $("statusFacts").replaceChildren();
     if(!result.exists){$("statusFacts").textContent=labels().sourceAbsent;return;}
     for(const item of result.claims||[]){
       const chip=document.createElement("div");chip.className="fact";
       const key=document.createElement("b");key.textContent=item.key;
       const text=document.createElement("span");text.textContent=item.value;
       chip.append(key,text);$("statusFacts").append(chip);
     }
     if(!(result.claims||[]).length)$("statusFacts").textContent=labels().sourceAbsent;
   }catch{$("statusFacts").textContent=labels().sourceAbsent;}
 }
 async function loadData(){
   const [a,b]=await Promise.all([api("/api/repos"),api("/api/workboard")]);
   repos=a.repos||[];revision=b.revision;workspace=b.data;changed=false;
   $("protected").hidden=false;$("loading").hidden=true;
   renderLang();$("saveStatus").textContent=labels().saved;
 }
 $("language").addEventListener("click",()=>{lang.current=lang.current==="ar"?"en":"ar";renderLang();});
 $("refresh").onclick=()=>{if(changed){$("saveStatus").textContent=labels().unsaved;return;}void loadData().catch(()=>showError(labels().fail));};
 $("search").addEventListener("input",renderRepos);
 $("taskRepo").addEventListener("change",renderTasks);
 $("taskForm").addEventListener("submit",event=>{
   event.preventDefault();const name=$("taskRepo").value,title=$("taskText").value.trim();
   if(!allowed(name)||!workspace.focus.includes(name)||!title)return;
   if(!/^[\s\S]{1,120}$/.test(title)||/(?:github_pat_|gh[pousr]_|sk-)/i.test(title))return;
   const list=record(name).tasks;if(list.length>=20)return;
   list.push({id:crypto.randomUUID(),title,done:false});$("taskText").value="";touch();
 });
 $("save").onclick=async()=>{
   if(!changed)return;
   $("save").disabled=true;
   try{
     const saved=await api("/api/workboard",{method:"PUT",headers:{"X-OS-CSRF":csrf},
       body:JSON.stringify({revision,data:workspace})});
     revision=saved.revision;workspace=saved.data;changed=false;
     render();$("saveStatus").textContent=labels().saved;
   }catch(error){$("saveStatus").textContent=error.status===409?labels().conflict:labels().fail;}
   finally{$("save").disabled=false;}
 };
 $("logout").onclick=async()=>{try{await api("/api/logout",{method:"POST",headers:{"X-OS-CSRF":csrf}});}catch{}
   csrf="";repos=[];workspace={version:1,focus:[],projects:{},events:[]};
   location.replace("/");};
 async function start(){
   try{
     const me=await api("/api/me");csrf=me.csrf;
     $("ownerLabel").textContent="@"+me.owner;$("logout").hidden=false;
     await loadData();
   }catch(error){
     $("loading").hidden=true;
     if(error.status===401){$("loginView").hidden=false;renderLang();}
     else showError(labels().fail);
   }
 }
 void start();
})();
