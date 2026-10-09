/* ABUD GitHub Universe — zero-build, GitHub Pages compatible */
(() => {
  "use strict";

  const DATA = window.ABUD_DATA;
  if (!DATA || !Array.isArray(DATA.repos)) {
    document.body.insertAdjacentHTML("afterbegin", '<div style="padding:30px;color:#fb7185">Repository data could not be loaded.</div>');
    return;
  }

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[char]));
  const langStore = "abud-universe-language";
  const metadataStore = "abud-universe-github-meta-v1";
  const state = {
    lang: "ar",
    filter: "all",
    query: "",
    repos: DATA.repos.map((r) => ({...r})),
    metadata: {},
    lastSync: null,
    selected: null,
    map: {scale: 0.54, tx: 0, ty: 0, initialized: false, dragging: null}
  };
  try { if (localStorage.getItem(langStore) === "en") state.lang = "en"; } catch (_) {}

  const copy = {
    ar: {
      workspace:"WORKSPACE / مساحة العمل",navOverview:"نظرة عامة",navMap:"خريطة المشاريع",
      navLibrary:"كل المستودعات",navRelations:"العلاقات والنسخ",navStrategy:"التركيز والقرارات",
      categoriesLabel:"CATEGORIES / التصنيفات",dataSource:"SOURCE OF TRUTH",
      dataSourceDetail:"يظهر على الموقع العام Repositories العامة فقط، ويُراجع GitHub تلقائيًا.",
      openProfile:"فتح GitHub Profile",snapshot:"PUBLIC ONLY / نسخة مراجَعة",
      sync:"تحديث GitHub",heroTitle:"كل مشاريعي.<br><em>صورة واحدة واضحة.</em>",
      heroDesc:"مرجع تفاعلي لمشاريع GitHub العامة فقط: اللي شغّال، اللي خلص، اللي محتاج قرار، وإيه الخطوة الصح بعد كده. المشاريع الخاصة مستبعدة.",
      exploreMap:"استكشف الخريطة ↗",browseRepo:"تصفح المستودعات ←",
      focusTitle:"احنا مركزين على إيه دلوقتي؟",focusSub:"مش كل نشاط على GitHub معناه تقدم. هنا الأولوية حسب القيمة الفعلية.",
      mapTitle:"خريطة المشاريع التفاعلية",mapSub:"حرّك الخريطة، كبّر، وافتح أي Repo لمعرفة موقعه والخطوة التالية.",
      mapMode:"SITEMAP MODE",fit:"احتواء",reset:"إعادة",mapHint:"اسحب للتحريك · استخدم +/− للتكبير · اضغط على أي مشروع للتفاصيل",
      registryTitle:"كل الـRepositories",registrySub:"بحث وتصنيف وتفاصيل لكل مشروع — مع روابط GitHub المباشرة.",
      search:"ابحث باسم المشروع، حالته، أو وظيفته...",clear:"مسح الفلاتر",
      emptyTitle:"مفيش نتائج مطابقة",emptyBody:"جرّب بحث تاني أو امسح الفلاتر.",
      relTitle:"المشاريع المرتبطة ببعض",relSub:"تمييز الـCanonical Repositories عن النسخ القديمة والمشاريع المتداخلة.",
      principleA:"ONE MAIN PROJECT",principleADesc:"مشروع رئيسي واحد للتنفيذ؛ والباقي Maintenance أو Growth.",
      principleB:"REAL VERIFICATION",principleBDesc:"الـRelease مش 100% إلا لما المستخدم أو الـGolden Path يتحقق فعليًا.",
      principleC:"DISTRIBUTE, DON'T JUST BUILD",principleCDesc:"النتيجة مش عدد الـRepos — النتيجة مستخدمين، دخل، وفرص حقيقية.",
      footer:"مرجع مشاريع قابل للتحديث — بيانات GitHub العامة منفصلة عن تقييم الجاهزية.",
      drawerAbout:"عن المشروع / ABOUT",drawerNext:"الخطوة التالية / NEXT ACTION",
      drawerNote:"ملاحظة / REVIEW NOTE",drawerGitHub:"معلومات GitHub / PUBLIC METADATA",
      publicNote:"يعرض الموقع المشاريع العامة فقط. حالة المشروع تقييم إداري وليست إثباتًا لجاهزية Production، ولا يجب تخزين أسرار هنا.",
      viewGitHub:"افتح Repository على GitHub",total:"PUBLIC REPOS",active:"CURRENT FOCUS",
      shipped:"SHIPPED / COMMERCIAL",review:"NEEDS REVIEW",growth:"GROWTH TRACK",
      snapshotHint:"تصنيف يدوي",metadataHint:"نشاط عام فقط",
      detail:"تفاصيل",repo:"GitHub ↗",all:"كل المشاريع",
      next:"الخطوة التالية",related:"ارتباط",noNotes:"لا توجد ملاحظات إضافية متاحة.",
      noMetadata:"اضغط «تحديث GitHub» لجلب آخر معلومات GitHub العامة.",
      updated:"آخر تحديث",stars:"النجوم",language:"اللغة",notKnown:"غير متاح",
      synced:"تحديث البيانات العامة",syncing:"جاري تحديث البيانات...",syncSuccess:"تم تحديث نشاط المستودعات العام.",
      syncFailure:"تعذر جلب بيانات GitHub الآن. التصنيفات المحفوظة متاحة كما هي.",
      syncLimit:"معدل طلبات GitHub قد يكون محدودًا. جرّب لاحقًا.",
      repoCount:"مستودع ظاهر", unreviewed:"مستودع جديد لم يُراجع",newRepo:"UNREVIEWED",
      current:"تركيز أساسي", queued:"التالي", traction:"نمو وتوزيع",
      footerAction:"الحالة ثابتة حتى مراجعتها يدويًا"
    },
    en: {
      workspace:"WORKSPACE",navOverview:"Overview",navMap:"Project map",navLibrary:"Repositories",
      navRelations:"Relationships",navStrategy:"Focus & decisions",
      categoriesLabel:"CATEGORIES",dataSource:"SOURCE OF TRUTH",
      dataSourceDetail:"Only public repositories are shown. GitHub visibility is rechecked on page load.",
      openProfile:"Open GitHub Profile",snapshot:"PUBLIC REPOS / REVIEWED",
      sync:"Sync GitHub",heroTitle:"Every project.<br><em>One clear picture.</em>",
      heroDesc:"A living map of my public GitHub repositories, showing what is active, what has shipped, and what deserves attention. Private repositories are excluded.",
      exploreMap:"Explore the map ↗",browseRepo:"Browse repositories →",
      focusTitle:"What deserves attention right now?",focusSub:"GitHub activity is not product progress. Priorities are based on real outcomes.",
      mapTitle:"Interactive project sitemap",mapSub:"Pan, zoom and open any repository to see its purpose and next action.",
      mapMode:"SITEMAP MODE",fit:"Fit",reset:"Reset",mapHint:"Drag to pan · Use +/− to zoom · Select any project for details",
      registryTitle:"All repositories",registrySub:"Searchable, categorized inventory with direct GitHub access.",
      search:"Search by name, status or project purpose...",clear:"Clear filters",
      emptyTitle:"No matching repositories",emptyBody:"Try another search or clear your filters.",
      relTitle:"Connected projects",relSub:"Differentiate canonical repositories, legacy copies and overlapping products.",
      principleA:"ONE MAIN PROJECT",principleADesc:"One execution focus; everything else is maintenance or growth.",
      principleB:"REAL VERIFICATION",principleBDesc:"A release is only closed after real runtime or Golden Path evidence.",
      principleC:"DISTRIBUTE, DON'T JUST BUILD",principleCDesc:"Success is adoption, revenue and opportunity — not repo count.",
      footer:"Curated readiness labels are distinct from public GitHub activity.",
      drawerAbout:"PROJECT / OVERVIEW",drawerNext:"NEXT ACTION",drawerNote:"REVIEW NOTE",
      drawerGitHub:"PUBLIC GITHUB METADATA",
      publicNote:"Only public repositories are displayed. Editorial assessments do not prove production readiness. Never store secrets here.",
      viewGitHub:"Open repository on GitHub",total:"PUBLIC REPOS",active:"CURRENT FOCUS",
      shipped:"SHIPPED / COMMERCIAL",review:"NEEDS REVIEW",growth:"GROWTH TRACK",
      snapshotHint:"Curated snapshot",metadataHint:"Public activity only",
      detail:"Details",repo:"GitHub ↗",all:"All repositories",
      next:"Next action",related:"Related",noNotes:"No additional review notes available.",
      noMetadata:"Use “Sync GitHub” to fetch current public repository metadata.",
      updated:"Pushed",stars:"Stars",language:"Language",notKnown:"Unknown",
      synced:"Public metadata refreshed",syncing:"Refreshing GitHub data...",syncSuccess:"Public GitHub activity is up to date.",
      syncFailure:"GitHub metadata could not be fetched. The curated catalog still works offline.",
      syncLimit:"GitHub API rate limit may have been reached. Retry later.",
      repoCount:"repos shown", unreviewed:"new repo needing review",newRepo:"UNREVIEWED",
      current:"Main focus",queued:"Next",traction:"Growth",
      footerAction:"Status remains curated until manually reviewed"
    }
  };

  const C = () => copy[state.lang];
  const T = (ar,en) => state.lang === "ar" ? ar : en;
  const cats = DATA.categories;
  const category = (id) => cats.find((c) => c.id === id) || cats[2];
  const repoUrl = (name) => "https://github.com/" + DATA.owner + "/" + encodeURIComponent(name);
  const filtered = () => {
    const needle = state.query.trim().toLocaleLowerCase();
    return state.repos.filter((r) => {
      if (state.filter !== "all" && r.category !== state.filter) return false;
      if (!needle) return true;
      return [r.name,r.category,r.status,r.ar,r.en,r.nextAr,r.nextEn,r.note]
        .some((part) => String(part || "").toLocaleLowerCase().includes(needle));
    });
  };
  let toastTimer;

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3600);
  }

  function renderLabels() {
    document.documentElement.lang = state.lang;
    document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
    $$("[data-i18n]").forEach((el) => {
      const value = C()[el.dataset.i18n];
      if (value === undefined) return;
      if (el.dataset.i18n === "heroTitle") el.innerHTML = value; // trusted local content
      else el.textContent = value;
    });
    $$("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = C()[el.dataset.i18nPlaceholder] || "";
    });
    $("#languageButton").textContent = state.lang === "ar" ? "EN" : "AR";
    $("#sourceStamp").textContent = "PUBLIC ONLY · REVIEWED " + DATA.reviewed;
    const orb=$("#heroRepoCount"); if(orb)orb.textContent=state.repos.length;
    const orbital=$("#orbRepoLabel");if(orbital)orbital.textContent="GITHUB · "+state.repos.length;
    $("#syncLabel").lastElementChild.textContent = state.lastSync
      ? C().synced + " · " + new Date(state.lastSync).toLocaleTimeString(state.lang==="ar"?"ar-EG":"en-US",{hour:"2-digit",minute:"2-digit"})
      : C().snapshot;
  }

  function renderSidebar() {
    const counts = Object.fromEntries(cats.map(c => [c.id,state.repos.filter(r=>r.category===c.id).length]));
    $("#sidebarCategories").innerHTML = cats.map(c =>
      `<button type="button" class="side-cat ${state.filter===c.id?'selected':''}" data-filter="${c.id}" style="--cat:${c.color}">
      <span class="cat-dot"></span><span>${html(T(c.ar,c.en))}</span><span class="cat-count">${counts[c.id]}</span></button>`
    ).join("");
  }

  function renderStats() {
    const data = [
      [C().total,state.repos.length,"#c084fc",C().snapshotHint],
      [C().active,state.repos.filter(r=>r.category==="active").length,"#f97373",C().snapshotHint],
      [C().shipped,state.repos.filter(r=>r.category==="live").length,"#34d399",C().snapshotHint],
      [C().review,state.repos.filter(r=>["cleanup","archive"].includes(r.category)).length,"#fb7185",C().snapshotHint],
      [C().growth,state.repos.filter(r=>["RootRay","short-studio-server"].includes(r.name)).length,"#2dd4bf",C().metadataHint]
    ];
    $("#metrics").innerHTML = data.map(([label,count,color,detail]) =>
      `<article class="stat" style="--stat-color:${color}"><span>${html(label)}</span><strong>${count.toString().padStart(2,"0")}</strong><small>${html(detail)}</small></article>`
    ).join("");
  }

  function renderFocus() {
    const nodes=[
      ["Video_Factory","01","main","current"],
      ["ReplyOps","02","next","queued"],
      ["RootRay","03","growth","traction"]
    ];
    $("#focusCards").innerHTML = nodes.map(([name,index,_,label])=>{
      const r=state.repos.find(item=>item.name===name);
      if(!r)return "";
      const cat=category(r.category);
      return `<article class="focus-card" style="--accent:${cat.color}">
        <span class="focus-no">PRIORITY ${index} / ${html(C()[label])}</span>
        <h3>${html(r.name)}</h3>
        <p>${html(T(r.nextAr,r.nextEn))}</p>
        <div class="focus-foot"><span>${html(r.status)}</span>
          <button class="small-btn" type="button" data-open="${html(r.name)}">${html(C().detail)} ↗</button></div>
      </article>`;
    }).join("");
  }

  function renderChips() {
    const counts=Object.fromEntries(cats.map(c=>[c.id,state.repos.filter(r=>r.category===c.id).length]));
    const all=`<button type="button" class="chip ${state.filter==="all"?"active":""}" data-filter="all">${html(C().all)} · ${state.repos.length}</button>`;
    $("#filterChips").innerHTML = all + cats.map(c => `<button type="button" class="chip ${state.filter===c.id?"active":""}"
      data-filter="${c.id}" style="--chip:${c.color}"><i></i>${html(T(c.ar,c.en))} · ${counts[c.id]}</button>`).join("");
  }

  function fmtDate(value) {
    if(!value) return null;
    const date = new Date(value);
    if(Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(state.lang==="ar"?"ar-EG":"en-GB",{year:"numeric",month:"short",day:"numeric"});
  }
  function renderRepoCards() {
    const results=filtered();
    $("#resultCount").textContent = results.length + " / " + state.repos.length;
    $("#emptyState").hidden = results.length > 0;
    $("#repoGrid").innerHTML = results.map((r) => {
      const cat=category(r.category);
      const meta=state.metadata[r.name];
      const glyph=r.name.slice(0,1).toUpperCase();
      return `<article class="repo-card" style="--accent:${cat.color}">
        <div class="repo-head"><span class="repo-icon" aria-hidden="true">${html(glyph)}</span>
        <span class="repo-badge">${html(r.status)}</span></div>
        <h3 class="repo-name">${html(r.name)}</h3>
        <p class="repo-desc">${html(T(r.ar,r.en))}</p>
        <div class="repo-meta"><span>${html(T(cat.ar,cat.en))}</span>
          ${meta?.language?`<span>◦ ${html(meta.language)}</span>`:""}
          ${meta?.pushed_at?`<span>↻ ${html(fmtDate(meta.pushed_at))}</span>`:""}
        </div>
        <div class="repo-actions"><button class="small-btn" type="button" data-open="${html(r.name)}">${html(C().detail)} ↗</button>
        <a class="small-btn ghost" href="${repoUrl(r.name)}" target="_blank" rel="noopener noreferrer">${html(C().repo)}</a></div>
      </article>`;
    }).join("");
  }

  function renderRelations() {
    const publicNames=new Set(state.repos.map(r=>r.name));
    $("#relationGrid").innerHTML=DATA.relationships.filter(rel=>publicNames.has(rel.from)&&publicNames.has(rel.to)).map(rel =>
      `<article class="relation-card">
        <span class="relation-kind">${html(T(rel.ar,rel.en))}</span>
        <div class="relation-names"><button type="button" data-open="${html(rel.from)}">${html(rel.from)}</button>
        <span class="relation-arrow" aria-label="points to">→</span>
        <button type="button" data-open="${html(rel.to)}">${html(rel.to)}</button></div></article>`
    ).join("");
  }

  const graphLayout = {
    active:[30,30],showcase:[823,30],live:[1616,30],
    revive:[30,593],personal:[1616,593],
    freeze:[30,1150],archive:[823,1150],cleanup:[1616,1150]
  };
  const SVG_NS="http://www.w3.org/2000/svg";
  function graphCurve(fromX,fromY,toX,toY) {
    const dx=toX-fromX,dy=toY-fromY;
    const horizontal=Math.abs(dx)>Math.abs(dy);
    return horizontal
      ? `M${fromX},${fromY} C${fromX+dx*.57},${fromY} ${toX-dx*.57},${toY} ${toX},${toY}`
      : `M${fromX},${fromY} C${fromX},${fromY+dy*.52} ${toX},${toY-dy*.52} ${toX},${toY}`;
  }
  function renderGraph() {
    const match=new Set(filtered().map(r=>r.name));
    const clusters=$("#graphClusters");
    clusters.replaceChildren();
    const svg=$("#graphLines");
    svg.replaceChildren();

    for(const cat of cats) {
      const all=state.repos.filter(r=>r.category===cat.id);
      const active=all.filter(r=>match.has(r.name));
      if(!active.length) continue;
      const [x,y]=graphLayout[cat.id];
      const cluster=document.createElement("section");
      cluster.className="graph-cluster";
      cluster.style.cssText=`left:${x}px;top:${y}px;--accent:${cat.color}`;
      cluster.innerHTML=`
        <div class="cluster-heading"><div><div class="cluster-name"><b></b>${html(cat.en)}</div>
          <div class="cluster-subtitle">${html(T(cat.ar,cat.en))}</div></div>
          <span class="cluster-count">${active.length} / ${all.length}</span></div>
        <div class="cluster-list">${active.map(r=>
          `<button class="graph-repo" data-open="${html(r.name)}" type="button" title="${html(r.name)}">
          <span>${html(r.name)}</span><i>↗</i></button>`
        ).join("")}</div>`;
      clusters.appendChild(cluster);

      const path=document.createElementNS(SVG_NS,"path");
      const sx=1130,sy=810,tx=x+307,ty=y+62;
      path.setAttribute("d",graphCurve(sx,sy,tx,ty));
      path.setAttribute("stroke",cat.color);
      path.setAttribute("stroke-opacity",".53");
      path.setAttribute("stroke-width","3");
      path.setAttribute("fill","none");
      path.setAttribute("stroke-dasharray","9 10");
      svg.appendChild(path);

      const marker=document.createElementNS(SVG_NS,"circle");
      marker.setAttribute("cx",tx);
      marker.setAttribute("cy",ty);
      marker.setAttribute("r","5");
      marker.setAttribute("fill",cat.color);
      svg.appendChild(marker);
    }
    $("#graphTotal").textContent = filtered().length + " REPOS";
    $("#graphSummary").textContent = filtered().length + " NODES / 8 GROUPS";
  }

  function renderAll() {
    renderLabels();
    renderSidebar();
    renderStats();
    renderFocus();
    renderChips();
    renderRepoCards();
    renderRelations();
    renderGraph();
  }

  function applyFilter(id) {
    state.filter=id;
    renderAll();
    document.querySelector("#library").scrollIntoView({behavior:"smooth",block:"start"});
    closeMobile();
  }
  function openProject(name) {
    const repo=state.repos.find(r=>r.name===name);
    if(!repo)return;
    const cat=category(repo.category),meta=state.metadata[repo.name];
    state.selected=name;
    $("#drawerName").textContent=repo.name;
    $("#drawerCategory").textContent=T(cat.ar,cat.en);
    $("#drawerStatus").textContent=repo.status;
    $("#drawerDescription").textContent=T(repo.ar,repo.en);
    $("#drawerNextValue").textContent=T(repo.nextAr,repo.nextEn);
    $("#drawerNoteValue").textContent=repo.note || C().noNotes;
    $("#drawerGithub").href=repoUrl(repo.name);
    $("#drawerMeta").replaceChildren();
    if(meta) {
      const fields=[
        [C().stars,String(meta.stargazers_count ?? 0)],
        [C().language,meta.language || C().notKnown],
        [C().updated,fmtDate(meta.pushed_at)||C().notKnown]
      ];
      for(const [label,value] of fields) {
        const span=document.createElement("span");
        span.textContent=label+": "+value;
        $("#drawerMeta").appendChild(span);
      }
    } else $("#drawerMeta").textContent=C().noMetadata;
    $("#drawerBackdrop").hidden=false;
    $("#projectDrawer").classList.add("open");
    $("#projectDrawer").setAttribute("aria-hidden","false");
    $("#drawerClose").focus();
  }
  function closeProject() {
    const drawer=$("#projectDrawer");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden","true");
    $("#drawerBackdrop").hidden=true;
    state.selected=null;
  }

  function resetGraph(fit=true) {
    const viewport=$("#mapViewport");
    const world={width:2260,height:1640};
    const boundW=viewport.clientWidth, boundH=viewport.clientHeight;
    const fitScale=Math.min((boundW-24)/world.width,(boundH-24)/world.height);
    state.map.scale=fit?Math.max(.18,Math.min(1.5,fitScale)):Math.min(1.45,Math.max(.38,boundW/2100));
    state.map.tx=(boundW-world.width*state.map.scale)/2;
    state.map.ty=(boundH-world.height*state.map.scale)/2;
    state.map.initialized=true;
    drawGraphPosition();
  }
  function drawGraphPosition() {
    $("#mapWorld").style.transform=`translate(${state.map.tx}px,${state.map.ty}px) scale(${state.map.scale})`;
    $("#zoomValue").textContent=Math.round(state.map.scale*100)+"%";
  }
  function graphZoom(delta,anchorX,anchorY) {
    const v=$("#mapViewport");
    const x=anchorX ?? v.clientWidth/2, y=anchorY ?? v.clientHeight/2;
    const prior=state.map.scale;
    const next=Math.max(.18,Math.min(1.85,prior*delta));
    if(next===prior)return;
    const worldX=(x-state.map.tx)/prior;
    const worldY=(y-state.map.ty)/prior;
    state.map.scale=next;
    state.map.tx=x-worldX*next;
    state.map.ty=y-worldY*next;
    drawGraphPosition();
  }
  function bindMap() {
    $("#zoomIn").addEventListener("click",()=>graphZoom(1.2));
    $("#zoomOut").addEventListener("click",()=>graphZoom(1/1.2));
    $("#fitMap").addEventListener("click",()=>resetGraph(true));
    $("#resetMap").addEventListener("click",()=>resetGraph(false));
    const v=$("#mapViewport");
    v.addEventListener("wheel",(event)=>{
      event.preventDefault();
      const r=v.getBoundingClientRect();
      graphZoom(event.deltaY<0?1.08:1/1.08,event.clientX-r.left,event.clientY-r.top);
    },{passive:false});
    v.addEventListener("pointerdown",(event)=>{
      if(event.target.closest("button") || (event.pointerType==="mouse"&&event.button!==0))return;
      state.map.dragging={id:event.pointerId,x:event.clientX,y:event.clientY,tx:state.map.tx,ty:state.map.ty};
      v.setPointerCapture(event.pointerId);
      v.classList.add("dragging");
    });
    v.addEventListener("pointermove",(event)=>{
      const d=state.map.dragging;
      if(!d||d.id!==event.pointerId)return;
      state.map.tx=d.tx+event.clientX-d.x;
      state.map.ty=d.ty+event.clientY-d.y;
      drawGraphPosition();
    });
    const stop=(event)=>{
      if(!state.map.dragging||state.map.dragging.id!==event.pointerId)return;
      state.map.dragging=null;
      v.classList.remove("dragging");
      try { if(v.hasPointerCapture(event.pointerId))v.releasePointerCapture(event.pointerId); }catch(_){}
    };
    v.addEventListener("pointerup",stop);
    v.addEventListener("pointercancel",stop);
    v.addEventListener("lostpointercapture",()=>{state.map.dragging=null;v.classList.remove("dragging");});
    v.addEventListener("keydown",(event)=>{
      if(event.key==="+")graphZoom(1.2);
      if(event.key==="-")graphZoom(1/1.2);
      if(event.key==="ArrowLeft")state.map.tx-=30;
      else if(event.key==="ArrowRight")state.map.tx+=30;
      else if(event.key==="ArrowUp")state.map.ty-=30;
      else if(event.key==="ArrowDown")state.map.ty+=30;
      else return;
      if(event.key.startsWith("Arrow"))drawGraphPosition();
      event.preventDefault();
    });
    new ResizeObserver(()=>{if(state.map.initialized) resetGraph(false)}).observe(v);
    requestAnimationFrame(()=>resetGraph(false));
  }

  function closeMobile(){
    $("#sidebar").classList.remove("mobile-open");
    $("#mobileBackdrop").hidden=true;
  }
  function bindUI(){
    document.addEventListener("click",(event)=>{
      const open=event.target.closest("[data-open]");
      if(open){openProject(open.dataset.open);return;}
      const filter=event.target.closest("[data-filter]");
      if(filter){applyFilter(filter.dataset.filter);return;}
    });
    $("#languageButton").addEventListener("click",()=>{
      state.lang=state.lang==="ar"?"en":"ar";
      try{localStorage.setItem(langStore,state.lang)}catch(_){}
      renderAll();
      if(state.selected)openProject(state.selected);
    });
    $("#repoSearch").addEventListener("input",(event)=>{
      state.query=event.target.value;
      renderRepoCards();renderGraph();
    });
    $("#clearFilters").addEventListener("click",()=>{
      state.filter="all";state.query="";$("#repoSearch").value="";renderAll();
    });
    $("#drawerClose").addEventListener("click",closeProject);
    $("#drawerBackdrop").addEventListener("click",closeProject);
    document.addEventListener("keydown",(event)=>{
      const typing=event.target.matches("input,textarea,[contenteditable=true]");
      if(event.key==="/"&&!typing){
        event.preventDefault();$("#repoSearch").focus();
        $("#library").scrollIntoView({behavior:"smooth"});
      }
      if(event.key==="Escape"){
        closeProject();closeMobile();
      }
    });
    $("#mobileMenu").addEventListener("click",()=>{
      $("#sidebar").classList.add("mobile-open");
      $("#mobileBackdrop").hidden=false;
    });
    $("#mobileBackdrop").addEventListener("click",closeMobile);
    $$(".nav-link").forEach(a=>a.addEventListener("click",closeMobile));
    const observer=new IntersectionObserver(entries=>{
      const top=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
      if(!top)return;
      $$(".nav-link").forEach(a=>a.classList.toggle("current",a.getAttribute("href")==="#"+top.target.id));
    },{rootMargin:"-15% 0px -60% 0px",threshold:[0,.2,.55]});
    ["overview","strategy","map","library","relations"].forEach(id=>{
      const target=document.getElementById(id);if(target)observer.observe(target);
    });
    $("#syncButton").addEventListener("click",syncGitHub);
  }

  async function syncGitHub({silent=false}={}) {
    const btn=$("#syncButton");
    btn.disabled=true;
    if(!silent) $("#syncLabel").lastElementChild.textContent=C().syncing;
    let found=[];
    try {
      // GitHub's public user endpoint does not expose private repositories.
      // Never use owner-authenticated private repository data in the browser.
      for(let page=1;page<=10;page++){
        const url=`https://api.github.com/users/${encodeURIComponent(DATA.owner)}/repos?per_page=100&type=owner&sort=updated&page=${page}`;
        const response=await fetch(url,{headers:{"Accept":"application/vnd.github+json"}});
        if(response.status===403||response.status===429)throw new Error("LIMIT");
        if(!response.ok)throw new Error("HTTP "+response.status);
        const batch=await response.json();
        if(!Array.isArray(batch))throw new Error("INVALID API RESPONSE");
        found=found.concat(batch);
        if(batch.length<100)break;
        if(page===10)throw new Error("INCOMPLETE PUBLIC LIST");
      }
      const publicRows=found.filter(r=>
        r && typeof r.name==="string" && r.owner?.login?.toLowerCase()===DATA.owner.toLowerCase() &&
        r.private!==true && (r.visibility===undefined || r.visibility==="public")
      );
      // Avoid turning a rate-limited or unexpected response into mass deletion.
      if(!publicRows.some(r=>r.name==="-abud-github-universe"))throw new Error("INCOMPLETE PUBLIC LIST");

      const publicNames=new Set(publicRows.map(r=>r.name));
      const curatedByName=new Map(state.repos.map(r=>[r.name,r]));
      const nextMeta={};
      const nextRepos=[];
      for(const repo of publicRows){
        if(nextMeta[repo.name])continue; // de-duplicate overlapping pages
        nextMeta[repo.name]={
          stargazers_count:Number(repo.stargazers_count)||0,
          language:typeof repo.language==="string"?repo.language:null,
          pushed_at:repo.pushed_at||null,
          archived:!!repo.archived
        };
        const curated=curatedByName.get(repo.name);
        nextRepos.push(curated || {
          name:repo.name,category:"revive",status:"UNREVIEWED",
          ar:"مستودع عام جديد يحتاج مراجعة وتصنيف يدوي.",
          en:"New public GitHub repository awaiting a human review and classification.",
          nextAr:"افحص المشروع وحدد حالته بناءً على أدلة",
          nextEn:"Inspect the project and assign an evidence-backed status",
          note:"Discovered through the public GitHub API. Not yet assessed."
        });
      }
      // Reconcile the actual public set: PRIVATE and DELETED repos disappear.
      state.repos=nextRepos;
      if(state.selected && !publicNames.has(state.selected))closeProject();
      state.metadata=nextMeta;
      state.lastSync=Date.now();
      try{localStorage.setItem(metadataStore,JSON.stringify({timestamp:state.lastSync,metadata:nextMeta}))}catch(_){}
      renderAll();
      if(!silent)toast(C().syncSuccess);
    }catch(error){
      // On network failure, retain only the last audited public snapshot.
      // This is not proof of current visibility; fresh status requires API access.
      $("#syncLabel").lastElementChild.textContent=state.lastSync?C().synced:C().snapshot;
      if(!silent)toast(error.message==="LIMIT"?C().syncLimit:C().syncFailure);
    }finally{
      btn.disabled=false;
    }
  }

  function recoverCachedMetadata() {
    try {
      const cached=JSON.parse(localStorage.getItem(metadataStore)||"null");
      if(!cached||!cached.timestamp||Date.now()-cached.timestamp>30*60*1000)return;
      if(!cached.metadata||typeof cached.metadata!=="object")return;
      const visibleNames=new Set(state.repos.map(r=>r.name));
      state.metadata=Object.fromEntries(Object.entries(cached.metadata).filter(([name])=>visibleNames.has(name)));
      state.lastSync=cached.timestamp;
    }catch(_){}
  }

  recoverCachedMetadata();
  renderAll();
  bindUI();
  bindMap();
  // Reconcile public visibility automatically on every visit.
  void syncGitHub({silent:true});
})();
