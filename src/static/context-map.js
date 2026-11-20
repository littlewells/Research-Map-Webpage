(function(scope){
  'use strict';
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function branch(nodes,id){
    const selected=nodes.find(n=>n.id===id);if(!selected)return [];
    const parent=selected.parent_id||selected.id,ids=new Set([parent]);
    let changed=true;while(changed){changed=false;for(const n of nodes)if(ids.has(n.parent_id)&&!ids.has(n.id)){ids.add(n.id);changed=true;}}
    return nodes.filter(n=>ids.has(n.id)).map(n=>({...n,parent_id:n.id===parent?null:n.parent_id}));
  }
  function layout(nodes,measure,document={nodes}){
    const root=nodes.find(n=>!n.parent_id);if(!root)return {positions:[],width:1,height:1};
    const levels=[],positions=[],byParent=new Map(),spans=new Map(),metrics=new Map();
    for(const n of nodes){const list=byParent.get(n.parent_id)||[];list.push(n);byParent.set(n.parent_id,list);}
    const linesOf=scope.MapEditorCore?.manualLines||(text=>String(text).replace(/\r\n?/g,'\n').split('\n'));
    function size(n,depth){
      const original=document.nodes.find(x=>x.id===n.id)||n,titleStyle=scope.MapEditorCore?.textStyle(document,original,original.parent_id?1:0).title||{size:depth?22:26,weight:500};
      const fontSize=titleStyle.size*(original.parent_id?18/22:19/26),lineHeight=fontSize*1.45,strokeWidth=(titleStyle.strokeWidth||0)*fontSize/titleStyle.size,padding=16+strokeWidth/2;
      const textMeasure=(s,f)=>measure(s,f,titleStyle);
      const lines=linesOf(n.name);
      const width=Math.ceil(Math.max(1,...lines.map(s=>textMeasure(s,fontSize)))+padding*2+2),height=lines.length*lineHeight+22;
      const p={node:n,depth,fontSize,lineHeight,titleStyle,strokeWidth,padding,lines,width,height};metrics.set(n.id,p);levels[depth]=Math.max(levels[depth]||0,width);
      const kids=byParent.get(n.id)||[];kids.forEach(k=>size(k,depth+1));
      spans.set(n.id,Math.max(height,kids.reduce((s,k)=>s+spans.get(k.id),0)+Math.max(0,kids.length-1)*18));
    }size(root,0);
    const xs=[22];for(let i=1;i<levels.length;i++)xs[i]=xs[i-1]+levels[i-1]+48;
    function place(n,top){const p=metrics.get(n.id);p.x=xs[p.depth];p.y=top+(spans.get(n.id)-p.height)/2;positions.push(p);let y=top;for(const k of byParent.get(n.id)||[]){place(k,y);y+=spans.get(k.id)+18;}}place(root,22);
    return {positions,width:xs.at(-1)+levels.at(-1)+22,height:spans.get(root.id)+44};
  }
  function svg(model,{selected,trail=new Set(),overview=false,lens=false,alignment={title:'center'}}={}){
    const byId=new Map(model.positions.map(p=>[p.node.id,p]));
    let html='<svg class="context-vector" viewBox="0 0 '+model.width+' '+model.height+'" preserveAspectRatio="xMidYMid meet" '+(lens?'aria-hidden="true"':'role="group" aria-label="'+(overview?'全局研究地图':'当前父分支的完整内容')+'"')+'>';
    for(const p of model.positions){const q=byId.get(p.node.parent_id);if(!q)continue;const x=q.x+q.width,y=q.y+q.height/2,ey=p.y+p.height/2;html+='<path class="context-edge '+(trail.has(p.node.id)?'in-path':'')+'" d="M'+x+' '+y+' C'+(x+24)+' '+y+' '+(p.x-24)+' '+ey+' '+p.x+' '+ey+'"/>';}
    for(const p of model.positions){const n=p.node,current=n.id===selected,x=alignment.title==='left'?p.padding:alignment.title==='right'?p.width-p.padding:p.width/2,anchor={left:'start',center:'middle',right:'end'}[alignment.title]||'middle';html+='<g class="context-topic '+(!p.depth?'context-root ':'')+(trail.has(n.id)?'in-path ':'')+(current?'current':'')+'" '+(lens?'':'data-context-id="'+esc(n.id)+'" role="button" tabindex="0" aria-label="'+esc(n.name)+'" '+(current?'aria-current="location"':''))+' transform="translate('+p.x+' '+p.y+')"><rect width="'+p.width+'" height="'+p.height+'" rx="10"/><text class="context-title" x="'+x+'" y="'+(p.height-(p.lines.length-1)*p.lineHeight)/2+'" text-anchor="'+anchor+'" dominant-baseline="central" stroke="currentColor" stroke-width="'+p.strokeWidth+'" stroke-linejoin="round" paint-order="stroke fill" font-size="'+p.fontSize+'" style="font-size:'+p.fontSize+'px;font-weight:'+p.titleStyle.weight+';font-style:'+(p.titleStyle.italic?'italic':'normal')+';text-decoration:'+(p.titleStyle.underline?'underline':'none')+'">'+p.lines.map((line,i)=>'<tspan x="'+x+'" dy="'+(i?p.lineHeight:0)+'">'+esc(line)+'</tspan>').join('')+'</text></g>';}
    return html+'</svg>';
  }
  function pointer(model,rect,x,y,zoom=1.12,diameter=216){
    const scale=Math.min(rect.width/model.width,rect.height/model.height);
    const left=(rect.width-model.width*scale)/2,top=(rect.height-model.height*scale)/2;
    const px=Math.max(0,Math.min(model.width,(x-rect.left-left)/scale)),py=Math.max(0,Math.min(model.height,(y-rect.top-top)/scale));
    return {x:px-diameter/(2*zoom),y:py-diameter/(2*zoom),width:diameter/zoom,height:diameter/zoom};
  }
  function wheelZoom(zoom,delta,mode=0){
    const pixels=delta*(mode===1?16:mode===2?216:1);
    return Math.max(.5,Math.min(4,zoom*Math.exp(-Math.max(-240,Math.min(240,pixels))*.0025)));
  }
  function tether(start,boxes,width,endY){
    const right=Math.max(start.x,...boxes.map(b=>b.x+b.width)),lane=Math.min(width-5,right+12),radius=Math.min(10,Math.max(0,(lane-start.x)/2),Math.max(0,(endY-start.y)/2));
    const obstacles=boxes.map(b=>({left:b.x-2,right:b.x+b.width+2,top:b.y-2,bottom:b.y+b.height+2}));
    const blocked=(a,b)=>obstacles.some(r=>a.x===b.x
      ?a.x>r.left&&a.x<r.right&&Math.max(a.y,b.y)>r.top+.01&&Math.min(a.y,b.y)<r.bottom-.01
      :a.y>r.top&&a.y<r.bottom&&Math.max(a.x,b.x)>r.left+.01&&Math.min(a.x,b.x)<r.right-.01);
    const lead={x:start.x+4,y:start.y},end={x:lane,y:endY};
    if(!blocked(lead,{x:lane,y:start.y})&&!blocked({x:lane,y:start.y},end))
      return {...start,path:'M'+start.x+','+start.y+' H'+(lane-radius)+' Q'+lane+','+start.y+' '+lane+','+(start.y+radius)+' V'+endY};
    // Orthogonal visibility grid routes intermediate nodes around their children too.
    const xs=[...new Set([lead.x,lane,...obstacles.flatMap(r=>[r.left,r.right])])].sort((a,b)=>a-b);
    const ys=[...new Set([start.y,endY,...obstacles.flatMap(r=>[r.top,r.bottom])])].sort((a,b)=>a-b);
    const nx=xs.length,key=(x,y)=>y*nx+x,source=key(xs.indexOf(lead.x),ys.indexOf(start.y)),target=key(xs.indexOf(lane),ys.indexOf(endY));
    const point=id=>({x:xs[id%nx],y:ys[Math.floor(id/nx)]}),previous=new Map(),cost=new Map([[source,0]]),open=[source],visited=new Set();
    while(open.length){
      let best=0;
      for(let i=1;i<open.length;i++){const a=point(open[i]),b=point(open[best]);if(cost.get(open[i])+Math.abs(a.x-end.x)+Math.abs(a.y-end.y)<cost.get(open[best])+Math.abs(b.x-end.x)+Math.abs(b.y-end.y))best=i;}
      const id=open.splice(best,1)[0];if(visited.has(id))continue;if(id===target)break;visited.add(id);
      const x=id%nx,y=Math.floor(id/nx),a=point(id);
      for(const [dx,dy] of [[1,0],[0,1],[0,-1],[-1,0]]){
        const xx=x+dx,yy=y+dy;if(xx<0||xx>=nx||yy<0||yy>=ys.length)continue;
        const next=key(xx,yy),b=point(next);if(visited.has(next)||blocked(a,b))continue;
        const value=cost.get(id)+Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
        if(value<(cost.get(next)??Infinity)){cost.set(next,value);previous.set(next,id);open.push(next);}
      }
    }
    if(!cost.has(target))return {...start,path:''};
    const points=[];let id=target;while(id!==undefined){points.unshift(point(id));id=previous.get(id);}points.unshift(start);
    const compact=points.filter((p,i)=>!i||i===points.length-1||!((points[i-1].x===p.x&&p.x===points[i+1].x)||(points[i-1].y===p.y&&p.y===points[i+1].y)));
    return {...start,path:compact.map((p,i)=>(i?'L':'M')+p.x+','+p.y).join(' ')};
  }
  const api={branch,layout,svg,pointer,wheelZoom,tether};if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.ContextAtlas=api;
})(globalThis);
