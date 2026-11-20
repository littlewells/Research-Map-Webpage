(function (scope) {
  'use strict';
  function paperTime(p) {
    const d = String(p.published || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(d) && Number.isFinite(Date.parse(d))) return d.slice(0, 10);
    const year = Number(p.year);
    return Number.isInteger(year) && year >= 1800 && year <= 2200 ? String(year) : '';
  }
  function chronological(papers) {
    return [...papers].sort((a, b) => {
      const x = paperTime(a), y = paperTime(b);
      return (x || '9999').localeCompare(y || '9999') || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));
    });
  }
  function textLines(text,width,size,measure) {
    const paragraphs=String(text).replace(/\r\n?/g,'\n').split('\n');
    if(paragraphs.length>1)return paragraphs.flatMap(line=>textLines(line,width,size,measure));
    const lines=[];let line='';
    for(const token of String(text).split(/(\s+|[\u2e80-\u9fff\uf900-\ufaff])/u).filter(Boolean)){
      if(/^\s+$/.test(token)){if(line&&!line.endsWith(' '))line+=' ';continue;}
      if(line&&measure(line+token,size)>width){lines.push(line.trimEnd());line='';}
      if(measure(token,size)>width){
        for(const char of token){if(line&&measure(line+char,size)>width){lines.push(line.trimEnd());line='';}line+=char;}
      }else line+=token;
    }
    if(line.trim()||!lines.length)lines.push(line.trimEnd());
    return lines;
  }
  function layoutTree(nodes, measure, options = {}) {
    const root = nodes.find(n => !n.parent_id);
    if (!root) return { positions: [], edges: [], width: 0, height: 0 };
    const levels = [], byParent = new Map(), byId = new Map();
    nodes.forEach(n => { const list = byParent.get(n.parent_id) || []; list.push(n); byParent.set(n.parent_id, list); });
    const colors = ['#3d679f', '#557bb7', '#516ba0', '#697fbb', '#406380'];
    const compact=options.compact||false,pad=compact?20:34,gap=compact?48:74,rowGap=compact?8:26;
    const controls=options.branchIds||new Set(nodes.filter(n=>nodes.some(x=>x.parent_id===n.id)).map(n=>n.id));
    let row = pad;
    function visit(n, depth, branch) {
      const fontSize=compact?14:depth?22:26,lineHeight=compact?1.3:depth?1.45:1.35;
      const paddingLeft=compact?(depth?12:15):(depth?18:23),paddingRight=compact?paddingLeft:controls.has(n.id)?(depth?50:62):paddingLeft;
      const lines=String(n.name).replace(/\r\n?/g,'\n').split('\n');
      const width=Math.ceil(Math.max(1,...lines.map(line=>measure(line,fontSize)))+paddingLeft+paddingRight+4);
      const height=Math.ceil(Math.max(compact?(depth?30:58):(depth?56:92),lines.length*fontSize*lineHeight+(compact?6:20)+2));
      levels[depth] = Math.max(levels[depth] || 0, width);
      const kids = byParent.get(n.id) || [];
      const start=row;
      const ys = kids.map((k, i) => visit(k, depth + 1, depth === 0 ? colors[i % colors.length] : branch));
      const span=row-start;
      if(ys.length&&span<height+rowGap){const shift=(height+rowGap-span)/2;for(const p of byId.values())if(p.y>=start)p.y+=shift;row=start+height+rowGap;}
      const center=ys.length?start+(row-start-rowGap)/2:row+height/2;
      const y=center-height/2;
      if (!ys.length) row += height+rowGap;
      const p = { node: n, depth, branch: branch || '#344b6c', width, y, height, fontSize, lineHeight, lines, paddingLeft, paddingRight };
      byId.set(n.id, p);
      return center;
    }
    visit(root, 0, null);
    const xs = [pad];
    for (let d = 1; d < levels.length; d++) xs[d] = xs[d - 1] + levels[d - 1] + gap;
    const positions = [...byId.values()].map(p => ({ ...p, x: xs[p.depth] }));
    const edges = positions.filter(p => p.node.parent_id).map(p => [byId.get(p.node.parent_id), p]);
    positions.forEach(p => { byId.get(p.node.id).x = p.x; });
    return { positions, edges, width: xs.at(-1) + levels.at(-1) + pad, height: Math.max(row-rowGap,...positions.map(p=>p.y+p.height))+pad };
  }
  function visibleTree(nodes,collapsed) {
    const hidden=new Set(),byParent=new Map();
    for(const n of nodes){const a=byParent.get(n.parent_id)||[];a.push(n);byParent.set(n.parent_id,a);}
    function hide(id){for(const child of byParent.get(id)||[]){hidden.add(child.id);hide(child.id);}}
    for(const id of collapsed)hide(id);
    return nodes.filter(n=>!hidden.has(n.id));
  }
  function impactScores(papers) {
    return papers.map(p => {
      const manual=Number.isInteger(p.manual_score)&&p.manual_score>=0&&p.manual_score<=100;
      const known=Number.isInteger(p.ai_score)&&p.ai_score>=0&&p.ai_score<=100;
      const score=manual?p.manual_score:known?p.ai_score:50;
      return {...p,impact:{score,manual,provisional:!manual&&!known,weight:.35+2.65*Math.pow(score/100,2)}};
    }).sort((a,b)=>b.impact.score-a.impact.score||String(a.title).localeCompare(String(b.title)));
  }
  // Tangent placement keeps weighted circles separate, then fits the whole cloud to the canvas.
  function impactLayout(papers, width, height, gap = 10) {
    if (!papers.length || width<=0 || height<=0) return [];
    const placed=[],spacing=.075;
    for(const p of [...papers].sort((a,b)=>b.impact.score-a.impact.score || String(a.id).localeCompare(String(b.id)))) {
      const r=Math.sqrt(p.impact.weight),candidates=[];
      if(!placed.length)candidates.push({x:0,y:0});
      for(const q of placed)for(let angle=0;angle<72;angle++){
        const a=angle*Math.PI/36,d=r+q.r+spacing;
        candidates.push({x:q.x+Math.cos(a)*d,y:q.y+Math.sin(a)*d});
      }
      let best=null,cost=Infinity;
      for(const c of candidates){
        if(placed.some(q=>Math.hypot(c.x-q.x,c.y-q.y)<r+q.r+spacing-.00001))continue;
        const v=Math.hypot(c.x/1.6,c.y)+r*.25;
        if(v<cost){cost=v;best=c;}
      }
      // A far-right tangent is always a valid fallback for numerical edge cases.
      if(!best)best={x:Math.max(...placed.map(q=>q.x+q.r))+r+spacing,y:0};
      placed.push({...p,...best,r});
    }
    const extentX=Math.max(...placed.map(p=>Math.abs(p.x)+p.r)),extentY=Math.max(...placed.map(p=>Math.abs(p.y)+p.r));
    const scale=Math.min(Math.max(1,width-gap*2)/(extentX*2),Math.max(1,height-gap*2)/(extentY*2));
    return placed.map(p=>({...p,x:width/2+(p.x-p.r)*scale,y:height/2+(p.y-p.r)*scale,radius:p.r*scale,width:p.r*scale*2,height:p.r*scale*2}));
  }
  function timelineLayout(papers,width,height) {
    if(!papers.length || width<=0 || height<=0)return [];
    const margin=Math.min(18,width*.02),usable=width-margin*2,step=usable/(papers.length+1);
    const w=Math.min(300,step*1.82),h=Math.min(170,height*.35),amplitude=Math.min(42,height*.105),center=height/2;
    return papers.map((p,i)=>{
      const above=i%2===0,anchorX=margin+step*(i+1),anchorY=center+(above?-amplitude:amplitude),offset=Math.min(13,height*.035);
      return {...p,index:i,x:anchorX-w/2,y:above?anchorY-offset-h:anchorY+offset,width:w,height:h,above,anchorX,anchorY};
    });
  }
  function titleFontSize(title,width,height,preferred,measure,minimum = 12) {
    function linesAt(size) {return textLines(title,width,size,measure).length;}
    let size=preferred;
    while(size>minimum && linesAt(size)*size*1.48>height)size=Math.max(minimum,size-.5);
    return size;
  }
  const api = { paperTime, chronological, layoutTree, visibleTree, impactScores, impactLayout, timelineLayout, titleFontSize, textLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.AtlasCore = api;
})(globalThis);
