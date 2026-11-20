'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = n => n == null ? '—' : Number(n).toLocaleString('zh-CN');
const money = n => n == null ? '待核实' : '$' + Number(n).toFixed(6);
const date = s => s ? new Date(s).toLocaleString('zh-CN', {hour12:false}) : '尚未更新';
const safeUrl = s => /^https?:\/\//i.test(s || '') ? esc(s) : '#';
const { paperTime, chronological, layoutTree, visibleTree, impactScores, impactLayout, timelineLayout, titleFontSize } = AtlasCore;
let state, currentNode = null, paperData, view = 'map', activeTab = 'library', filter = '';
let editMode = false, selectedNode = null, editing = null, mapLayout, camera = null, routeVersion = 0;
let toastTimer, searchGeneration = 0, settingsTab = 'connection', resizeObserver;
let settingsDirty=false,usageScale='day',usageDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),usagePage=0,usageRequest=0;
let navOrigin = null, inTransition = false;
let libraryView='timeline', dialogVersion=0, collectionObserver,relatedGraph=null,relatedNode=null;
let collapsedNodes=new Set();
let detailPaperId=null;
let globalLibrary=[],libraryQuery='',libraryCategory='assigned';
const timelineCameras=new Map();
const sectionRoutes={map:'#map',library:'#library',settings:'#settings'},nodeViews=new Map(),sectionScrolls=new Map();
let activeRoute=location.hash||'#map';
try { libraryView=['impact','network'].includes(localStorage.getItem('atlas-library-view'))?localStorage.getItem('atlas-library-view'):'timeline'; } catch {}
try { collapsedNodes=new Set(JSON.parse(localStorage.getItem('atlas-collapsed-nodes')||'[]')); } catch {}
const pending = new Map();
async function api(path, data) {
  const r = await fetch(path, data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json','X-ResearchMap':'1'}, body:JSON.stringify(data)});
  const j = await r.json(); if (!r.ok) throw Error(j.error || '请求失败'); return j;
}
function toast(text, error = false) {
  const el = $('#toast'); el.textContent = text; el.classList.toggle('error', error); el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4500);
}
const actionError = e => toast(e.message || String(e), true);
function modal(title, body, source=null) {
  detailPaperId=null;
  ++dialogVersion;
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = body;
  const paper=!!$('#modal-body .paper-detail');
  $('#modal').classList.toggle('paper-modal',paper);
  $('#modal').setAttribute('aria-labelledby',paper?'paper-detail-title':'modal-title');
  if(paper)$('#modal-body .paper-detail h3').id='paper-detail-title';
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal-body').scrollTop = 0;
  AtlasMotion.openDialog($('#modal'),source);
}
async function closeModal() { detailPaperId=null;const version=++dialogVersion; ++searchGeneration; if(await AtlasMotion.closeDialog($('#modal')) && version===dialogVersion)$('#modal').close(); }
const nodes = () => state?.nodes || [];
const node = id => nodes().find(n => n.id === id);
const children = id => nodes().filter(n => n.parent_id === id);
function pathFor(id) {
  const chain = [], seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); const n = node(id); if (!n) break; chain.unshift(n); id = n.parent_id; }
  return chain;
}
async function loadState() { state = await api('/api/state'); updateActivity(); applyModelCheck(); return state; }
// Startup model check results fill the connection panel without refetching or rebuilding the form.
function applyModelCheck(){
  const check=state?.model_check,list=$('#available-models'),status=$('#models-status'),result=$('#connection-test-result');
  if(!check?.status||!list||!status||!result)return;
  const stamp=(check.started_at||'')+check.status+(check.models||[]).length;
  if(list.dataset.manual==='true'||list.dataset.startupCheck===stamp)return;
  list.dataset.startupCheck=stamp;
  const model=$('#settings-form')?.elements.model?.value||'';
  if(check.models?.length){list.innerHTML='<option value="">选择可用模型（显示全部）</option>'+check.models.map(id=>'<option value="'+esc(id)+'">'+esc(id)+'</option>').join('');list.value=check.models.includes(model)?model:'';}
  status.textContent=check.models?.length?'启动时已获取 '+check.models.length+' 个模型，默认使用上次选择的模型 '+check.model+(check.models.includes(check.model)?'':'（不在本次列表中）'):check.model_error?'启动时获取模型失败：'+check.model_error:'启动时正在获取模型…';
  const web=check.test?.web?.message,extract=check.test?.extraction?.message;
  result.textContent=check.status==='running'?'启动检查：'+(check.message||'正在测试模型连通性')+'…':check.status==='error'?'启动检查：'+check.message:'启动检查：文字连接成功（'+check.model+'）。'+(extract?'快速提取：'+extract+'。':'')+'联网搜索：'+(web||'未确认');
  result.title=result.textContent;
}
function updateActivity() {
  const count = (state?.tasks || []).filter(t => t.status === 'running').length;
  $('#activity').textContent = count ? '处理中 · ' + count + ' ▾' : '任务中心 ▾';
  const badge=$('#error-count');if(badge){badge.hidden=!(state?.error_count);badge.textContent=state?.error_count||'';}
  if($('#update-impact')){
    const running=(state?.tasks||[]).some(t=>t.kind.startsWith('research:'+currentNode+':') && t.status==='running');
    $('#update-impact').disabled=running;$('#update-impact').textContent=running?'阅读中…':'↻ 阅读待分析论文';
  }
}
function monitor(task, label, done, failed) { pending.set(task.task_id, {label, done, failed}); }
async function poll() {
  if (!state || document.hidden) return;
  try {
    const structural = state.map_editor?.fingerprint;
    await loadState();
    if (structural !== state.map_editor?.fingerprint && view === 'map' && !editing && !MapEditor.busy && !inTransition && !$('#modal').open) drawMap();
    for (const [id, p] of pending) {
      const t = await api('/api/task?id=' + encodeURIComponent(id));
      if (t.status === 'running') continue;
      pending.delete(id);
      if (t.status === 'error'||t.status === 'interrupted') { toast(p.label + '：' + (t.error||'任务已中断'),t.status==='error'); p.failed?.(t.error||'任务已中断'); }
      else if (p.done) await p.done(t.result); else toast(p.label + '完成');
    }
    if(TaskCenter.isOpen)TaskCenter.refresh();
    if(view==='settings'&&settingsTab==='connection')loadConnectionUsage();
    if(view==='library'&&!$('#modal').open){
      const data=await api('/api/library');
      if(JSON.stringify(data.papers)!==JSON.stringify(globalLibrary)&&document.activeElement?.id!=='library-search'){globalLibrary=data.papers;renderGlobalLibrary();}
    }
    if(view==='node'&&!inTransition){
      const nid=currentNode,data=await api('/api/papers?node='+encodeURIComponent(nid));
      if(currentNode===nid&&view==='node'&&JSON.stringify(data)!==JSON.stringify(paperData)){
        const opened=detailPaperId,old=paperData?.library.find(p=>p.id===opened);paperData=data;renderCollection(false);
        const updated=data.library.find(p=>p.id===opened);
        if(opened&&$('#modal').open&&$('#make-summary')&&updated&&JSON.stringify(old)!==JSON.stringify(updated))paperDetail(updated,false);
      }
    }
  } catch (e) { $('#activity').textContent = '连接已断开'; }
}
function rememberOrigin(id,source=null) { navOrigin = {id,rect:source?.getBoundingClientRect()}; }
async function paintRoute(render, animate, entering) {
  resizeObserver?.disconnect();
  const renderPage=()=>{MapEditor.destroy();render();};
  collectionObserver?.disconnect();
  AtlasMotion.cancel('route');AtlasMotion.cancel('collection');
  if (typeof BranchJourney === 'undefined') { renderPage(); return; }
  BranchJourney.cancel();
  if (!animate) { AtlasMotion.swap($('#view'),renderPage,{key:'route'}); return; }
  inTransition = true;
  const id = entering ? navOrigin?.id : currentNode;
  const trail = new Set(pathFor(id).map(n => n.id));
  const branch = mapLayout?.positions.find(p => p.node.id === id)?.branch || '#3d679f';
  try {
    // Branch navigation explicitly uses spatial zoom, including with reduced system motion.
    await BranchJourney.run({render:renderPage, entering, id, origin:navOrigin?.rect, tree:nodes(), trail, color:branch});
  }
  finally { inTransition = false; if(view==='node')updateBranchTether(); }
}
async function route() {
  const version = ++routeVersion;
  let hash = decodeURIComponent(location.hash.slice(1) || 'map');if(hash==='errors'||hash==='tasks'){hash='map';history.replaceState(null,'','#map');TaskCenter.show();}
  if(hash==='usage'){hash='settings';settingsTab='connection';history.replaceState(null,'','#settings');}
  const nextNode = hash.startsWith('node/') ? hash.slice(5) : null;
  const nextView = nextNode ? 'node' : ['settings','library'].includes(hash) ? hash : 'map';
  if(view==='settings'&&nextView!=='settings'&&settingsDirty){
    if(!confirm('设置中有未保存的修改。确定放弃修改并离开？')){history.replaceState(null,'','#settings');return;}
    settingsDirty=false;
  }
  const previous = view, previousNode = currentNode;
  const previousSection=previous==='node'?'map':previous;
  const previousScroll=$('#view .global-library-list')||$('#view .recommendation-list');
  if(previousScroll)sectionScrolls.set(previousSection,previousScroll.scrollTop);
  if(previous==='node'&&previousNode)nodeViews.set(previousNode,{activeTab,filter,libraryView});
  try {
    if (!state) await loadState();
    let data;
    if (nextNode) {
      if (!node(nextNode)) { location.hash = 'map'; return; }
      data = await api('/api/papers?node=' + encodeURIComponent(nextNode));
    }
    if(nextView==='library')data=await api('/api/library');
    if (version !== routeVersion) return;
    const animate = ((previous === 'map' && nextView === 'node') || (previous === 'node' && nextView === 'map') || (previous === 'node' && nextView === 'node' && previousNode !== nextNode));
    if(nextNode&&navOrigin?.id!==nextNode)navOrigin={id:nextNode};
    if (nextView === 'map' && previousNode) navOrigin = {id:previousNode};
    if (previousNode !== nextNode) { const saved=nodeViews.get(nextNode);filter=saved?.filter||'';if(saved){activeTab=saved.activeTab;libraryView=saved.libraryView;} }
    const doRender = () => {
      currentNode = nextNode; view = nextView;
      $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === (nextView === 'node' ? 'map' : nextView)));
      $('#context-actions').innerHTML = '';
      if (nextView === 'node') { paperData = data; renderNode(); }
      else if (nextView === 'settings') renderSettings();
      else if (nextView === 'library') {globalLibrary=data.papers;renderGlobalLibrary();}
      else renderMap();
      activeRoute='#'+hash;sectionRoutes[nextView==='node'?'map':nextView]=activeRoute;
      const scroll=$('#view .global-library-list')||$('#view .recommendation-list');if(scroll)scroll.scrollTop=sectionScrolls.get(nextView==='node'?'map':nextView)||0;
    };
    await paintRoute(doRender, animate, nextView === 'node');
  } catch (e) {
    $('#view').innerHTML = '<div class="empty"><p>' + esc(e.message) + '</p><button id="retry-page">重新加载</button></div>';
    $('#retry-page').onclick = () => { state = null; route(); };
  }
}
function renderMap() {
  MapEditor.mount({
    document:()=>state.map_editor, collapsed:collapsedNodes, api, modal, closeModal,
    toast, error:actionError, view:()=>view,
    editing:active=>{editing=active?{mapEditor:true}:null;},
    layout:value=>{mapLayout=value;},
    updated:async doc=>{await loadState();},
    remount:renderMap,
    enter:id=>{rememberOrigin(id,document.querySelector('[data-map-id="'+CSS.escape(id)+'"]'));location.hash='node/'+encodeURIComponent(id);}
  });
}
function drawMap() { if(view==='map'&&state?.map_editor)MapEditor.draw(state.map_editor); }
function fitMap() { if(view==='map')MapEditor.fit(); }
function editNode(id) {
  const n = node(id), descendants = new Set([id]);
  function gather(pid) { children(pid).forEach(k => { descendants.add(k.id); gather(k.id); }); } gather(id);
  modal('方向设置', '<form id="node-form"><div class="form-grid"><label class="field wide">方向名称<input name="name" required maxlength="160" value="' + esc(n.name) + '"></label><label class="field wide">所属方向<select name="parent_id" ' + (!n.parent_id ? 'disabled' : '') + '>' + nodes().filter(x => !descendants.has(x.id)).map(x => '<option value="' + esc(x.id) + '" ' + (x.id === n.parent_id ? 'selected' : '') + '>' + esc(pathFor(x.id).map(k => k.name).join(' / ')) + '</option>').join('') + '</select></label><label class="field wide">检索关键词<textarea name="keywords" rows="3" placeholder="关键词一; 关键词二">' + esc(n.keywords) + '</textarea><small>用英文分号分隔短语。</small></label></div><div class="form-footer">' + (n.parent_id ? '<button type="button" id="delete-node" class="danger">删除方向</button>' : '') + '<button class="primary">保存</button></div></form>');
  $('#node-form').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('/api/nodes/save', {id, name:f.get('name'), parent_id:n.parent_id ? f.get('parent_id') : null, keywords:f.get('keywords')}); closeModal(); await loadState(); await route(); }
    catch (e) { actionError(e); }
  };
  if ($('#delete-node')) $('#delete-node').onclick = async () => {
    if (!confirm('删除此方向及其论文关联？请先移走子方向。')) return;
    try { await api('/api/nodes/delete', {id}); closeModal(); selectedNode = null; await loadState(); if (currentNode === id) location.hash = 'map'; else route(); }
    catch (e) { actionError(e); }
  };
}
let contextLayout,contextLoupeZoom=1.12;
function contextMap() {
  const ctx = document.createElement('canvas').getContext('2d');
  const family=getComputedStyle(document.body).fontFamily;
  const measure=(s,f,style={})=>{ctx.font=(style.italic?'italic ':'')+(style.weight||500)+' '+f+'px '+family;const m=ctx.measureText(s);return Math.max(m.width,(m.actualBoundingBoxLeft||0)+(m.actualBoundingBoxRight||0));};
  const global=ContextAtlas.layout(nodes(),measure,state.map_editor),focus=ContextAtlas.layout(ContextAtlas.branch(nodes(),currentNode),measure,state.map_editor);
  const trail=new Set(pathFor(currentNode).map(n=>n.id)),options={selected:currentNode,trail,alignment:MapEditorCore.alignment(state.map_editor)};
  contextLayout={global,focus};
  return '<div class="context-overview context-panel" aria-label="全局研究地图，悬停可放大，滚轮调整倍率">'+ContextAtlas.svg(global,{...options,overview:true})+'<div class="overview-selection" aria-hidden="true"></div><span class="overview-hint">悬停放大 · 滚轮缩放</span></div><div class="context-bridge" aria-hidden="true"><svg><path/></svg></div><div class="context-focus context-panel" aria-label="当前父分支">'+ContextAtlas.svg(focus,options)+'</div><div class="overview-loupe" aria-hidden="true">'+ContextAtlas.svg(global,{...options,lens:true})+'<span class="loupe-magnification"></span></div><svg class="branch-tether" aria-hidden="true"><path/><circle r="3"/></svg>';
}
function fitContextMap() {
  const overview=$('.context-overview'),outline=$('.overview-selection');if(!overview||!contextLayout)return;
  const ids=new Set(ContextAtlas.branch(nodes(),currentNode).map(n=>n.id));
  const ps=contextLayout.global.positions.filter(p=>ids.has(p.node.id)),m=contextLayout.global,r=overview.getBoundingClientRect();
  const z=Math.min(r.width/m.width,r.height/m.height),dx=(r.width-m.width*z)/2,dy=(r.height-m.height*z)/2;
  if(ps.length){const x=Math.min(...ps.map(p=>p.x))-8,y=Math.min(...ps.map(p=>p.y))-8,right=Math.max(...ps.map(p=>p.x+p.width))+8,bottom=Math.max(...ps.map(p=>p.y+p.height))+8;Object.assign(outline.style,{left:dx+x*z+'px',top:dy+y*z+'px',width:(right-x)*z+'px',height:(bottom-y)*z+'px'});}
  const bridge=$('.context-bridge'),br=bridge.getBoundingClientRect(),box=outline.getBoundingClientRect(),focus=$('.context-focus').getBoundingClientRect(),svg=bridge.querySelector('svg'),path=svg.querySelector('path');
  svg.setAttribute('viewBox','0 0 '+br.width+' '+br.height);
  const sx=box.right-br.left,tx=focus.left-br.left+14;
  path.setAttribute('d','M'+sx+' '+(box.top-br.top)+' L'+tx+' '+(focus.top-br.top+1)+' M'+sx+' '+(box.bottom-br.top)+' L'+tx+' '+(focus.bottom-br.top-1));
  updateBranchTether();
}
function updateBranchTether() {
  const host=$('.context-map'),svg=$('.branch-tether'),selected=$('.context-focus [data-context-id="'+CSS.escape(currentNode)+'"] rect');
  if(!host||!svg||!selected)return;
  const h=host.getBoundingClientRect(),r=selected.getBoundingClientRect();
  const boxes=[...document.querySelectorAll('.context-focus [data-context-id] rect')].map(el=>el.getBoundingClientRect());
  const route=ContextAtlas.tether({x:r.right-h.x,y:r.y-h.y+r.height/2},boxes.map(b=>({x:b.left-h.x,y:b.top-h.y,width:b.width,height:b.height})),host.clientWidth,$('.paper-surface').getBoundingClientRect().top-h.y);
  svg.setAttribute('viewBox','0 0 '+h.width+' '+h.height);
  const path=svg.querySelector('path'),circle=svg.querySelector('circle');
  path.setAttribute('d',route.path);
  circle.setAttribute('cx',route.x);circle.setAttribute('cy',route.y);
}
function bindContextLoupe(){
  const overview=$('.context-overview'),loupe=$('.overview-loupe'),host=$('.context-map');
  const move=(x,y)=>{const r=overview.getBoundingClientRect(),h=host.getBoundingClientRect(),size=Math.min(216,h.width*.48),v=ContextAtlas.pointer(contextLayout.global,r,x,y,contextLoupeZoom,size);loupe.style.width=size+'px';loupe.style.height=size+'px';loupe.querySelector('svg').setAttribute('viewBox',[v.x,v.y,v.width,v.height].join(' '));loupe.querySelector('.loupe-magnification').textContent=contextLoupeZoom.toFixed(1)+'×';Object.assign(loupe.style,{left:Math.max(0,Math.min(h.width-size,x-h.x+22))+'px',top:Math.max(0,y-h.y-size/2)+'px'});loupe.classList.add('is-visible');};
  overview.onpointermove=e=>move(e.clientX,e.clientY);overview.onpointerleave=()=>loupe.classList.remove('is-visible');
  overview.addEventListener('wheel',e=>{if(!e.deltaY)return;e.preventDefault();contextLoupeZoom=ContextAtlas.wheelZoom(contextLoupeZoom,e.deltaY,e.deltaMode);move(e.clientX,e.clientY);},{passive:false});
  overview.onfocusin=e=>{const r=e.target.getBoundingClientRect();move(r.x+r.width/2,r.y+r.height/2);};overview.onfocusout=()=>loupe.classList.remove('is-visible');
}
function renderNode() {
  resizeObserver?.disconnect();
  const n = node(currentNode);
  const context=contextMap();
  const branch=mapLayout?.positions.find(p=>p.node.id===n.id)?.branch||'#3d679f';
  $('#context-actions').innerHTML = '<button id="back-map">← 返回地图</button><button id="add-paper" class="primary">＋ 添加论文</button>';
  $('#view').innerHTML = '<section class="direction-view" style="--branch:'+branch+'"><header class="branch-context"><div class="context-map">'+context+'</div><button class="icon-button" id="edit-direction" title="方向关键词与设置" aria-label="方向设置">•••</button></header><section class="paper-surface" aria-label="'+esc(n.name)+'的论文"><div class="collection-bar"><div class="tabs" role="tablist" aria-label="文献分类"><button role="tab" aria-selected="' + (activeTab === 'library') + '" class="' + (activeTab === 'library' ? 'active' : '') + '" data-tab="library">个人文献</button><button role="tab" aria-selected="' + (activeTab === 'recommendations') + '" class="' + (activeTab === 'recommendations' ? 'active' : '') + '" data-tab="recommendations">最新推荐 <span class="ai-dot"></span></button></div><input id="paper-filter" class="filter-input" aria-label="搜索本方向论文" placeholder="搜索标题、作者、标签…"><div id="collection-actions"></div></div><div id="collection-content" class="collection-content"></div></section></section>';
  $('#back-map').onclick = () => { rememberOrigin(currentNode); location.hash = 'map'; };
  const search=$('#paper-filter'),searchBox=document.createElement('label');searchBox.className='paper-search';
  searchBox.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
  search.before(searchBox);searchBox.append(search);
  $('#add-paper').onclick = () => addPaper(currentNode);
  $('#edit-direction').onclick = () => editNode(currentNode);
  $$('[data-context-id]').forEach(b=>b.onclick=()=>{if(b.dataset.contextId!==currentNode){rememberOrigin(b.dataset.contextId,b);location.hash='node/'+encodeURIComponent(b.dataset.contextId);}});
  $$('[data-tab]').forEach(b => b.onclick = () => {
    if(activeTab===b.dataset.tab)return;
    activeTab=b.dataset.tab;filter='';$('#paper-filter').value='';
    $$('[data-tab]').forEach(t=>{t.classList.toggle('active',t===b);t.setAttribute('aria-selected',t===b);});renderCollection();
    if(activeTab==='recommendations')markRecommendationsSeen();
  });
  $('#paper-filter').value = filter;
  $('#paper-filter').oninput = e => { filter = e.target.value;  renderCollection(false); };
  fitContextMap();
  bindContextLoupe();
  $$('[data-context-id]').forEach(b=>b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();b.onclick();}});
  resizeObserver=new ResizeObserver(fitContextMap);resizeObserver.observe($('.context-map'));
  renderCollection(false);
  if(activeTab==='recommendations')markRecommendationsSeen();
}
function updateRecommendationBadge(){
  const tab=$('[data-tab="recommendations"]');if(!tab)return;
  tab.style.position='relative';tab.querySelector('.ai-dot')?.remove();tab.querySelector('.recommendation-badge')?.remove();
  const count=paperData?.recommendation_status?.unread_count||0;
  if(count){const badge=document.createElement('span');badge.className='recommendation-badge';badge.textContent=count;badge.setAttribute('aria-label',count+' 篇新推荐');tab.append(badge);}
}
async function markRecommendationsSeen(){
  const nid=currentNode,ids=(paperData?.recommendations||[]).map(p=>p.id);
  if(!ids.length||!paperData?.recommendation_status?.unread_count)return;
  try{const status=await api('/api/recommendations/seen',{node_id:nid,paper_ids:ids});if(currentNode===nid){paperData.recommendation_status=status;updateRecommendationBadge();}}catch(e){actionError(e);}
}
async function toggleRecommendations(button){
  const nid=currentNode,enabled=paperData?.recommendation_status?.enabled!==false;button.disabled=true;
  try{const status=await api('/api/recommendations/preferences',{node_id:nid,enabled:!enabled});if(currentNode===nid){paperData.recommendation_status=status;button.setAttribute('aria-checked',String(status.enabled));button.setAttribute('aria-label',status.enabled?'开启推荐':'关闭推荐');button.querySelector('.switch-label').textContent=status.enabled?'开启推荐':'关闭推荐';button.disabled=false;}}catch(e){button.disabled=false;actionError(e);}
}
function empty(text, action) { return '<div class="empty"><div class="empty-glyph">◇</div><p>' + esc(text) + '</p>' + (action || '') + '</div>'; }
function labelDefinitions(){return state?.settings?.paper_labels||[];}
function labelName(id){return labelDefinitions().find(label=>label.id===id)?.name||id;}
function tags(p, ai = false) {
  return (!ai&&['reading','queued','error','interrupted'].includes(p.research_status)?'<span class="tag paper-reading-state">'+researchLabel(p)+'</span>':'')+(p.tag || '').split(',').filter(Boolean).map(id=>{
    const label=ai?null:labelDefinitions().find(entry=>entry.id===id);
    const hex=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(value)?value:fallback;
    return '<span class="tag"'+(label?' style="color:'+hex(label.color,'#526784')+';background:'+hex(label.background,'#e4eaf3')+';--tag-icon:'+hex(label.icon_color,'#526784')+'"':'')+'>'+(label?.icon?'<span class="paper-label-icon" aria-hidden="true">'+esc(label.icon)+'</span> ':'')+esc(label?.name||id)+(ai?'<small>AI生成</small>':'')+'</span>';
  }).join('');
}
function filteredPapers() {
  return paperData[activeTab].filter(p => [p.title,p.authors,p.remark,...(p.tag||'').split(',').map(id=>activeTab==='library'?labelName(id):id)].join(' ').toLowerCase().includes(filter.toLowerCase()));
}
function renderCollection(animate=true) {
  const render=()=>drawCollection();
  if(animate)AtlasMotion.swap($('#collection-content'),render,{shared:true});else render();
}
function drawCollection() {
  collectionObserver?.disconnect();
  updateRecommendationBadge();
  const list = filteredPapers(), el = $('#collection-content');
  if (activeTab === 'library') {
    $('#collection-actions').innerHTML = libraryView==='network'?'<button id="verify-citations">核验引用关系</button>':libraryView==='timeline'?'':'<button id="upload-impact">＋ 上传 PDF 阅读</button><button id="impact-info" class="icon-button" title="评分说明" aria-label="评分说明">ⓘ</button>';
    el.innerHTML='<div class="library-toolbar"><div class="library-switch" role="group" aria-label="个人文献视图"><button data-library="timeline" aria-pressed="'+(libraryView==='timeline')+'" class="'+(libraryView==='timeline'?'active':'')+'">时间轴</button><button data-library="impact" aria-pressed="'+(libraryView==='impact')+'" class="'+(libraryView==='impact'?'active':'')+'">影响力图</button><button data-library="network" aria-pressed="'+(libraryView==='network')+'" class="'+(libraryView==='network'?'active':'')+'">引用网络</button></div><span class="library-hint">'+(libraryView==='impact'?'圆大小与颜色按个人评分或 AI 评分':libraryView==='network'?'上传原文与已收录题录严格匹配':'按发表时间展开')+'</span></div><div id="library-canvas" class="library-canvas"></div>';
    $$('[data-library]').forEach(b=>b.onclick=()=>{
      if(libraryView===b.dataset.library)return;
      libraryView=b.dataset.library;
      try{localStorage.setItem('atlas-library-view',libraryView);}catch{}
      renderCollection();
    });
    if (!list.length) {
      $('#library-canvas').innerHTML = empty(filter ? '没有匹配的论文' : '此方向还没有个人文献', filter ? '' : '<button id="empty-add" class="primary">＋ 添加论文</button>');
      if ($('#empty-add')) $('#empty-add').onclick = () => addPaper(currentNode);
    } else if(libraryView==='network')renderCitationNetwork(list);else if(libraryView==='impact')renderImpact(list);else renderTimeline(list);
    if($('#verify-citations')){const running=state.tasks.some(t=>t.kind==='citations:'+currentNode&&t.status==='running');$('#verify-citations').disabled=running;$('#verify-citations').textContent=running?'引用核验中…':'刷新本地引用匹配';$('#verify-citations').onclick=verifyCitations;}
    if($('#upload-impact')){$('#upload-impact').onclick=()=>addPaper(currentNode);$('#impact-info').onclick=impactInfo;}
    if(list.length){
      const canvas=$('#library-canvas');let width=canvas.clientWidth,height=canvas.clientHeight;
      collectionObserver=new ResizeObserver(()=>{
        if(!canvas.isConnected || Math.abs(width-canvas.clientWidth)<1 && Math.abs(height-canvas.clientHeight)<1)return;
        width=canvas.clientWidth;height=canvas.clientHeight;
        if(libraryView==='network')renderCitationNetwork(filteredPapers());else if(libraryView==='impact')renderImpact(filteredPapers());else renderTimeline(filteredPapers());
      });collectionObserver.observe(canvas);
    }
  } else {
    $('#collection-actions').innerHTML = '<button id="refresh-recs">↻ 更新推荐</button><button id="refresh-info" class="icon-button" title="检索记录" aria-label="检索记录">ⓘ</button>';
    $('#refresh-recs').onclick = refreshRecommendations;
    const toggle=document.createElement('button'),enabled=paperData?.recommendation_status?.enabled!==false;
    toggle.id='recommendation-toggle';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(enabled));toggle.setAttribute('aria-label',enabled?'开启推荐':'关闭推荐');toggle.innerHTML='<span class="switch-thumb" aria-hidden="true"></span><span class="switch-label">'+(enabled?'开启推荐':'关闭推荐')+'</span>';toggle.onclick=()=>toggleRecommendations(toggle);$('#collection-actions').prepend(toggle);
    $('#refresh-info').onclick = () => modal('检索记录', '<p class="subtle">最近 ' + state.settings.days + ' 天 · ' + esc(pathFor(currentNode).map(n=>n.name+(n.keywords?' ['+n.keywords+']':'')).join(' → ')) + '</p>' + (paperData.refresh_log.length ? paperData.refresh_log.map(log => '<details class="log"><summary>' + esc(date(log.started_at)) + ' · ' + esc(log.status) + '</summary><pre>' + esc(log.details || '进行中') + '</pre></details>').join('') : '<p>暂无检索记录</p>'));
    renderRecommendations(list);
  }
}
function renderCitationNetwork(list){
  if(relatedNode!==currentNode){relatedGraph=null;relatedNode=currentNode;}
  const full=!!relatedGraph,graph=relatedGraph||paperData.citation_network;
  const available=full?graph.papers:list.map(p=>({...p,directions:graph.papers?.find(x=>x.id===p.id)?.directions||[],local:true}));
  CitationNetwork.render({canvas:$('#library-canvas'),papers:available,network:graph,openPaper:p=>paperDetail(paperData.library.find(x=>x.id===p.id)||p,false),nodeId:currentNode,api,related:full,onRelated:g=>{relatedGraph=g;renderCitationNetwork(list);},onExit:()=>{relatedGraph=null;renderCitationNetwork(list);}});
  $$('#library-canvas [data-network-paper]').forEach(button=>{
    const paper=paperData.library.find(p=>p.id===button.dataset.networkPaper);
    if(paper&&['reading','queued','error','interrupted'].includes(paper.research_status)){
      const label=document.createElement('small');label.className='paper-reading-state';label.textContent=researchLabel(paper);button.append(label);
    }
  });
}
async function verifyCitations(){const nid=currentNode;try{const task=await api('/api/citations/refresh',{node_id:nid});monitor(task,'引用关系核验',async result=>{await loadState();await reloadPapers(nid);toast('已核验 '+result.verified+' 条引用关系');},async()=>{await loadState();await reloadPapers(nid);});await loadState();if(currentNode===nid)renderCollection(false);toast('正在匹配已存 PDF 参考文献，可在任务中心查看');}catch(e){actionError(e);}}
function renderTimeline(list) {
  const canvas=$('#library-canvas'),sorted=chronological(list),saved=timelineCameras.get(currentNode)||{zoom:1,left:0};
  const width=Math.max(canvas.clientWidth,(sorted.length+1)*165*saved.zoom),height=Math.max(1,canvas.clientHeight-48);
  const layout=timelineLayout(sorted,width,height),ctx=document.createElement('canvas').getContext('2d'),family=getComputedStyle(canvas).fontFamily;
  let flow='M'+Math.max(2,layout[0].anchorX-layout[0].width*.52)+','+height/2;
  let previous={anchorX:Math.max(2,layout[0].anchorX-layout[0].width*.52),anchorY:height/2};
  for(const p of layout){const bend=(p.anchorX-previous.anchorX)*.52;flow+=' C'+(previous.anchorX+bend)+','+previous.anchorY+' '+(p.anchorX-bend)+','+p.anchorY+' '+p.anchorX+','+p.anchorY;previous=p;}
  const end=Math.min(width-2,previous.anchorX+layout.at(-1).width*.52),bend=(end-previous.anchorX)*.52;
  flow+=' C'+(previous.anchorX+bend)+','+previous.anchorY+' '+(end-bend)+','+height/2+' '+end+','+height/2;
  const stems=layout.map(p=>'<path class="timeline-stem" d="M'+p.anchorX+','+p.anchorY+' V'+(p.above?p.y+p.height:p.y)+'"/>').join('');
  canvas.innerHTML='<div class="timeline-scroll" tabindex="0" aria-label="论文时间轴，可滚轮缩放并横向滚动"><div class="timeline" id="timeline" style="width:'+width+'px;height:'+height+'px" aria-label="连续波浪时间轴，发表时间从左向右"><svg class="timeline-wires" width="'+width+'" height="'+height+'" aria-hidden="true"><defs><marker id="time-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z"/></marker></defs><path class="timeline-halo" d="'+flow+'"/><path class="timeline-flow" marker-mid="url(#time-arrow)" marker-end="url(#time-arrow)" d="'+flow+'"/>'+stems+'</svg>'+layout.map(p=>{
    const compact=p.width<210||p.height<165,dense=p.height<125||p.width<145,padding=dense?7:compact?9:14,content=Math.max(5,p.height-(dense?31:compact?55:74));
    // Reserve the wrapped remark height before fitting the title into the remaining space.
    const remarkFont=Math.max(8,Math.min(12,p.width/16)),remarkLine=remarkFont*1.3,remarkWidth=Math.max(3,p.width-padding*2-2);
    let remarkLines=0;
    if(p.remark){ctx.font='400 '+remarkFont+'px '+family;let line='';remarkLines=1;for(const char of p.remark){const next=line+char;if(line&&ctx.measureText(next).width>remarkWidth){remarkLines++;line=char;}else line=next;}remarkLines=Math.max(1,Math.min(remarkLines,Math.floor(content*.5/remarkLine)));}
    const available=Math.max(5,content-(remarkLines?remarkLines*remarkLine+3:0));
    const size=titleFontSize(p.title,Math.max(3,p.width-padding*2-2),available,Math.min(18,p.width/12),(text,size)=>{ctx.font='500 '+size+'px '+family;return ctx.measureText(text).width;},2);
    const offset=p.above?p.anchorY-p.y-p.height:p.y-p.anchorY;
    return '<div class="time-slot '+(p.above?'above ':'below ')+(compact?'compact ':'')+(dense?'dense':'')+'" style="left:'+p.x+'px;top:'+p.y+'px;width:'+p.width+'px;height:'+p.height+'px;--dot-offset:'+offset+'px;--date-font:'+Math.min(8,p.width/12)+'px"><span class="time-dot"></span><button class="paper-tile" data-paper="'+esc(p.id)+'" title="'+esc(p.title+(p.remark?'\n'+p.remark:''))+'" aria-label="查看论文：'+esc(p.title)+'" style="--timeline-font:'+size+'px;--remark-font:'+remarkFont+'px;--remark-lines:'+Math.max(1,remarkLines)+'"><span class="tile-top"><span>'+esc(paperTime(p)||'日期未知')+'</span><span class="timeline-order">'+(p.index+1)+'</span></span><span class="tile-heading"><strong>'+esc(p.title)+'</strong>'+(p.remark?'<span class="tile-remark">'+esc(p.remark)+'</span>':'')+'</span><span class="tile-foot">'+tags(p)+'<span class="tile-source">'+esc(p.source)+'</span></span></button></div>';
  }).join('')+'</div></div><footer class="timeline-footer"><span>发表时间从左向右 → · 滚轮缩放，底部滚动条浏览</span><span class="timeline-zoom"><button data-time-zoom="out" aria-label="缩小时间轴">−</button><span>'+Math.round(saved.zoom*100)+'%</span><button data-time-zoom="in" aria-label="放大时间轴">＋</button><button data-time-zoom="reset">重置</button></span></footer>';
  $$('#library-canvas [data-paper]').forEach(b=>b.onclick=()=>paperDetail(sorted.find(p=>p.id===b.dataset.paper),false));
  const scroll=canvas.querySelector('.timeline-scroll');scroll.scrollLeft=saved.left;scroll.onscroll=()=>{saved.left=scroll.scrollLeft;timelineCameras.set(currentNode,saved);};
  const zoom=(factor,cx=scroll.clientWidth/2)=>{const next=Math.max(.35,Math.min(4,saved.zoom*factor)),newWidth=Math.max(canvas.clientWidth,(sorted.length+1)*165*next);saved.left=(scroll.scrollLeft+cx)*newWidth/width-cx;saved.zoom=next;timelineCameras.set(currentNode,saved);renderTimeline(list);};
  scroll.onwheel=event=>{if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;event.preventDefault();zoom(Math.exp(-event.deltaY*.0015),event.clientX-scroll.getBoundingClientRect().left);};
  $$('[data-time-zoom]').forEach(b=>b.onclick=()=>{if(b.dataset.timeZoom==='reset'){timelineCameras.delete(currentNode);renderTimeline(list);}else zoom(b.dataset.timeZoom==='in'?1.2:1/1.2);});
}
function renderImpact(list) {
  const canvas=$('#library-canvas'),scores=impactScores(paperData.library),ids=new Set(list.map(p=>p.id)),sorted=scores.filter(p=>ids.has(p.id));
  const width=canvas.clientWidth,height=Math.max(1,canvas.clientHeight-27),layout=impactLayout(sorted,width,height,12);
  const ctx=document.createElement('canvas').getContext('2d'),family=getComputedStyle(canvas).fontFamily;
  canvas.innerHTML='<div class="impact-cloud" role="group" aria-label="圆形论文词云，圆越大、颜色越深表示越重要">'+layout.map(p=>{
      const score=p.impact.score,light=93-score*.65,dark=score>=58,compact=p.width<140;
      const size=titleFontSize(p.title,p.width*(compact?.70:.71),p.height*(compact?.70:.49),Math.min(25,13+score*.13),(text,size)=>{ctx.font='550 '+size+'px '+family;return ctx.measureText(text).width;},2);
      const label=p.impact.provisional?researchLabel(p):score+(p.impact.manual?' · 用户':' · AI');
      return '<button data-paper="'+esc(p.id)+'" class="impact-tile '+(dark?'emphasis ':'')+(p.impact.provisional?'unscored ':'')+(compact?'compact':'')+'" style="left:'+p.x+'px;top:'+p.y+'px;width:'+p.width+'px;height:'+p.height+'px;--bubble-light:'+light+'%;--title-size:'+size+'px" title="'+esc(p.title)+' · '+esc(label)+'"><span class="impact-badge">'+esc(label)+'</span><span class="impact-title-wrap"><strong class="impact-title">'+esc(p.title)+'</strong></span></button>';
  }).join('')+'</div><footer class="collection-footer impact-footer"><button id="impact-method" class="text-button">评分说明 ⓘ</button><span>用户评分优先；未填写时采用 AI 评分</span></footer>';
  $$('#library-canvas [data-paper]').forEach(b=>b.onclick=()=>paperDetail(sorted.find(p=>p.id===b.dataset.paper),false));
  $('#impact-method').onclick=impactInfo;
}
function impactInfo(){modal('评分与阅读范围','<p>AI 评分依据上传 PDF 的全部可读文字片段及原文证据，按设置维度计算。用户评分始终独立并优先用于影响力图。</p><p>PDF 与完整正文不保存，重新阅读需重新上传。原文摘要与 AI 中文简介分开显示。未可靠读取的扫描件不评分。</p>');}
function continuousAbstract(value){return String(value||'').replace(/([A-Za-z])[-\u00ad]\s*\r?\n\s*(?=[a-z])/g,'$1').replace(/([\u3400-\u9fff])\s*\r?\n\s*(?=[\u3400-\u9fff])/g,'$1').replace(/\s+/g,' ').trim();}
function referenceCheckFor(p){
  const saved=p.pdf_document?.reading_coverage?.reference_verification;
  return state?.settings?.reference_local_verification===false?{...(saved||{}),version:2,status:'disabled',reason:'当前未开启参考文献本地核验；历史核验记录保留',items:saved?.items||[]}:saved;
}
function referenceCheckEvidence(p){
  const v=referenceCheckFor(p);if(!v)return '';
  const off=v.status==='disabled';
  return '<details class="reference-verification-detail"><summary>'+(off?'参考文献题名核验：未开启':v.status==='pending'?'参考文献题名核验：处理中':'参考文献题名核验：'+v.matched+' / '+v.total+' 条匹配')+'</summary><p>'+esc(v.reason||v.scope||'仅匹配参考文献题名')+'</p><p>基于本地 PDF／OCR 解析文字，可能受版式、断词影响，核验结果仅供参考。</p>'+(!off?(v.items||[]).map(item=>'<p>'+item.ordinal+'. '+esc(item.title||'题名未提供')+' · '+(item.status==='passed'?'题名匹配':'题名未匹配')+'</p>').join(''):'')+'</details>';
}
function pdfEvidence(p){
  const d=p.pdf_document,c=d?.reading_coverage||{},r=c.document_scope,checks=c.extraction_checks||[];
  const header='<p class="evidence-heading"><strong>上传资料与原文证据：</strong>'+(d?esc(d.page_count+' 页 · '+[...new Set(d.methods||[])].join('、')+' · PDF 和完整正文未保存'):'旧资料，尚无上传 PDF 证据，原有分数保留')+'</p>';
  const local='<details class="local-extraction-checks"><summary>本地解析交叉核对'+(checks.length?'（'+checks.length+' 页）':'')+'</summary>'+(checks.length?checks.map(x=>'<p>第 '+esc(x.page)+' 页 · '+esc(x.method)+' · '+esc(x.status)+(x.primary_coverage!=null?' · 文字覆盖 '+(x.primary_coverage*100).toFixed(1)+'%':'')+'</p>').join(''):'<p>暂无逐页交叉核对记录。</p>')+'<small>文字一致性核对不代表图表、公式语义已被独立验证。</small></details>';
  const range='<p class="evidence-range">阅读范围：'+(r?'保留 '+r.retained_pages+' / '+r.original_pages+' 页'+(r.excluded_tail?'；已裁切参考文献后的内容'+(r.partial_last_page?'（含同页后续内容）':''):'；未检测到明确的参考文献结束分界'):'暂无范围记录')+'。</p>';
  const sources='<details class="metadata-evidence"><summary>题录来源与日期核验</summary>'+((d?.metadata_evidence||[]).map(e=>'<p>'+esc(e.field)+' · '+(e.page?'第 '+esc(e.page)+' 页':'公开网页')+'<br>'+esc(e.quote||e.value||'')+(e.url?'<br><a target="_blank" rel="noopener noreferrer" href="'+safeUrl(e.url)+'">核验网页 ↗</a>':'')+'</p>').join('')||'<p>暂无题录来源记录。</p>')+'</details>';
  const abstract='<details class="original-abstract"><summary>原文摘要</summary><p>'+esc(continuousAbstract(p.abstract)||'未提取到可定位的原文摘要')+'</p></details>';
  const refs='<details class="original-references"><summary>参考文献原文（'+(p.references||[]).length+' 条）</summary>'+(c.reference_verification?.extraction_warning?'<p class="research-error">'+esc(c.reference_verification.extraction_warning)+'</p>':'')+(p.references||[]).map(x=>'<p>'+x.ordinal+'. '+esc(x.raw)+'<small>第 '+esc(x.page)+' 页</small></p>').join('')+'</details>';
  return '<details class="paper-evidence-group"><summary>资料来源、阅读范围与参考文献</summary><section class="pdf-evidence">'+header+local+range+sources+abstract+refs+referenceCheckEvidence(p)+'</section></details>';
}
function researchLabel(p){return p.research_status==='interrupted'?'AI阅读已中断':p.research_status==='error'?'AI阅读失败':p.research_status==='reading'?'AI阅读中':p.research_status==='queued'?'AI阅读中':p.ai_score!=null?'已完成':'待阅读';}
function impactDetail(p) {
  const scored=impactScores(paperData.library).find(x=>x.id===p.id);if(!scored)return '';
  const i=scored.impact;
  const criteria=(p.research_analysis?.criteria||[]).map(x=>'<div><dt>'+esc(x.name)+' · '+x.weight+'%</dt><dd>'+x.score+' / 100</dd></div><div class="score-evidence">'+esc(x.evidence)+(x.page?'<details><summary>第 '+x.page+' 页原文依据</summary><p>'+esc(x.quote||'')+'</p></details>':'')+'</div>').join('');
  const aiLabel=p.ai_score==null?researchLabel(p):p.ai_score+' / 100';
  const active=p.manual_score!=null?'当前使用用户评分':p.ai_score!=null?'未设置 · 当前使用 AI 评分':'未设置 · 等待 AI 评分';
  return '<section class="impact-detail"><div class="impact-detail-head"><span>AI 评分 · AI生成</span><strong>'+esc(aiLabel)+'</strong><button id="edit-impact-score" class="impact-edit-button">设置用户评分</button></div><dl><div><dt>用户评分</dt><dd>'+(p.manual_score==null?'':p.manual_score+' / 100 · ')+active+'</dd></div></dl><details class="score-details"><summary><span class="score-expand">展开详细评分与原文依据</span><span class="score-collapse">收起详细评分</span></summary><div class="score-criteria">'+criteria+'</div><p>阅读状态：'+esc(researchLabel(p))+(p.research_completed_at?' · '+esc(date(p.research_completed_at)):'')+'</p>'+(p.research_error?'<p class="research-error">'+esc(p.research_error)+' · 详情见任务中心</p>':'')+(p.research_analysis?.review?'<p>'+esc(p.research_analysis.review)+'</p>':'')+(p.research_sources||[]).map(s=>'<a '+(!s.url?'role="note" aria-disabled="true"':'target="_blank" rel="noopener noreferrer" href="'+safeUrl(s.url)+'"')+'>'+esc(s.name)+' · '+esc(s.verified_identifier||'')+(s.checked_at?' · '+esc(date(s.checked_at)):'')+(s.url?' ↗':'')+'</a>').join('')+'<button id="detail-impact-method" class="text-button">查看评分方式 ⓘ</button></details></section>';
}
function renderRecommendations(list) {
  const content=$('#collection-content');
    const latest=paperData.refresh_log?.[0];let notice='';
    if(latest?.status==='warning'){try{notice=JSON.parse(latest.details).warning||'';}catch{}}
    const warning=notice?'<p class="recommendation-notice" role="status">'+esc(notice)+'</p>':'';
    if(!list.length){content.innerHTML=warning+empty(filter?'没有匹配的论文':notice?'未检索到更新的论文':'暂无新推荐');return;}
    content.innerHTML=warning+'<div class="recommendation-list" role="list" aria-label="最新推荐论文，可在此区域滚动" tabindex="0">'+list.map(p=>'<div role="listitem"><button class="recommendation-row" data-rec="'+esc(p.id)+'"><span class="rec-date">'+esc(paperTime(p)||'日期未知')+'</span><span class="rec-body"><strong>'+esc(p.title)+'</strong><span class="rec-meta">'+esc(p.authors||'作者未提供')+' · '+esc(p.venue||p.source)+'</span><span class="rec-reason">'+esc(p.reason||'')+'</span><span class="rec-tags">'+tags(p,true)+'</span></span><span class="rec-open" aria-hidden="true">↗</span></button></div>').join('')+'</div><footer class="collection-footer"><span class="subtle">领域调研推荐 · 仅供阅读原始链接，不能直接收录</span><span>在列表内滚动浏览</span></footer>';
  $$('#collection-content [data-rec]').forEach(b=>b.onclick=()=>paperDetail(list.find(p=>p.id===b.dataset.rec),true));
}
function paperDetail(p, rec) {
  const remarkInput=$('#paper-remark');
  const draft=detailPaperId===p.id&&remarkInput&&remarkInput.value!==remarkInput.defaultValue?remarkInput.value:null;
  const nid = currentNode;
  const external=!rec&&!paperData.library.some(x=>x.id===p.id);
  const source=$$('[data-paper],[data-rec]').find(b=>(b.dataset.paper||b.dataset.rec)===p.id);
  const impact=rec||external?'':impactDetail(p);
  const summaryLabel=rec?(p.summary_kind||'公开网页调研概要'):(p.research_analysis?.preliminary?'初步概要 · 仅据已核验片段 · '+(['error','interrupted'].includes(p.research_status)?'后续阅读未完成，未生成完整评分':'AI阅读与评分仍在进行'):p.ai_summary?'AI生成 · '+(p.research_analysis?.evidence_scope||'核验材料'):p.abstract?'原文摘要 · '+(['reading','queued'].includes(p.research_status)?'题录、引用与AI评分仍在核验':'来自上传原文'):'AI '+researchLabel(p));
  const summaryText=rec?(p.summary||continuousAbstract(p.abstract)||'暂无摘要'):(p.ai_summary||continuousAbstract(p.abstract)||(['reading','queued'].includes(p.research_status)?'AI阅读中':p.research_status==='error'||p.research_status==='interrupted'?'请重新上传 PDF 进行阅读。':'旧资料，待上传 PDF 阅读。'));
  modal(p.title, '<article class="paper-detail"><h3>' + esc(p.title) + '</h3><p class="paper-meta">' + esc(p.authors || '作者未提供') + '<br>' + esc(paperTime(p) || '日期未知') + ' · ' + esc(p.venue || p.source) + '</p><div class="paper-tag-row"><div class="tags">' + tags(p, rec) + '<span class="tag verified">原始资料</span></div>'+(!rec&&!external?'<label class="detail-tag-editor">论文标签<select id="detail-paper-tag">'+tagOptions(p.tag)+'</select></label>':'')+'</div><div class="summary-label">' + esc(summaryLabel) + '</div><p class="paper-summary">' + esc(summaryText) + '</p>' + (rec ? '<div class="paper-note"><span>推荐理由 · AI生成</span><p>' + esc(p.reason || '未提供') + '</p></div>' : '') + '<a class="paper-link" '+(!p.url?'hidden ':'')+'href="' + safeUrl(p.url) + '" target="_blank" rel="noopener noreferrer">论文原文链接 ↗</a>' + impact + '<div class="form-footer">' + (external ? '<span>其他研究方向已收录论文</span>' : rec ? '<button id="dismiss-rec">忽略</button>' : '<button id="move-paper">'+(p.directions?.length?'移动至其他方向':'添加到研究方向')+'</button><button id="remove-paper">从该方向移除</button><button id="delete-paper" class="danger">删除文献</button><button id="make-summary">重新上传 PDF 阅读</button>') + '</div></article>',source);
  const verification=referenceCheckFor(p);
  const online=p.pdf_document?.reading_coverage?.online_verification;
  const article=p.pdf_document?.reading_coverage?.pdf_publication;
  {
    const labels={published:'发表日期',authors:'作者',venue:'发表平台'};
    const missing=online?.missing_fields||['published','authors','venue'].filter(key=>!p[key]);
    const manual=online?.status==='manual',ai=online?.research_mode==='api_only';
    const message=manual?'发表信息已手动矫正':online?.status==='pending'?'AI 联网调研进行中':online?.status==='pdf_extracted'?'':online?.label||(ai?'AI 调研尚未完成':'尚无 AI 调研结果');
    const info=document.createElement('details');info.className='online-verification publication-details';
    const preprint=online?.preprint||null,published=online?.published||null;
    const legacyConfirmed=online?.status==='ai_reported'&&!online?.publication_status;
    const statusText=manual?'已手动矫正':article?'从文章中提取':online?.publication_status==='published_confirmed'?'AI 已确认正式发表版本':online?.publication_status==='preprint_only'?'仅找到预印本':legacyConfirmed?'AI 已查得发表信息':'AI 未确认发表版本';
    const articleLine=article?'<p>从文章中提取：'+esc(article.venue)+(article.published?' · '+esc(article.published):'')+(article.doi?' · DOI '+esc(article.doi):'')+(article.page?' · 第 '+esc(article.page)+' 页原文':'')+'；优先于联网查询结果。</p>':'';
    const aiTitle=article&&ai?'<p class="publication-state">AI 联网补充（不覆盖文章中提取的发表信息）</p>':'';
    const versionLines=(published?'<p>正式版本：'+esc(published.venue||'已确认发表')+(published.published?' · '+esc(published.published):'')+(published.doi?' · DOI '+esc(published.doi):'')+'</p>':'')+(preprint?'<p>预印本版本：'+esc(preprint.arxiv?'arXiv:'+preprint.arxiv:preprint.venue||'预印本')+'</p>':'')+(!article&&online?.pdf_declared_venue&&online.pdf_declared_venue!==online?.online_confirmed_venue?'<p>PDF 中声明的发表平台：'+esc(online.pdf_declared_venue)+'（未作为正式发表信息）</p>':'');
    const confirmed=manual||!!article||online?.publication_status==='published_confirmed'||legacyConfirmed;
    const researchedVenue=online?.online_confirmed_venue||online?.venue;
    info.innerHTML='<summary>展开详细发表信息</summary>'+articleLine+aiTitle+(message&&statusText!==message?'<p class="publication-state">'+esc(message)+'</p>':'')+(!published&&!article&&researchedVenue&&researchedVenue!==p.venue?'<p>发表平台：'+esc(researchedVenue)+'</p>':'')+versionLines+(missing.length?'<p>暂未查得：'+missing.map(key=>labels[key]||key).map(esc).join('、')+'；不影响阅读评分。</p>':'')+(online?.summary?'<p>'+esc(online.summary)+'</p>':'');
    const meta=document.createElement('div'),link=$('.paper-detail .paper-link');
    meta.className='paper-meta';
    $('.paper-meta').replaceWith(meta);
    const publication=document.createElement('div');publication.className='paper-publication';
    const researching=online?.status==='pending';
    publication.innerHTML='<div class="publication-line"><span>'+[paperTime(p)||'日期未知',p.venue||p.source].filter(Boolean).map(esc).join(' · ')+'</span>'+(!rec?'<span class="publication-status '+(confirmed?'confirmed':'unconfirmed')+'">'+statusText+'</span>':'')+(!rec&&!external&&p.pdf_document?'<button type="button" id="research-publication" '+(manual||researching?'disabled ':'')+'title="'+(manual?'已手动矫正，手动资料优先':researching?'联网查询进行中':article?'重新联网查询；文章中提取的发表信息不会被覆盖':'重新联网查询并替换上一次联网结果')+'">'+(researching?'联网查询中…':'重新联网查询')+'</button>':'')+(!rec&&!external?'<button type="button" id="correct-publication">手动矫正</button>':'')+'</div>';
    meta.textContent=p.authors||'作者未提供';
    meta.append(publication);
    const original=[p.url,online?.publication_url,published?.url,preprint?.url].find(url=>safeUrl(url)!=='#');
    if(original){link.href=original;link.hidden=false;publication.append(link);}
    else {link.remove();publication.insertAdjacentHTML('beforeend','<span class="subtle">暂无论文原文链接</span>');}
    if(!rec){if(article&&!manual)publication.insertAdjacentHTML('beforeend','<span class="article-publication-note">发表信息从上传论文原文中提取</span>');else if(!manual&&(ai||legacyConfirmed))publication.insertAdjacentHTML('beforeend','<span class="ai-research-disclaimer">AI 调研生成，可能有误</span>');publication.append(info);}
    const research=$('#research-publication');
    if(research)research.onclick=async()=>{
      research.disabled=true;research.textContent='联网查询中…';
      const refresh=async()=>{await reloadPapers(currentNode);const updated=await api('/api/library/paper?id='+encodeURIComponent(p.id));if(paperData?.library){const index=paperData.library.findIndex(x=>x.id===p.id);if(index>=0)paperData.library[index]=updated;}if(detailPaperId===p.id)paperDetail(updated,false);};
      try{const task=await api('/api/library/publication/research',{paper_id:p.id});toast(article?'已开始联网查询；文章中提取的发表信息保持不变':'已开始重新联网查询');await refresh();monitor(task,'论文资料联网补查',async()=>{await refresh();toast('联网查询已完成');},refresh);}
      catch(error){research.disabled=false;research.textContent='重新联网查询';actionError(error);}
    };
  }
  if(!rec&&verification?.version===2){
    const passed=verification.status==='passed',pending=verification.status==='pending',disabled=verification.status==='disabled';
    $('.paper-detail .tags').insertAdjacentHTML('beforeend','<span class="tag reference-verification '+(disabled?'disabled':pending?'pending':passed?'passed':'failed')+'" title="参考文献题名与本地解析文字匹配，可能受版式、OCR和断词影响；核验结果仅供参考">'+(disabled?'未开启参考文献本地核验':pending?'参考文献处理中':passed?'参考文献已通过本地核验':'参考文献未通过本地核验')+'</span>');
  }
  if(!rec&&p.directions?.length){
    $('.paper-meta').insertAdjacentHTML('afterend','<section class="paper-directions"><span>所在方向</span>'+p.directions.map(d=>'<a href="#node/'+encodeURIComponent(d.id)+'" data-paper-direction>'+esc(d.name)+'</a>').join('')+'</section>');
    $$('[data-paper-direction]').forEach(link=>link.onclick=()=>closeModal());
  }
  if(!rec){
    $('.paper-detail>h3').insertAdjacentHTML('beforebegin','<form class="paper-remark-form"><label for="paper-remark">简短备注</label><input id="paper-remark" name="paper-remark" maxlength="120" value="'+esc(p.remark||'')+'" placeholder="写一句备注，显示在时间轴标题下"><button type="submit">保存备注</button></form>');
    if(draft!==null)$('#paper-remark').value=draft;
    $('.paper-remark-form').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,input=form.elements['paper-remark'],button=form.querySelector('button'),remark=input.value.trim();
      button.disabled=true;
      try{
        await api('/api/library/annotate',{paper_id:p.id,remark});p.remark=remark;
        if(detailPaperId===p.id){const active=$('#paper-remark');if(active){if(active.value.trim()===remark)active.value=remark;active.defaultValue=remark;}}
        await reloadPapers(nid);toast(remark?'论文备注已保存':'论文备注已清空');
      }
      catch(error){actionError(error);}finally{button.disabled=false;}
    };
  }
  if(!rec&&!external){
    $('#remove-paper').textContent='从该方向移除';$('#remove-paper').hidden=!p.directions?.length;
    $('#move-paper').onclick=()=>manageLibraryPaper(p,p.directions?.length?'move':'attach');
    $('#delete-paper').onclick=()=>deleteLibraryPaper(p);
    if(!p.directions?.length)$('#make-summary').hidden=true;
    $('#correct-publication').onclick=()=>correctPublication(p,rec);
    $('#detail-paper-tag').onchange=async event=>{const control=event.target,value=control.value;control.disabled=true;try{await api('/api/library/annotate',{paper_id:p.id,node_id:nid||p.primary_node||null,tag:value});p.tag=value;await reloadPapers(nid);if(detailPaperId===p.id&&control.isConnected)paperDetail(p,false);toast('论文标签已保存');}catch(error){control.value=p.tag||'';actionError(error);}finally{control.disabled=false;}};
  }
  if($('#detail-impact-method'))$('#detail-impact-method').onclick=impactInfo;
  const provenance=$('.paper-detail .summary-label');
  if(provenance){provenance.classList.add('paper-provenance');$('.paper-detail').append(provenance);}
  if(!rec&&!external){const details=document.createElement('div');details.innerHTML=pdfEvidence(p);$('.paper-detail').append(details.firstElementChild);}
  $$('.impact-detail .citation-warning').forEach(el=>{if(el.textContent===p.research_analysis?.evidence_scope)el.remove();});
  detailPaperId=rec?null:p.id;
  if($('#make-summary'))$('#make-summary').disabled=['queued','reading'].includes(p.research_status);
  if($('#remove-paper'))$('#remove-paper').disabled=['queued','reading'].includes(p.research_status);
  if($('#edit-impact-score'))$('#edit-impact-score').onclick=()=>editImpactScore(p,nid);
  if(external&&!rec)return;
  if (rec) {
    
    $('#dismiss-rec').onclick = async () => { try { await api('/api/recommendations/dismiss',{node_id:nid,paper_id:p.id}); closeModal(); await reloadPapers(nid); } catch(e) { actionError(e); } };
  } else {
    $('#make-summary').onclick = () => makeSummary(nid,p.id);
    $('#remove-paper').onclick = async () => {
      if(p.directions?.length>1){manageLibraryPaper(p,'remove');return;}
      if (!confirm('从该方向移除？论文及阅读资料会保留在未归类文献中。')) return;
      try { await api('/api/library/remove',{node_id:p.directions?.[0]?.id||nid,paper_id:p.id}); await closeModal(); await reloadPapers(nid);await loadState(); } catch (e) { actionError(e); }
    };
  }
}
async function reloadPapers(nid) {
  if(view==='library'){globalLibrary=(await api('/api/library')).papers;renderGlobalLibrary();return;}
  const data = await api('/api/papers?node=' + encodeURIComponent(nid));
  if (currentNode === nid && view === 'node') {
    const opened=detailPaperId,old=paperData?.library.find(p=>p.id===opened);
    paperData = data; renderCollection();
    const updated=data.library.find(p=>p.id===opened);
    if(opened&&$('#modal').open&&$('#make-summary')&&updated&&JSON.stringify(old)!==JSON.stringify(updated))paperDetail(updated,false);
  }
}
function renderGlobalLibrary(){
  $('#context-actions').innerHTML='';
  $('#view').innerHTML='<section class="utility-view global-library"><header class="global-library-head"><h2>论文库</h2><span id="library-count"></span><input id="library-search" type="search" aria-label="搜索论文库" placeholder="搜索题名、作者、DOI 或方向" value="'+esc(libraryQuery)+'"></header><nav class="library-categories" aria-label="文献归类"><button data-library-category="assigned">已归类文献</button><button data-library-category="unassigned">未归类文献</button></nav><div id="global-library-list" class="global-library-list"></div></section>';
  const draw=()=>{
    const q=libraryQuery.toLowerCase().trim(),category=globalLibrary.filter(p=>libraryCategory==='assigned'?p.directions.length:!p.directions.length),items=category.filter(p=>[p.title,p.authors,p.doi,...p.directions.map(d=>d.name)].join(' ').toLowerCase().includes(q));
    $$('[data-library-category]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.libraryCategory===libraryCategory));b.textContent=(b.dataset.libraryCategory==='assigned'?'已归类文献':'未归类文献')+' · '+globalLibrary.filter(p=>b.dataset.libraryCategory==='assigned'?p.directions.length:!p.directions.length).length;});
    $('#library-count').textContent=items.length+' / '+category.length+' 篇';
    $('#global-library-list').innerHTML=items.length?items.map(p=>'<article class="global-paper" data-library-paper="'+esc(p.id)+'"><button class="global-paper-title" data-library-open="'+esc(p.id)+'">'+esc(p.title)+'</button><p class="subtle">'+esc(p.authors||'作者未知')+' · '+esc(p.published||p.year||'日期未知')+' · '+esc(researchLabel(p))+(p.ai_score!=null?' · AI '+p.ai_score:'')+'</p><div class="library-memberships">'+p.directions.map(d=>'<a href="#node/'+encodeURIComponent(d.id)+'">'+esc(d.name)+'</a>').join('')+'</div><div class="global-paper-actions"><button data-library-manage="'+esc(p.id)+'">管理方向</button><button class="danger" data-library-delete="'+esc(p.id)+'">删除</button></div></article>').join(''):empty(q?'没有匹配的论文':'暂无已添加论文');
    $$('[data-library-open]').forEach(button=>button.onclick=async()=>{
      const p=globalLibrary.find(x=>x.id===button.dataset.libraryOpen),version=routeVersion;try{
        const detail=await api('/api/library/paper?id='+encodeURIComponent(p.id)),data=p.primary_node?await api('/api/papers?node='+encodeURIComponent(p.primary_node)):{library:[detail],recommendations:[]};
        if(version!==routeVersion||view!=='library'||!detail)return;
        paperData=data;currentNode=p.primary_node;paperDetail(detail,false);
      }catch(error){actionError(error);}
    });
    $$('[data-library-manage]').forEach(button=>button.onclick=()=>manageLibraryPaper(globalLibrary.find(x=>x.id===button.dataset.libraryManage)));
    $$('[data-library-delete]').forEach(button=>button.onclick=()=>deleteLibraryPaper(globalLibrary.find(p=>p.id===button.dataset.libraryDelete)));
  };
  $('#library-search').oninput=e=>{libraryQuery=e.target.value;draw();};$$('[data-library-category]').forEach(b=>b.onclick=()=>{libraryCategory=b.dataset.libraryCategory;draw();});draw();
}
async function refreshGlobalLibrary(){await loadState();globalLibrary=(await api('/api/library')).papers;if(view==='library')renderGlobalLibrary();}
async function deleteLibraryPaper(p){
  if(!confirm('永久删除这篇文献及其评分、资料、方向关联和任务记录？其他论文原文中对它的参考条目会保留。此操作不可撤销。'))return;
  try{await api('/api/library/manage',{action:'delete',paper_id:p.id});if($('#modal').open)await closeModal();if(view==='library')await refreshGlobalLibrary();else{await loadState();await reloadPapers(currentNode);}toast('文献及相关资料已删除');}catch(error){actionError(error);}
}
function manageLibraryPaper(p,initial='attach'){
  modal('管理论文方向','<p class="modal-intro">'+esc(p.title)+'</p><form id="library-manage-form"><label class="field">操作<select name="action"><option value="attach">添加到另一个方向</option><option value="move">移动方向</option><option value="remove">从一个方向移除</option></select></label><label class="field">来源方向<select name="source_node">'+p.directions.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.name)+'</option>').join('')+'</select></label><label class="field">目标方向<select name="target_node">'+nodes().map(n=>'<option value="'+esc(n.id)+'">'+esc(pathFor(n.id).map(x=>x.name).join(' / '))+'</option>').join('')+'</select></label><div class="form-footer"><button class="primary">确认</button></div></form>');
  const form=$('#library-manage-form');form.elements.action.onchange=()=>{form.elements.target_node.disabled=form.elements.action.value==='remove';form.elements.source_node.disabled=form.elements.action.value==='attach';};form.elements.action.onchange();
  if(!p.directions.length){form.elements.action.querySelectorAll('option').forEach(o=>{o.disabled=o.value!=='attach';});initial='attach';}
  form.elements.action.value=initial;form.elements.source_node.value=p.directions.some(d=>d.id===currentNode)?currentNode:p.directions[0]?.id||'';form.elements.action.onchange();
  form.onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form));try{await api('/api/library/manage',{...values,paper_id:p.id});await closeModal();if(view==='library')await refreshGlobalLibrary();else{await loadState();await reloadPapers(currentNode);}toast('论文方向已更新；没有方向的文献保留在未归类文献中');}catch(error){actionError(error);}};
}
async function refreshRecommendations() {
  if(paperData?.recommendation_status?.enabled===false){toast('此方向已关闭论文推荐，请先打开推荐功能。');return;}
  const nid = currentNode, button = $('#refresh-recs'); button.disabled = true;
  try {
    const task = await api('/api/refresh', {node_id:nid});
    monitor(task, '文献推荐', async result => { toast('已更新 ' + result.added + ' 篇推荐' + (result.warning ? ' · ' + result.warning : '')); await loadState(); await reloadPapers(nid); });
    toast('正在检索，完成后会提示');
  } catch (e) { actionError(e); } finally { if (button.isConnected) button.disabled = false; }
}
async function makeSummary(nid,pid){const p=paperData.library.find(p=>p.id===pid);if(p)addPaper(nid,p);}
function tagOptions(value = '') {
  const options=[['','暂不标记'],...labelDefinitions().filter(label=>!label.archived||label.id===value).map(label=>[label.id,[label.icon,label.name].filter(Boolean).join(' ')+(label.archived?'（已停用）':'')])];
  if(value&&!options.some(([id])=>id===value))options.push([value,value.split(',').map(labelName).join(' + ')]);
  return options.map(([v,l])=>'<option value="'+esc(v)+'" '+(v===value?'selected':'')+'>'+esc(l)+'</option>').join('');
}
function editImpactScore(p,nid) {
  modal('设置用户评分','<p class="modal-intro">'+esc(p.title)+'</p><form id="impact-score-form" class="impact-score-form"><label class="field">用户评分 · 0–100<input name="manual_score" type="number" min="0" max="100" step="1" value="'+esc(p.manual_score??'')+'" placeholder="未填写时采用 AI 评分"><small>用户评分独立于 AI 评分；清空后影响力图恢复使用 AI 评分。</small></label><div class="form-footer"><button type="button" id="reset-impact">清除用户评分</button><button class="primary">保存</button></div></form>');
  $('#impact-score-form .form-footer').insertAdjacentHTML('afterbegin','<button type="button" id="back-paper-detail">← 返回论文详情</button>');
  $('#back-paper-detail').onclick=()=>paperDetail(p,false);
  $('#reset-impact').onclick=()=>{$('#impact-score-form input').value='';};
  $('#impact-score-form').onsubmit=async e=>{
    e.preventDefault();const value=new FormData(e.target).get('manual_score');
    try{await api('/api/library/annotate',{node_id:nid,paper_id:p.id,manual_score:value===''?null:Number(value)});p.manual_score=value===''?null:Number(value);await reloadPapers(nid);paperDetail(p,false);toast(value===''?'已恢复使用 AI 评分':'用户评分已保存');}catch(error){actionError(error);}
  };
}
function correctPublication(p,rec=false){
  const fields=[['authors','作者'],['published','发表日期'],['venue','发表平台'],['url','论文原文链接']];
  modal('手动矫正发表信息','<p class="modal-intro">'+esc(p.title)+'</p><form id="publication-correction"><div class="form-grid">'+fields.map(([key,label])=>'<label class="field wide">'+label+'<input name="'+key+'" '+(key==='published'?'type="date"':key==='url'?'type="url"':'')+' value="'+esc(p[key]||'')+'"></label>').join('')+'</div><p class="subtle">修改适用于此论文的所有方向。保存后以手动资料为准，后续 AI 调研不会覆盖。</p><div class="form-footer"><button type="button" id="publication-back">← 返回论文详情</button><button class="primary">保存矫正</button></div></form>');
  $('#publication-back').onclick=()=>paperDetail(p,rec);
  $('#publication-correction').onsubmit=async event=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.target));await api('/api/library/publication',{paper_id:p.id,...values});await reloadPapers(currentNode);const updated=await api('/api/library/paper?id='+encodeURIComponent(p.id));if(paperData?.library){const index=paperData.library.findIndex(x=>x.id===p.id);if(index>=0)paperData.library[index]=updated;}paperDetail(updated,false);toast('发表信息已手动矫正');}catch(error){actionError(error);}};
}
function addPaper(nid,paper=null) {
  PdfUpload.open({nid,paper,tagOptions:tagOptions(),modal,close:closeModal,monitor,updated:async id=>{await loadState();activeTab='library';await reloadPapers(id);},error:actionError,toast});
}
function renderSettings() {
  const s = state.settings;
  $('#context-actions').innerHTML = '';
  const criteriaText=(s.score_criteria||[]).map(x=>[x.name,x.weight,x.description].join(' | ')).join('\n');
  const tabs=[['connection','模型连接'],['recommendations','文献推荐'],['scoring','论文评分'],['verification','核验设置'],['labels','论文标签'],['backup','备份与恢复']];
  const header=(id,title)=>`<header class="settings-panel-head"><h2>${title}</h2><div class="settings-save"><span data-save-state="${id}" role="status">已保存</span><button type="submit" class="primary" data-save-panel="${id}">保存设置</button></div></header>`;
  $('#view').innerHTML=`<section class="utility-view settings-view"><div class="tabs settings-tabs">${tabs.map(([id,label])=>`<button type="button" data-settings-tab="${id}" class="${settingsTab===id?'active':''}">${label}<span class="settings-dirty-dot" aria-hidden="true"></span></button>`).join('')}</div>
    <form id="settings-form" class="settings-form" novalidate>
      <section class="settings-panel connection-panel" data-panel="connection">${header('connection','模型连接')}
        <div class="connection-columns"><div class="connection-config">
          <label class="field">Base URL<input name="base_url" required value="${esc(s.base_url)}" spellcheck="false" title="Responses API 基础地址"></label>
          <label class="field">网络方式<select name="network_mode"><option value="auto">自动</option><option value="system">使用系统代理</option><option value="direct">直接连接</option></select></label>
          <label class="field">API Key<input name="api_key" type="password" autocomplete="new-password" spellcheck="false" placeholder="${state.key_configured?'已加密保存，留空保留':'输入 API Key'}"></label>
          <div class="connection-key-row"><small id="credential-status" class="subtle">${state.key_configured?'密钥已加密保存':'尚未保存密钥'}</small><button type="button" id="clear-api-key" class="danger" ${state.key_configured?'':'disabled'}>清除密钥</button></div>
          <label class="field">模型<input name="model" autocomplete="off" required value="${esc(s.model)}"><select id="available-models" aria-label="选择可用模型"><option value="">选择可用模型</option></select></label>
          <small id="models-status" class="subtle" role="status">尚未获取模型</small>
          <div class="form-footer"><button type="button" id="load-models">获取可用模型</button><button type="button" id="test-model">测试连接</button></div>
          <p id="connection-test-result" role="status"></p>
        </div><aside class="connection-usage" aria-label="模型用量">
          <div class="usage-controls"><h3>模型用量</h3><div class="usage-scale" role="group" aria-label="用量统计尺度">${[['day','日'],['week','周'],['month','月']].map(([id,label])=>`<button type="button" data-usage-scale="${id}" aria-pressed="${usageScale===id}">${label}</button>`).join('')}</div></div>
          <div class="usage-date-nav"><button type="button" id="usage-period-prev" aria-label="上一统计周期" title="上一统计周期">←</button><input type="date" id="usage-date" aria-label="用量日期" value="${usageDate}"><button type="button" id="usage-period-next" aria-label="下一统计周期" title="下一统计周期">→</button><button type="button" id="usage-today">今天</button></div>
          <p id="usage-period" class="subtle" role="status"></p><div id="usage-total" class="usage-total" aria-live="polite"></div><div id="connection-usage" aria-live="polite"></div>
          <footer class="usage-panel-footer"><small class="subtle">最新官方Token参考价 · USD/CNY分币种累计 · 不含工具费；悬停查看输入/缓存/输出单价</small><div class="pager"><button type="button" id="usage-prev" aria-label="上一页模型">←</button><span id="usage-page"></span><button type="button" id="usage-next" aria-label="下一页模型">→</button></div></footer>
        </aside></div>
      </section>
      <section class="settings-panel" data-panel="recommendations">${header('recommendations','文献推荐')}<div class="settings-panel-body"><div class="form-grid"><label class="field">最近多少天<input type="number" name="days" min="1" max="730" required value="${s.days}"></label><label class="field">更新间隔 / 小时<input type="number" name="refresh_hours" min="1" max="720" required value="${s.refresh_hours}"></label><label class="field">每方向推荐上限<input type="number" name="recommendation_limit" min="1" max="20" required value="${s.recommendation_limit}"></label><label class="check-label"><input type="checkbox" name="auto_refresh" ${s.auto_refresh?'checked':''}>启动时检查新文献</label></div></div></section>
      <section class="settings-panel" data-panel="scoring">${header('scoring','论文评分')}<div class="settings-panel-body"><label class="field">评分维度<textarea name="score_criteria" rows="10" required>${esc(criteriaText)}</textarea><small>维度名称 | 权重 | 评分说明；3–8 项，权重合计 100。</small></label></div></section>
      <section class="settings-panel" data-panel="verification">${header('verification','核验设置')}<div class="settings-panel-body"></div></section>
      <section class="settings-panel" data-panel="labels">${header('labels','论文标签')}<div class="settings-panel-body"><div id="label-settings-list"></div><button type="button" id="add-paper-label">＋ 新增标签</button></div></section>
      <section class="settings-panel" data-panel="backup">${header('backup','备份与恢复')}<div class="settings-panel-body"><p class="subtle">备份包含个人论文库（含未归类文献）、阅读资料、研究方向、节点备注和设置。不包含推荐、未收录题录、密钥、任务、错误、刷新记录和 API 用量。</p><div class="backup-actions"><button type="button" id="settings-export">导出 JSON 备份</button><button type="button" id="settings-import" class="primary">导入 JSON · 完整恢复</button><input type="file" id="backup-file" accept=".json,application/json" hidden></div><p class="subtle">恢复将覆盖当前论文库、导图和设置，并清空推荐、任务、错误及用量。失败时整体回滚；本机密钥保留，换设备需重新填写密钥。</p></div></section>
    </form></section>`;
  const form=$('#settings-form'),baselines=new Map();let saving=false,clearingCredential=false;
  const labelFields=[['name','标签名称'],['icon','图标字符'],['color','文字颜色'],['icon_color','图标颜色'],['background','背景颜色']];
  const labelList=$('#label-settings-list');
  const addLabelRow=(label,removable=false)=>labelList.insertAdjacentHTML('beforeend','<div class="label-settings-row" data-label-id="'+esc(label.id)+'">'+labelFields.map(([key,title])=>'<label class="field">'+title+'<input name="'+key+'" '+(key==='name'?'required maxlength="24"':key==='icon'?'maxlength="8" placeholder="例如 ★"':'type="color"')+' value="'+esc(label[key]||'')+'"></label>').join('')+'<label class="check-label"><input type="checkbox" name="archived" '+(label.archived?'checked':'')+'>停用</label>'+(removable?'<button type="button" data-remove-label>移除</button>':'')+'</div>');
  labelDefinitions().forEach(label=>addLabelRow(label));
  form.elements.network_mode.value=s.network_mode||'auto';
  $('[data-panel="verification"] .settings-panel-body').insertAdjacentHTML('beforeend','<div class="reference-check-setting"><label class="check-label"><input type="checkbox" name="reference_local_verification" '+(s.reference_local_verification!==false?'checked':'')+'>启用参考文献本地核验</label><small>基于本地 PDF／OCR 解析文字与 API 提取的论文题名进行匹配，可能因版式、断词或识别错误产生误判；核验结果仅供参考。关闭后不执行题名核验，不显示通过／未通过结论；参考条目清理及引用连线的原文证据保护仍保留。保存后对新阅读任务生效。</small></div>');
  $('[data-panel="verification"] .settings-panel-body').insertAdjacentHTML('beforeend','<div class="reference-check-setting"><label class="check-label"><input type="checkbox" name="online_publication_verification" '+(s.online_publication_verification!==false?'checked':'')+'>启用论文资料 AI 联网调研</label><small>全部交给 API 搜索与整理，已有 arXiv 也查正式发表版本。不进行本地学术核验或网页补查；AI 调研生成，可能有误。可在论文详情手动矫正。</small></div><div class="reference-check-setting"><label class="check-label"><input type="checkbox" name="verification_search_fallback" '+(s.verification_search_fallback!==false?'checked':'')+'>允许最新推荐使用本地搜索补查</label><small>仅影响最新推荐的候选发现。论文资料联网补查固定由 API 完成，不使用此本地搜索。</small></div>');
  const panelValue=panel=>JSON.stringify([...panel.querySelectorAll('[name]')].map(el=>[el.name,el.type==='checkbox'?el.checked:el.value]));
  $$('[data-panel]').forEach(panel=>baselines.set(panel.dataset.panel,panelValue(panel)));
  const updateDirty=()=>{
    settingsDirty=false;
    $$('[data-panel]').forEach(panel=>{
      const id=panel.dataset.panel,dirty=panelValue(panel)!==baselines.get(id);settingsDirty||=dirty;
      $(`[data-save-state="${id}"]`).textContent=dirty?'有修改，请保存':'已保存';
      $(`[data-save-state="${id}"]`).classList.toggle('unsaved',dirty);
      $(`[data-settings-tab="${id}"]`).classList.toggle('dirty',dirty);
      $(`[data-save-panel="${id}"]`).disabled=!dirty||saving||clearingCredential;
    });
    $('#clear-api-key').disabled=saving||clearingCredential||!state.key_configured;
  };
  const selectTab=id=>{
    settingsTab=id;
    $$('[data-settings-tab]').forEach(el=>el.classList.toggle('active',el.dataset.settingsTab===id));
    $$('[data-panel]').forEach(el=>el.classList.toggle('active',el.dataset.panel===id));
    $$('[data-save-panel]').forEach(el=>{if(el.dataset.savePanel===id)el.id='save-settings';else el.removeAttribute('id');});
    if(id==='connection')loadConnectionUsage();
  };
  form.addEventListener('input',updateDirty);form.addEventListener('change',updateDirty);
  $('#add-paper-label').onclick=()=>{if(labelList.children.length>=100){toast('最多可保存 100 个论文标签');return;}addLabelRow({id:'tag-'+crypto.randomUUID().replaceAll('-',''),color:'#526784',icon_color:'#526784',background:'#e4eaf3'},true);labelList.lastElementChild.querySelector('[name="name"]').focus();updateDirty();};
  labelList.onclick=event=>{const button=event.target.closest('[data-remove-label]');if(button&&!saving){button.closest('.label-settings-row').remove();updateDirty();}};
  $$('[data-settings-tab]').forEach(button=>button.onclick=()=>selectTab(button.dataset.settingsTab));
  const connectionDraft=()=>{const f=new FormData(form);return {base_url:f.get('base_url'),model:f.get('model'),network_mode:f.get('network_mode'),api_key:f.get('api_key')};};
  $('#clear-api-key').onclick=async()=>{
    if(saving||clearingCredential||!state.key_configured)return;
    if(!confirm('确认清除本机已保存的 API 密钥？'))return;
    clearingCredential=true;updateDirty();
    try{
      await api('/api/credentials/clear',{});
      state.key_configured=false;
      if(form.isConnected){
        form.elements.api_key.placeholder='输入 API Key';
        $('#credential-status').textContent='尚未保存密钥';
      }
      toast('已清除保存的密钥');
    }catch(error){actionError(error);}
    finally{clearingCredential=false;if(form.isConnected)updateDirty();}
  };
  form.onsubmit=async e=>{
    e.preventDefault();if(saving||clearingCredential)return;
    const id=e.submitter?.dataset.savePanel||settingsTab,panel=$(`[data-panel="${id}"]`),f=new FormData(form);
    if([...panel.querySelectorAll('[name]')].some(el=>!el.reportValidity()))return;
    let payload={};
    if(id==='connection')payload=connectionDraft();
    if(id==='recommendations')payload={days:Number(f.get('days')),refresh_hours:Number(f.get('refresh_hours')),recommendation_limit:Number(f.get('recommendation_limit')),auto_refresh:f.has('auto_refresh')};
    if(id==='scoring')payload={score_criteria:f.get('score_criteria').split(/\r?\n/).map(line=>line.split('|').map(x=>x.trim())).filter(parts=>parts.some(Boolean)).map(parts=>({name:parts[0],weight:Number(parts[1]),description:parts.slice(2).join(' | ')}))};
    if(id==='verification')payload={reference_local_verification:f.has('reference_local_verification'),online_publication_verification:f.has('online_publication_verification'),verification_search_fallback:f.has('verification_search_fallback')};
    if(id==='labels')payload={paper_labels:[...labelList.children].map(row=>({id:row.dataset.labelId,archived:row.querySelector('[name="archived"]').checked,...Object.fromEntries(labelFields.map(([key])=>[key,row.querySelector(`[name="${key}"]`).value]))}))};
    saving=true;updateDirty();$(`[data-save-state="${id}"]`).textContent='正在保存…';
    const submitted=panelValue(panel);
    try{
      await api('/api/settings',payload);await loadState();
      if(!form.isConnected)return;
      if(id==='labels')for(const row of labelList.children)if(state.settings.paper_labels.some(label=>label.id===row.dataset.labelId))row.querySelector('[data-remove-label]')?.remove();
      if(panelValue(panel)===submitted){
        if(id==='connection'){
          form.elements.base_url.value=state.settings.base_url;form.elements.api_key.value='';
          form.elements.api_key.placeholder=state.key_configured?'已加密保存，留空保留':'输入 API Key';
          $('#credential-status').textContent=state.key_configured?'密钥已加密保存':'尚未保存密钥';
        }
        baselines.set(id,panelValue(panel));
      }else baselines.set(id,submitted);
      toast('设置已保存');
    }catch(error){actionError(error);}
    finally{saving=false;if(form.isConnected)updateDirty();}
  };
  let modelGeneration=0;
  const loadModels=async()=>{const generation=++modelGeneration,b=$('#load-models'),status=$('#models-status');b.disabled=true;status.textContent='正在获取模型…';try{const result=await api('/api/models',connectionDraft());if(generation!==modelGeneration||!status.isConnected)return;$('#available-models').innerHTML='<option value="">选择可用模型（显示全部）</option>'+result.models.map(id=>'<option value="'+esc(id)+'">'+esc(id)+'</option>').join('');$('#available-models').value=result.models.includes($('#settings-form').elements.model.value)?$('#settings-form').elements.model.value:'';$('#available-models').dataset.manual='true';status.textContent='已获取 '+result.models.length+' 个模型，下拉框始终显示全部模型，也可手动填写。';}catch(e){if(status.isConnected)status.textContent=e.message;}finally{if(b.isConnected)b.disabled=false;}};
  $('#load-models').onclick=loadModels;
  applyModelCheck();
  $('#available-models').onchange=e=>{if(e.target.value){form.elements.model.value=e.target.value;updateDirty();}};
  $('#settings-form').elements.model.oninput=e=>{const list=$('#available-models');list.value=[...list.options].some(o=>o.value===e.target.value)?e.target.value:'';};
  $('#test-model').onclick = async () => {
    const button=$('#test-model'),result=$('#connection-test-result');$('#available-models').dataset.manual='true';button.disabled=true;result.textContent='正在测试文字连接、快速提取与联网搜索能力…';
    try {
      const task=await api('/api/test-model',connectionDraft());
      monitor(task,'模型连接测试',data=>{
        if(button.isConnected)button.disabled=false;
        if(result.isConnected){result.textContent='文字连接成功。'+(data.extraction?'快速提取：'+data.extraction.message+'。':'')+'联网搜索：'+(data.web?.message||'未确认');result.title=result.textContent;}
        toast('文字连接成功，token 已记录');
        loadConnectionUsage();
      },error=>{if(button.isConnected)button.disabled=false;if(result.isConnected)result.textContent='测试失败：'+error;});
    }catch(error){button.disabled=false;result.textContent=error.message;actionError(error);}
  };
  $('#settings-export').onclick = exportBackup;
  $('#settings-import').onclick=()=>$('#backup-file').click();
  $('#backup-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{const backup=JSON.parse(await file.text());if(!confirm('用此备份覆盖当前个人论文库、导图和设置？推荐、任务、错误及用量将清空；本机密钥保留。'))return;$('#settings-import').disabled=true;const result=await api('/api/import',backup);pending.clear();detailPaperId=null;paperData=null;globalLibrary=[];settingsDirty=false;await loadState();renderSettings();toast(result.message);}catch(error){actionError(error);}finally{if($('#settings-import'))$('#settings-import').disabled=false;event.target.value='';}};
  $$('[data-usage-scale]').forEach(button=>button.onclick=()=>{usageScale=button.dataset.usageScale;usagePage=0;$$('[data-usage-scale]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));loadConnectionUsage();});
  $('#usage-date').onchange=e=>{if(e.target.value){usageDate=e.target.value;usagePage=0;loadConnectionUsage();}};
  const shiftPeriod=direction=>{
    const d=new Date(usageDate+'T12:00:00Z');
    if(usageScale==='month'){d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+direction);}else d.setUTCDate(d.getUTCDate()+direction*(usageScale==='week'?7:1));
    usageDate=d.toISOString().slice(0,10);$('#usage-date').value=usageDate;usagePage=0;loadConnectionUsage();
  };
  $('#usage-period-prev').onclick=()=>shiftPeriod(-1);$('#usage-period-next').onclick=()=>shiftPeriod(1);
  $('#usage-today').onclick=()=>{usageDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('#usage-date').value=usageDate;usagePage=0;loadConnectionUsage();};
  $('#usage-prev').onclick=()=>{usagePage--;loadConnectionUsage();};$('#usage-next').onclick=()=>{usagePage++;loadConnectionUsage();};
  resizeObserver?.disconnect();resizeObserver=new ResizeObserver(()=>loadConnectionUsage());resizeObserver.observe($('#connection-usage'));
  selectTab(settingsTab);updateDirty();
}
async function loadConnectionUsage(){
  const target=$('#connection-usage');if(!target)return;
  const request=++usageRequest;
  try{
    const data=await api('/api/usage?'+new URLSearchParams({scale:usageScale,date:usageDate}));if(!target.isConnected||request!==usageRequest)return;
    const models=data.models||[];
    const limit=Math.max(1,Math.floor((target.clientHeight-42)/57)),pages=Math.max(1,Math.ceil(models.length/limit));usagePage=Math.max(0,Math.min(usagePage,pages-1));
    const fee=row=>{const costs=Object.entries(row.costs_by_currency||{}).map(([currency,value])=>(currency==='CNY'?'¥':'$')+Number(value).toFixed(6)).join(' + ');return (costs||(!row.calls?'$0.000000':'暂不可计价'))+(row.unpriced_calls?' · '+row.unpriced_calls+' 次未计入':'');};
    const totals=data.totals||{};
    $('#usage-total').innerHTML='<span>总 Token <strong>'+number(totals.total_tokens||0)+'</strong>'+(totals.unknown_usage_calls?' <small>另 '+totals.unknown_usage_calls+' 次未返回用量</small>':'')+'</span><span>合计费用 <strong>'+fee(totals)+'</strong></span>';
    target.innerHTML='<table class="connection-usage-table"><thead><tr><th>调用次数</th><th>调用模型</th><th>总 Token</th><th>费用估计</th></tr></thead><tbody>'+models.slice(usagePage*limit,(usagePage+1)*limit).map(row=>'<tr><td><span>'+number(row.calls)+'</span></td><td title="'+esc(row.model)+'"><span>'+esc(row.model)+'</span></td><td title="'+esc(number(row.total_tokens)+(row.unknown_tokens?'（另 '+row.unknown_tokens+' 次未返回）':''))+'"><span>'+number(row.total_tokens)+(row.unknown_tokens?'（另 '+row.unknown_tokens+' 次未返回）':'')+'</span></td><td title="'+esc(fee(row)+'\n'+[...(row.pricing_notes||[]),...(row.sources||[])].join('\n'))+'"><span>'+fee(row)+'</span></td></tr>').join('')+'</tbody></table>'+(models.length?'':'<p class="subtle usage-empty">该日期范围暂无调用</p>');
    $('#usage-period').textContent=data.period?(data.period.start===data.period.end?data.period.start:data.period.start+' 至 '+data.period.end)+' · 北京时间':'';
    $('#usage-page').textContent=(usagePage+1)+' / '+pages;$('#usage-prev').disabled=usagePage===0;$('#usage-next').disabled=usagePage===pages-1;
  }catch(error){if(target.isConnected&&request===usageRequest)target.textContent='用量读取失败：'+error.message;}
}
async function exportBackup() {
  try {
    const backup = await api('/api/export'), link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));
    link.download = 'research-map-' + new Date().toISOString().slice(0,10) + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href),10000); toast('备份已导出');
  } catch(e) { actionError(e); }
}
$('#close-modal').onclick = closeModal;
$('#modal').onclick = e => { if (e.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (e.clientX < r.x || e.clientX > r.right || e.clientY < r.y || e.clientY > r.bottom) closeModal(); } };
$('#modal').addEventListener('cancel', e => {e.preventDefault();closeModal();});
$('#export').onclick = exportBackup;
TaskCenter.mount({api,updated:loadState,error:actionError});
$$('[data-view]').forEach(b => b.onclick = () => {
  if (editing) { toast('请先按 Enter 保存，或 Esc 取消当前编辑'); return; }
  const section=view==='node'?'map':view;
  sectionRoutes[section]=activeRoute;
  location.hash = sectionRoutes[b.dataset.view]||'#'+b.dataset.view;
});
window.addEventListener('hashchange',route);
window.addEventListener('beforeunload',event=>{if(settingsDirty){event.preventDefault();event.returnValue='';}});
window.addEventListener('resize', () => { if (view === 'node') renderCollection(false); });
document.fonts?.ready.then(()=>{if(view==='map'&&state){drawMap();fitMap();}else if(view==='node'&&state){renderNode();}});
route(); setInterval(poll,2500);
