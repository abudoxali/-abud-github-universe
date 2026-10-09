/* ABUD Universe V1.3: curated relations + explainable public signals.
 * No private data, AI inference of duplication, secret/token fetches or product-readiness scoring.
 */
(() => {
  "use strict";
  const DB=window.ABUD_DATA, runtime=window.ABUD_RUNTIME;
  if(!DB||!runtime)return;
  const $=(selector)=>document.querySelector(selector);
  const ar=()=>document.documentElement.lang!=="en";
  const tr=(a,e)=>ar()?a:e;
  const enc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const publicRepos=()=>runtime.getRepos();
  const visible=()=>new Set(publicRepos().map(r=>r.name));
  const publicRelations=()=>DB.relationships.map((r,index)=>({...r,index})).filter(r=>visible().has(r.from)&&visible().has(r.to));
  const types=[
    {id:"all",ar:"كل العلاقات",en:"All relations",color:"#c084fc"},
    {id:"overlap",ar:"تداخل محتمل",en:"Potential overlap",color:"#fbbf24"},
    {id:"succession",ar:"تعاقب نسخ",en:"Succession",color:"#a78bfa"},
    {id:"complement",ar:"تكامل وظيفي",en:"Complement",color:"#2dd4bf"},
    {id:"same-track",ar:"نفس المجال",en:"Same track",color:"#60a5fa"}
  ];
  const typesById=Object.fromEntries(types.map(x=>[x.id,x]));
  const modes=[
    {id:"all",ar:"كل الإشارات",en:"All signals"},
    {id:"security",ar:"مراجعة الخصوصية",en:"Privacy review"},
    {id:"release",ar:"بوابات الإطلاق",en:"Release gates"},
    {id:"overlap",ar:"تداخل المشاريع",en:"Scope overlap"},
    {id:"review",ar:"مطلوب تقييم",en:"Needs assessment"},
    {id:"quiet",ar:"قلة النشاط",en:"Low activity"}
  ];
  let relationFilter="all",decisionFilter="all",decisionSort="priority",focusedIndex=null;

  function getSignals(){
    const list=publicRepos(),data=runtime.getMetadata(),items=[];
    for(const r of list){
      if(r.category==="cleanup")items.push({
        kind:"security",rank:0,title:r.name,project:r.name,
        ar:"مصنّف للمراجعة الأمنية أو الخصوصية. التصنيف لا يؤكد وجود ثغرة فعلية؛ راجع الملفات والتاريخ بنفسك.",
        en:"Flagged for privacy/security review. This is not confirmation of a vulnerability; inspect source and history.",
        stamp:r.status,at:data[r.name]?.pushed_at||null
      });
      if(/(?:GATE|DEPLOY CHECK|VISUAL REVIEW)/i.test(r.status)&&r.category!=="cleanup")items.push({
        kind:"release",rank:1,title:r.name,project:r.name,
        ar:r.nextAr||"اختبر الإصدار عمليًا قبل إغلاقه",
        en:r.nextEn||"Verify the release in a real environment before closure",
        stamp:r.status,at:data[r.name]?.pushed_at||null
      });
      if(r.category!=="cleanup"&&/(?:UNREVIEWED|NEW\s*\/\s*EMPTY|^VERIFY$|^REVIEW$)/i.test(r.status))items.push({
        kind:"review",rank:3,title:r.name,project:r.name,
        ar:"حالة المشروع تحتاج مراجعة المصدر الفعلي وملف STATUS.md قبل اعتماد جاهزيته أو هدفه القادم.",
        en:"Inspect the actual repository and STATUS.md before accepting readiness or a next objective.",
        stamp:r.status,at:data[r.name]?.pushed_at||null
      });
      const pushed=data[r.name]?.pushed_at, time=pushed?new Date(pushed).getTime():NaN;
      const days=Number.isFinite(time)?Math.floor((Date.now()-time)/86400000):null;
      if(days!==null&&days>=90&&!["archive","freeze","cleanup"].includes(r.category))items.push({
        kind:"quiet",rank:4,title:r.name,project:r.name,
        ar:"آخر Push عام منذ "+days+" يومًا. قلة النشاط لا تعني أن المنتج معطّل أو متوقف.",
        en:"Last public push "+days+" days ago. This alone does not mean the product is broken or abandoned.",
        stamp:tr("GitHub metadata","GitHub metadata"),at:pushed
      });
    }
    for(const rel of publicRelations().filter(e=>e.type==="overlap")){
      items.push({
        kind:"overlap",rank:2,title:rel.from+" ↔ "+rel.to,project:rel.from,secondary:rel.to,
        relationIndex:rel.index,
        ar:"مراجعة نطاقات العمل قد تكشف فرص دمج أو فصل، لكن لا يوجد إثبات أن الكود متكرر. "+(rel.arWhy||""),
        en:"Compare scopes for possible consolidation; no verified duplicate code. "+(rel.enWhy||""),
        stamp:"EDITORIAL RELATION",at:null
      });
    }
    return items;
  }
  function typeName(id){const t=typesById[id]||typesById["same-track"];return tr(t.ar,t.en);}
  function nextFocused(relations){
    if(relations.some(x=>x.index===focusedIndex))return;
    focusedIndex=relations.length?relations[0].index:null;
  }
  function relCard(e){
    const tp=typesById[e.type]||typesById["same-track"];
    const info=tr(e.arWhy||e.ar,e.enWhy||e.en);
    return '<article class="relation-card '+(focusedIndex===e.index?"is-focused":"")+'" style="--accent:'+tp.color+'">'+
      '<span class="relation-kind">'+enc(typeName(e.type))+' · EDITORIAL</span>'+
      '<div class="relation-names"><a href="#project/'+encodeURIComponent(e.from)+'">'+enc(e.from)+'</a>'+
      '<span class="relation-arrow" aria-label="related">↔</span>'+
      '<a href="#project/'+encodeURIComponent(e.to)+'">'+enc(e.to)+'</a></div>'+
      '<p class="relation-explanation">'+enc(info)+'</p>'+
      '<div class="relation-actions"><button type="button" data-edge="'+e.index+'">'+enc(tr("إظهار في الخريطة","Highlight on map"))+' ↗</button>'+
      '<span class="relation-source">CURATED · NOT CODE-VERIFIED</span></div></article>';
  }
  function relationRender(){
    const all=publicRelations(),subset=all.filter(e=>relationFilter==="all"||e.type===relationFilter);
    nextFocused(subset);
    $("#relationModes").innerHTML=types.map(item=>{
      const count=item.id==="all"?all.length:all.filter(r=>r.type===item.id).length;
      return '<button type="button" class="relation-type-btn '+(relationFilter===item.id?"active":"")+
        '" data-relation-type="'+item.id+'" aria-pressed="'+String(relationFilter===item.id)+'">'+enc(tr(item.ar,item.en))+
        ' <span class="type-count">'+count+'</span></button>';
    }).join("");
    $("#relationCoverage").textContent=all.length+" "+tr("علاقات عامة تمت مراجعتها تحريريًا","public editorial relationships");
    $("#relationGrid").innerHTML=subset.length?subset.map(relCard).join(""):'<div class="relation-empty">'+enc(tr("لا توجد علاقات عامة من هذا النوع.","No public relationships of this type."))+'</div>';
    const focus=all.find(r=>r.index===focusedIndex);
    const summary=$("#relationInsights");
    if(!focus){summary.innerHTML='<div><h3>'+enc(tr("مفيش علاقة مختارة","No selected relationship"))+'</h3></div>';return;}
    summary.innerHTML='<div><small>'+enc(typeName(focus.type))+' · EDITORIAL ASSOCIATION</small>'+
      '<h3>'+enc(focus.from)+' ↔ '+enc(focus.to)+'</h3>'+
      '<p>'+enc(tr(focus.arWhy||focus.ar,focus.enWhy||focus.en))+'</p></div>'+
      '<button type="button" data-map-edge="'+focus.index+'">'+enc(tr("عرض العلاقة على الخريطة","Show connection on map"))+' ↗</button>';
    requestAnimationFrame(drawEdges);
  }
  function pointFor(name,worldRect,scale){
    const btn=Array.from(document.querySelectorAll("#graphClusters .graph-repo")).find(b=>b.dataset.open===name);
    if(!btn)return null;
    const rect=btn.getBoundingClientRect();
    return {x:(rect.left+rect.width/2-worldRect.left)/scale,y:(rect.top+rect.height/2-worldRect.top)/scale,node:btn};
  }
  function drawEdges(){
    const world=$("#mapWorld"),svg=$("#graphLines");
    if(!world||!svg)return;
    svg.querySelectorAll(".repo-connection").forEach(x=>x.remove());
    document.querySelectorAll("#graphClusters .graph-repo.is-related-focus").forEach(x=>x.classList.remove("is-related-focus"));
    const rect=world.getBoundingClientRect(),scale=rect.width/2260;
    if(!Number.isFinite(scale)||scale<=0)return;
    for(const e of publicRelations()){
      const from=pointFor(e.from,rect,scale),to=pointFor(e.to,rect,scale);
      if(!from||!to)continue;
      const type=typesById[e.type]||typesById["same-track"];
      const p=document.createElementNS("http://www.w3.org/2000/svg","path");
      const dx=to.x-from.x,dy=to.y-from.y;
      const bend=Math.min(105,Math.max(25,Math.abs(dx)*.08+Math.abs(dy)*.08));
      const mx=(from.x+to.x)/2,my=(from.y+to.y)/2-bend;
      p.setAttribute("d","M"+from.x+","+from.y+" Q"+mx+","+my+" "+to.x+","+to.y);
      p.setAttribute("stroke",type.color);
      p.setAttribute("class","repo-connection "+(focusedIndex===e.index?"is-focused":focusedIndex!==null?"is-dimmed":""));
      p.dataset.edgeIndex=String(e.index);
      const title=document.createElementNS("http://www.w3.org/2000/svg","title");
      title.textContent=e.from+" ↔ "+e.to+" ("+type.en+"; editorial only)";
      p.appendChild(title);svg.appendChild(p);
      if(focusedIndex===e.index){
        from.node.classList.add("is-related-focus");
        to.node.classList.add("is-related-focus");
      }
    }
    let legend=$("#mapRelationshipLegend");
    if(!legend){
      legend=document.createElement("span");
      legend.id="mapRelationshipLegend";
      legend.className="map-relationship-note";
      $("#mapViewport").closest(".map-shell").querySelector(".map-bottomline").append(legend);
    }
    legend.textContent=tr("خطوط ملونة: علاقات محرّرة وليست اعتمادات كود","Colored lines: curated, not verified code dependencies");
  }
  function focusMap(index,scroll=true){
    const target=publicRelations().find(r=>r.index===index);
    if(!target)return;
    if(relationFilter!=="all"&&relationFilter!==target.type)relationFilter="all";
    focusedIndex=index;relationRender();drawEdges();
    if(scroll)$("#map").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function decisionRender(){
    const all=getSignals(),selected=all.filter(x=>decisionFilter==="all"||x.kind===decisionFilter);
    selected.sort((a,b)=>{
      if(decisionSort==="name")return a.title.localeCompare(b.title);
      if(decisionSort==="date"){
        if(!a.at&&!b.at)return a.title.localeCompare(b.title);
        if(!a.at)return 1;if(!b.at)return -1;
        return new Date(a.at).getTime()-new Date(b.at).getTime();
      }
      return a.rank-b.rank||a.title.localeCompare(b.title);
    });
    $("#navDecisions").textContent=tr("قرارات المشاريع","Decisions");
    $("#decisionTitle").textContent=tr("قرارات المشاريع","Project Decisions");
    $("#decisionDescription").textContent=tr("مراجعات مقترحة مبنية على تصنيفات معلنة وبيانات GitHub العامة؛ مفيش قرار آلي بحذف أو دمج المشاريع.","Explainable review signals from curated labels and public GitHub metadata; no automatic merge or deletion.");
    $("#decisionTotal").textContent=all.length+" "+tr("إشارة تحتاج نظر","review signals");
    const meta=runtime.getMetadata(),total=publicRepos().length,known=publicRepos().filter(r=>meta[r.name]?.pushed_at).length;
    const cards=[
      ["security",tr("مراجعة الخصوصية","Privacy review"),"#fb7185"],
      ["release",tr("بوابات إطلاق","Release gates"),"#fbbf24"],
      ["overlap",tr("تداخل محتمل","Potential overlap"),"#c084fc"],
      ["quiet",tr("Push أقدم من 90 يوم","No push in 90+ days"),"#60a5fa"]
    ];
    $("#decisionKpis").innerHTML=cards.map(([id,label,color])=>{
      const count=all.filter(x=>x.kind===id).length;
      const note=id==="quiet"?known+"/"+total+" "+tr("بيانات معروفة","known dates"):tr("إشارات وليست أحكامًا","signals, not verdicts");
      return '<div class="decision-kpi" style="--kpi-color:'+color+'"><div class="kpi-label">'+enc(label)+'</div>'+
        '<strong>'+count+'</strong><small>'+enc(note)+'</small></div>';
    }).join("");
    $("#decisionFilters").innerHTML=modes.map(m=>{
      const count=m.id==="all"?all.length:all.filter(x=>x.kind===m.id).length;
      return '<button class="decision-filter-btn '+(decisionFilter===m.id?"active":"")+
        '" data-decision-filter="'+m.id+'" type="button" aria-pressed="'+String(decisionFilter===m.id)+'">'+enc(tr(m.ar,m.en))+' · '+count+'</button>';
    }).join("");
    $("#decisionSortLabel").textContent=tr("الترتيب","Sort");
    const sort=$("#decisionSort");sort.value=decisionSort;
    sort.options[0].textContent=tr("الأولوية","Priority");
    sort.options[1].textContent=tr("الاسم","Name");
    sort.options[2].textContent=tr("أقدم Push","Oldest push");
    $("#decisionContext").textContent=tr("آخر Push معروف لـ "+known+" من "+total+" مشروع عام. بوابات الإطلاق مبنية على حالة محررة سابقًا، وقد تكون قديمة.",
      "Public push dates known for "+known+" of "+total+" repos. Release gates come from prior editorial labels and may be stale.");
    const palette={security:["PRIVACY REVIEW","#fb7185"],release:["RELEASE GATE","#fbbf24"],overlap:["POTENTIAL OVERLAP","#c084fc"],review:["NEEDS REVIEW","#a78bfa"],quiet:["NO RECENT PUSH","#60a5fa"]};
    $("#decisionList").innerHTML=selected.length?selected.map(item=>{
      const [label,color]=palette[item.kind];
      const links=item.secondary?'<a href="#project/'+encodeURIComponent(item.secondary)+'">'+enc(tr("المشروع المرتبط","Related project"))+' ↗</a>':"";
      return '<article class="decision-item" style="--signal-color:'+color+'"><div class="decision-topline">'+
        '<span class="decision-severity">'+label+'</span><span class="decision-data-tag">'+enc(item.stamp)+'</span></div>'+
        '<h3>'+enc(item.title)+'</h3><p>'+enc(tr(item.ar,item.en))+'</p>'+
        '<div class="decision-bottom"><a href="#project/'+encodeURIComponent(item.project)+'">'+enc(tr("ملف المشروع","Project hub"))+' ↗</a>'+
        (item.relationIndex!==undefined?'<button type="button" data-map-edge="'+item.relationIndex+'">'+enc(tr("العلاقة على الخريطة","Map relation"))+' ↗</button>':links)+'</div></article>';
    }).join(""):'<div class="decision-no-results">'+enc(tr("مفيش إشارات مطابقة حاليًا، أو بيانات GitHub غير كافية.","No matching review signals, or insufficient public GitHub data."))+'</div>';
    $("#decisionDisclaimer").textContent=tr("اللوحة دي أداة للمراجعة مش تنفيذ تلقائي. لا توجد صلاحية حذف أو إخفاء أو دمج أي مشروع. قلة النشاط لا تعني فشل المشروع، والتداخل لا يعني تكرار الكود. كل المعروض Public فقط.",
      "This is a review aid, not an automation. Low activity is not failure; overlap is not verified duplication. No changes to repositories are made. Public-only visibility.");
  }
  function refresh(){
    const current=publicRelations();
    if(!current.some(r=>r.index===focusedIndex))focusedIndex=current[0]?.index??null;
    relationRender();decisionRender();requestAnimationFrame(drawEdges);
  }
  document.addEventListener("click",e=>{
    const type=e.target.closest("[data-relation-type]");
    if(type){
      relationFilter=type.dataset.relationType;
      const filtered=publicRelations().filter(r=>relationFilter==="all"||r.type===relationFilter);
      focusedIndex=filtered[0]?.index??null;
      relationRender();return;
    }
    const map=e.target.closest("[data-map-edge],[data-edge]");
    if(map){
      const index=Number(map.dataset.mapEdge??map.dataset.edge);
      if(Number.isInteger(index))focusMap(index,true);
      return;
    }
    const filter=e.target.closest("[data-decision-filter]");
    if(filter){decisionFilter=filter.dataset.decisionFilter;decisionRender();}
  });
  $("#decisionSort").addEventListener("change",e=>{decisionSort=e.target.value;decisionRender();});
  $("#repoSearch").addEventListener("input",()=>requestAnimationFrame(drawEdges));
  $("#zoomIn").addEventListener("click",()=>requestAnimationFrame(drawEdges));
  $("#zoomOut").addEventListener("click",()=>requestAnimationFrame(drawEdges));
  $("#fitMap").addEventListener("click",()=>requestAnimationFrame(drawEdges));
  $("#resetMap").addEventListener("click",()=>requestAnimationFrame(drawEdges));
  window.addEventListener("abud:refresh",refresh);
  window.addEventListener("resize",()=>requestAnimationFrame(drawEdges));
  // Public browser refresh changes membership, so any formerly public edges disappear.
  window.ABUD_DECISIONS={
    refresh,focusMap,
    getState:()=>({relations:publicRelations().length,signals:getSignals().length,filter:decisionFilter,focusedIndex})
  };
  refresh();
})();
