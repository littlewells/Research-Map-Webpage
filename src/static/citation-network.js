(function(scope){
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe=s=>/^https?:[/][/]/i.test(s||'')?esc(s):'#',cameras=new Map();
  function layout(papers){
    const n=papers.length,cols=Math.max(1,Math.ceil(Math.sqrt(n))),positions=new Map();
    const ctx=document.createElement('canvas').getContext('2d');ctx.font='600 15px "Segoe UI", "Microsoft YaHei", sans-serif';
    const entries=[...papers].sort((a,b)=>(a.year||9999)-(b.year||9999)||a.title.localeCompare(b.title)).map(paper=>{
      let diameter=180;
      while(true){
        const lines=AtlasCore.textLines(paper.title,diameter*.64,15,text=>ctx.measureText(text).width);
        if(lines.length*19.5<=diameter*.56)break;
        diameter+=16;
      }
      return {paper,r:diameter/2};
    });
    const columnWidths=Array(cols).fill(0),rowHeights=Array(Math.ceil(n/cols)).fill(0);
    entries.forEach((p,i)=>{columnWidths[i%cols]=Math.max(columnWidths[i%cols],p.r*2+90);rowHeights[Math.floor(i/cols)]=Math.max(rowHeights[Math.floor(i/cols)],p.r*2+80);});
    const width=Math.max(780,40+columnWidths.reduce((a,b)=>a+b,0)),height=Math.max(440,40+rowHeights.reduce((a,b)=>a+b,0));
    entries.forEach((p,i)=>positions.set(p.paper.id,{...p,x:20+columnWidths.slice(0,i%cols).reduce((a,b)=>a+b,0)+columnWidths[i%cols]/2,y:20+rowHeights.slice(0,Math.floor(i/cols)).reduce((a,b)=>a+b,0)+rowHeights[Math.floor(i/cols)]/2}));
    return {positions,width,height};
  }
  function fitTitles(canvas){
    canvas.querySelectorAll('.citation-round').forEach(button=>{
      const title=button.querySelector('strong'),small=[...button.querySelectorAll('small')];
      let text=title.querySelector('.citation-title-text');
      if(!text){text=document.createElement('span');text.className='citation-title-text';text.textContent=title.textContent;title.replaceChildren(text);}
      Object.assign(text.style,{display:'block',width:'100%',flex:'none',overflowWrap:'anywhere'});
      Object.assign(button.style,{position:'absolute',padding:'0',display:'block'});
      Object.assign(title.style,{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',height:(button.clientHeight*.56)+'px',width:(button.clientWidth*.64)+'px',display:'flex',alignItems:'center',justifyContent:'center',lineHeight:'1.3',margin:'0'});
      small.forEach((el,index)=>Object.assign(el.style,{position:'absolute',left:'50%',transform:'translateX(-50%)',width:'66%',maxHeight:'22px',overflow:'hidden',margin:'0',top:index===0?'12px':'auto',bottom:index===0?'auto':'12px'}));
      title.style.overflow='hidden';title.style.maxHeight='none';title.style.flex='none';
      title.style.overflowWrap='anywhere';
      title.style.fontSize='15px';small.forEach(el=>el.style.fontSize='9px');
      let diameter=button.clientWidth;
      while(text.scrollWidth>title.clientWidth+1||text.scrollHeight>title.clientHeight+1){
        const delta=16;diameter+=delta;
        button.style.left=(parseFloat(button.style.left)-delta/2)+'px';button.style.top=(parseFloat(button.style.top)-delta/2)+'px';
        button.style.width=diameter+'px';button.style.height=diameter+'px';title.style.width=(diameter*.64)+'px';title.style.height=(diameter*.56)+'px';
      }
    });
  }
  function render({canvas,papers,network,openPaper,nodeId='',api,related=false,onRelated,onExit}){
    const ids=new Set(papers.map(p=>p.id)),edges=(network?.edges||[]).filter(e=>ids.has(e.citing_id)&&ids.has(e.cited_id)),boundary=network?.boundary_edges||[];
    const model=layout(papers),key=nodeId+':'+(related?'related':'local'),old=cameras.get(key);let z=old?.z||1,x=old?.x||0,y=old?.y||0,gesture;
    const routes=edges.map((edge,i)=>{const a=model.positions.get(edge.citing_id),b=model.positions.get(edge.cited_id),dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),path='M'+(a.x+dx/d*(a.r+2))+','+(a.y+dy/d*(a.r+2))+' Q'+((a.x+b.x)/2-dy/d*30)+','+((a.y+b.y)/2+dx/d*30)+' '+(b.x-dx/d*(b.r+2))+','+(b.y-dy/d*(b.r+2));return '<path class="citation-hit" tabindex="0" role="button" data-edge="'+i+'" aria-label="查看引用原文证据" d="'+path+'"/><path class="citation-edge" marker-end="url(#citation-arrow)" d="'+path+'"/>';}).join('');
    const stubs=boundary.map((edge,i)=>{const own=ids.has(edge.citing_id)?edge.citing_id:edge.cited_id,p=model.positions.get(own);if(!p)return '';const endX=p.x+p.r+40,endY=p.y-p.r*.65-(i%3)*12;return '<path class="citation-boundary" d="M'+(p.x+p.r*.8)+','+(p.y-p.r*.6)+' Q'+(p.x+p.r+15)+','+endY+' '+endX+','+endY+'"/><circle class="citation-portal" data-related="true" role="button" tabindex="0" aria-label="展开跨方向引用" cx="'+endX+'" cy="'+endY+'" r="10"/>';}).join('');
    canvas.innerHTML='<div class="citation-network"><div class="network-toolbar"><span>'+papers.length+' 篇 · '+edges.length+' 条有证据的引用'+(boundary.length?' · '+boundary.length+' 条跨方向引用':'')+'</span>'+(related?'<button id="exit-related">退出关联总览</button>':'<button id="show-related">缩放到关联总览</button>')+'<button data-network="out" aria-label="缩小引用网络">−</button><button data-network="in" aria-label="放大引用网络">＋</button><button data-network="fit">适配</button></div><div class="network-viewport" aria-label="圆形论文引用网络，可拖动缩放"><div class="network-stage"><svg class="network-links" width="'+model.width+'" height="'+model.height+'"><defs><marker id="citation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z"/></marker></defs>'+routes+stubs+'</svg>'+[...model.positions.values()].map(p=>'<button class="citation-node citation-round '+(p.paper.local===false?'external-paper':'')+'" data-network-paper="'+esc(p.paper.id)+'" title="'+esc(p.paper.title)+'" style="left:'+(p.x-p.r)+'px;top:'+(p.y-p.r)+'px;width:'+(p.r*2)+'px;height:'+(p.r*2)+'px"><small>'+esc(p.paper.year||'年份未知')+'</small><strong>'+esc(p.paper.title)+'</strong>'+(related?'<small>'+esc((p.paper.directions||[]).map(n=>n.name).join(' · '))+'</small>':'')+'</button>').join('')+'</div></div><div class="network-evidence"><strong>'+(related?'跨方向关联总览':'当前方向引用网络')+'</strong><p>箭头：引用方 → 被引用方。依据上传论文参考文献原文，与已收录论文的标识或完整题录严格匹配；不按相似度推断。</p>'+(boundary.length?'<p>伸向空白的虚线表示已确认的跨方向引用。点击端点或“缩放到关联总览”展开所有关联论文。</p>':'')+(!edges.length?'<p>当前没有确认的库内引用关系；无连线不代表不存在引用。</p>':'')+'<div class="network-edge-list">'+edges.map((e,i)=>'<button data-edge="'+i+'">'+esc(papers.find(p=>p.id===e.citing_id).title)+' → '+esc(papers.find(p=>p.id===e.cited_id).title)+'</button>').join('')+'</div></div></div>';
    const stage=canvas.querySelector('.network-stage'),viewport=canvas.querySelector('.network-viewport'),evidence=canvas.querySelector('.network-evidence');
    const apply=()=>{stage.style.transform='translate('+x+'px,'+y+'px) scale('+z+')';cameras.set(key,{x,y,z});};
    const fit=()=>{z=Math.max(.1,Math.min(1,(viewport.clientWidth-20)/model.width,(viewport.clientHeight-20)/model.height));x=(viewport.clientWidth-model.width*z)/2;y=(viewport.clientHeight-model.height*z)/2;apply();};
    const zoom=(factor,cx=viewport.clientWidth/2,cy=viewport.clientHeight/2)=>{const next=Math.max(.1,Math.min(3,z*factor));x=cx-(cx-x)*next/z;y=cy-(cy-y)*next/z;z=next;apply();};
    canvas.querySelector('[data-network="fit"]').onclick=fit;canvas.querySelector('[data-network="in"]').onclick=()=>zoom(1.2);canvas.querySelector('[data-network="out"]').onclick=()=>zoom(1/1.2);
    viewport.onwheel=e=>{e.preventDefault();const r=viewport.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.x,e.clientY-r.y);};
    viewport.onpointerdown=e=>{if(e.button!==0||e.target.closest('button,[data-edge],[data-related]'))return;gesture={sx:e.clientX,sy:e.clientY,x,y};viewport.setPointerCapture(e.pointerId);};
    viewport.onpointermove=e=>{if(gesture){x=gesture.x+e.clientX-gesture.sx;y=gesture.y+e.clientY-gesture.sy;apply();}};viewport.onpointerup=viewport.onpointercancel=()=>{gesture=null;};
    canvas.querySelectorAll('[data-network-paper]').forEach(b=>b.onclick=()=>openPaper(papers.find(p=>p.id===b.dataset.networkPaper)));
    canvas.querySelectorAll('[data-edge]').forEach(b=>{b.onclick=()=>{const edge=edges[Number(b.dataset.edge)];evidence.innerHTML='<strong>'+esc(papers.find(p=>p.id===edge.citing_id).title)+' → '+esc(papers.find(p=>p.id===edge.cited_id).title)+'</strong><p>'+esc(new Date(edge.checked_at).toLocaleString('zh-CN'))+'</p>'+edge.evidence.map(e=>'<section><strong>'+esc(e.source)+'</strong>'+(e.page?'<small>第 '+e.page+' 页</small>':'')+'<p>'+esc(e.excerpt)+'</p>'+(e.url?'<a href="'+safe(e.url)+'" target="_blank" rel="noopener noreferrer">来源 ↗</a>':'')+'</section>').join('');};b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();b.onclick();}};});
    if(related)canvas.querySelector('#exit-related').onclick=onExit;
    else{
      const expand=async()=>{try{const graph=await api('/api/citations/graph?node='+encodeURIComponent(nodeId)+'&scope=related');onRelated(graph);}catch(error){evidence.textContent=error.message;}};
      canvas.querySelector('#show-related').onclick=expand;
      canvas.querySelectorAll('[data-related]').forEach(b=>{b.onclick=expand;b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();expand();}};});
    }
    fitTitles(canvas);
    document.fonts?.ready.then(()=>{if(canvas.isConnected)fitTitles(canvas);});
    if(old)apply();else fit();
  }
  scope.CitationNetwork={layout,render,fitTitles};
})(globalThis);
