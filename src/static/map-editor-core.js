(function(scope){
  'use strict';
  const palette={blue:'#416fa8',indigo:'#5b67ad',slate:'#5d718c',violet:'#7a65a4'};
  const copy=x=>JSON.parse(JSON.stringify(x));
  const uid=()=> 'm'+globalThis.crypto.randomUUID().replaceAll('-','');
  const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // The root stores the two document-wide values, so alignment participates in save/undo.
  function alignment(doc){const root=doc.nodes.find(n=>!n.parent_id)||{};return {title:root.text_align||'center',remark:root.remark_align||'left'};}
  function textStyle(doc,node,depth=1){
    const global=doc.nodes.find(n=>!n.parent_id)?.global_typography||{},local=node.typography||{},values={...global,...local};
    const part=(key,size)=>{const fontSize=values[key+'_size']??size,thickness=values[key+'_thickness']??0;return {size:fontSize,weight:values[key+'_bold']?700:key==='title'?500:400,thickness,strokeWidth:fontSize*thickness*.0006,italic:values[key+'_italic']??false,underline:values[key+'_underline']??false};};
    return {title:part('title',depth?22:26),remark:part('remark',14)};
  }
  function vectorText(lines,width,height,{size=15,lineHeight=22,padding=12,align='left',y,className='',weight=500,italic=false,underline=false,strokeWidth=0}={}){
    const x=align==='left'?padding:align==='right'?width-padding:width/2,anchor={left:'start',center:'middle',right:'end'}[align]||'middle';
    const top=y??(height-lines.length*lineHeight)/2;
    return '<text class="'+className+'" x="'+x+'" text-anchor="'+anchor+'" dominant-baseline="central" font-size="'+size+'" stroke="currentColor" stroke-width="'+strokeWidth+'" stroke-linejoin="round" paint-order="stroke fill" style="font-size:'+size+'px;font-weight:'+weight+';font-style:'+(italic?'italic':'normal')+';text-decoration:'+(underline?'underline':'none')+'">'+lines.map((line,i)=>'<tspan x="'+x+'" y="'+(top+(i+.5)*lineHeight)+'">'+escapeText(line)+'</tspan>').join('')+'</text>';
  }
  function nodeVector(p,align){
    const titleHeight=p.lines.length*p.fontSize*p.lineHeight,remarkHeight=p.remarkLines.length*p.remarkLineHeight,gap=remarkHeight?8:0,top=(p.height-titleHeight-remarkHeight-gap)/2;
    return '<svg class="map-node-vector" viewBox="0 0 '+p.width+' '+p.height+'" aria-hidden="true" focusable="false">'+vectorText(p.lines,p.width,p.height,{...p.typography.title,lineHeight:p.fontSize*p.lineHeight,padding:p.paddingLeft+2,align:align.title,y:top,className:'map-node-title'})+(remarkHeight?vectorText(p.remarkLines,p.width,p.height,{...p.typography.remark,lineHeight:p.remarkLineHeight,padding:p.paddingLeft+2,align:align.remark,y:top+titleHeight+gap,className:'map-node-remark'}):'')+'</svg>';
  }
  function descendants(nodes,id){const found=new Set([id]);let changed=true;while(changed){changed=false;for(const n of nodes)if(found.has(n.parent_id)&&!found.has(n.id)){found.add(n.id);changed=true;}}return found;}
  function roots(nodes,ids){const selected=new Set(ids);return nodes.filter(n=>selected.has(n.id)&&!nodes.some(p=>selected.has(p.id)&&p.id!==n.id&&descendants(nodes,p.id).has(n.id))).map(n=>n.id);}
  function cleanAnnotations(doc){
    const byId=new Map(doc.nodes.map(n=>[n.id,n]));
    doc.annotations=doc.annotations.filter(a=>{
      if(a.type==='relation')return a.from!==a.to&&byId.has(a.from)&&byId.has(a.to);
      a.members=a.members.filter(id=>byId.has(id));
      if(a.members.length<2)return false;
      const parent=byId.get(a.members[0]).parent_id;
      if(!parent||a.members.some(id=>byId.get(id).parent_id!==parent))return false;
      const siblings=doc.nodes.filter(n=>n.parent_id===parent).map(n=>n.id),indices=a.members.map(id=>siblings.indexOf(id)).sort((a,b)=>a-b);
      return indices.at(-1)-indices[0]+1===indices.length;
    });return doc;
  }
  function move(doc,ids,targetId,mode='inside'){
    const result=copy(doc),selected=roots(result.nodes,ids),target=result.nodes.find(n=>n.id===targetId);
    if(!target||!selected.length)throw Error('请选择要移动的节点与目标方向');
    const moving=new Set();for(const id of selected){const n=result.nodes.find(n=>n.id===id);if(!n?.parent_id)throw Error('根节点不能移动');for(const d of descendants(result.nodes,id))moving.add(d);}
    if(moving.has(targetId))throw Error('不能将方向移动到自身或后代中');
    const parent=mode==='inside'?targetId:target.parent_id;
    if(!parent)throw Error('根节点不能插入同级方向');
    const blocks=selected.flatMap(id=>result.nodes.filter(n=>descendants(result.nodes,id).has(n.id)));
    result.nodes=result.nodes.filter(n=>!moving.has(n.id));
    for(const n of blocks)if(selected.includes(n.id))n.parent_id=parent;
    let index;
    if(mode==='before')index=result.nodes.findIndex(n=>n.id===targetId);
    else if(mode==='after')index=result.nodes.findIndex(n=>n.id===targetId)+1;
    else {const siblings=result.nodes.filter(n=>n.parent_id===parent);index=siblings.length?result.nodes.findIndex(n=>n.id===siblings.at(-1).id)+1:result.nodes.length;}
    result.nodes.splice(index,0,...blocks);return cleanAnnotations(result);
  }
  function duplicate(doc,ids,parentId,newId=uid){
    const selected=roots(doc.nodes,ids),include=new Set();for(const id of selected)for(const x of descendants(doc.nodes,id))include.add(x);
    const mapping=new Map([...include].map(id=>[id,newId()]));
    const nodes=doc.nodes.filter(n=>include.has(n.id)).map(n=>({...copy(n),id:mapping.get(n.id),parent_id:selected.includes(n.id)?parentId:mapping.get(n.parent_id)}));
    const annotations=doc.annotations.filter(a=>a.type==='relation'?include.has(a.from)&&include.has(a.to):a.members.every(id=>include.has(id))).map(a=>{
      const next={...copy(a),id:newId()};if(a.type==='relation'){next.from=mapping.get(a.from);next.to=mapping.get(a.to);}else next.members=a.members.map(id=>mapping.get(id));return next;
    });return {nodes,annotations,selected:selected.map(id=>mapping.get(id))};
  }
  function siblingRange(nodes,ids){
    const chosen=nodes.filter(n=>ids.includes(n.id));if(chosen.length<2)throw Error('请按住 Ctrl 选择至少两个连续的同级方向');
    const parent=chosen[0].parent_id;if(!parent||chosen.some(n=>n.parent_id!==parent))throw Error('概要和分组需要连续的同级方向');
    const siblings=nodes.filter(n=>n.parent_id===parent),indices=chosen.map(n=>siblings.findIndex(s=>s.id===n.id)).sort((a,b)=>a-b);
    if(indices.at(-1)-indices[0]+1!==indices.length)throw Error('请选取连续的同级方向');return indices.map(i=>siblings[i].id);
  }
  function manualLines(text){return String(text??'').replace(/\r\n?/g,'\n').split('\n');}
  function textLines(text,width,size,measure){
    const paragraphs=String(text).replace(/\r\n?/g,'\n').split('\n');
    if(paragraphs.length>1)return paragraphs.flatMap(line=>textLines(line,width,size,measure));
    const lines=[];let line='';
    for(const token of String(text).split(/(\s+|[\u2e80-\u9fff\uf900-\ufaff])/u).filter(Boolean)){
      if(/^\s+$/.test(token)){if(line&&!line.endsWith(' '))line+=' ';continue;}
      if(line&&measure(line+token,size)>width){lines.push(line.trimEnd());line='';}
      for(const char of token){if(line&&measure(line+char,size)>width){lines.push(line.trimEnd());line='';}line+=char;}
    }if(line.trim()||!lines.length)lines.push(line.trimEnd());return lines;
  }
  function layout(doc,collapsed,measure){
    const byParent=new Map(),all=new Map(doc.nodes.map(n=>[n.id,n]));
    for(const n of doc.nodes){const list=byParent.get(n.parent_id)||[];list.push(n);byParent.set(n.parent_id,list);}
    const root=doc.nodes.find(n=>!n.parent_id);if(!root)return {positions:[],edges:[],annotations:[],width:1,height:1};
    const metrics=new Map(),levels=[],spans=new Map(),gap=102,pad=68,rowGap=54;
    function size(n,depth,branch){
      const typography=textStyle(doc,n,depth),fontSize=typography.title.size,lineHeight=depth?1.45:1.35,remarkSize=typography.remark.size,remarkLineHeight=remarkSize*1.5;
      const titleMeasure=(s,size)=>measure(s,size,typography.title),remarkMeasure=(s,size)=>measure(s,size,typography.remark);
      const left=(depth?17:21)+Math.max(typography.title.strokeWidth,typography.remark.strokeWidth)/2,right=left;
      const title=(n.icon?n.icon+' ':'')+n.name;
      const lines=manualLines(title),remarkLines=n.remark?manualLines(n.remark):[];
      const width=Math.ceil(Math.max(...lines.map(line=>titleMeasure(line,fontSize)),...remarkLines.map(line=>remarkMeasure(line,remarkSize)),1)+left+right+4);
      const height=Math.ceil(lines.length*fontSize*lineHeight+remarkLines.length*remarkLineHeight+(remarkLines.length?8:0)+24);
      const inherited=palette[n.color]||branch||palette.blue;
      const p={node:n,depth,branch:inherited,width,height,fontSize,lineHeight,typography,remarkLineHeight,lines,remarkLines,paddingLeft:left,paddingRight:right};metrics.set(n.id,p);levels[depth]=Math.max(levels[depth]||0,width);
      const kids=collapsed.has(n.id)?[]:byParent.get(n.id)||[];
      kids.forEach((k,i)=>size(k,depth+1,depth===0?palette[Object.keys(palette)[i%4]]:inherited));
      spans.set(n.id,Math.max(height,kids.reduce((sum,k)=>sum+spans.get(k.id),0)+Math.max(0,kids.length-1)*rowGap));
    }size(root,0,null);
    const xs=[pad];for(let d=1;d<levels.length;d++)xs[d]=xs[d-1]+levels[d-1]+gap;
    const positions=[];
    function place(n,top){const p=metrics.get(n.id);p.x=xs[p.depth];p.y=top+(spans.get(n.id)-p.height)/2;positions.push(p);let y=top;for(const child of collapsed.has(n.id)?[]:byParent.get(n.id)||[]){place(child,y);y+=spans.get(child.id)+rowGap;}}
    place(root,pad);
    const lookup=new Map(positions.map(p=>[p.node.id,p])),edges=positions.filter(p=>p.node.parent_id).map(p=>[lookup.get(p.node.parent_id),p]);
    const allRight=Math.max(...positions.map(p=>p.x+p.width));let width=allRight+pad,height=spans.get(root.id)+pad*2;
    const annotations=[];
    for(const a of doc.annotations){
      if(a.type==='relation'){
        const from=lookup.get(a.from),to=lookup.get(a.to);if(!from||!to)continue;
        const sx=from.x+from.width/2,sy=from.y+from.height/2,tx=to.x+to.width/2,ty=to.y+to.height/2;
        const dx=tx-sx,dy=ty-sy,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len;
        const trim=(p)=>Math.min(Math.abs(dx)<.01?Infinity:p.width/2/Math.abs(dx/len),Math.abs(dy)<.01?Infinity:p.height/2/Math.abs(dy/len))+8;
        const d1=trim(from),d2=trim(to),x1=sx+dx/len*d1,y1=sy+dy/len*d1,x2=tx-dx/len*d2,y2=ty-dy/len*d2;
        const mx=(x1+x2)/2+nx*a.curve,my=(y1+y2)/2+ny*a.curve;
        const labelLines=textLines(a.label||'联系',250,14,measure),labelWidth=Math.max(54,...labelLines.map(s=>measure(s,14)))+22,labelHeight=labelLines.length*20+14;
        const lx=(x1+2*mx+x2)/4,ly=(y1+2*my+y2)/4;
        annotations.push({...a,x1,y1,x2,y2,mx,my,lx,ly,nx,ny,labelLines,labelWidth,labelHeight,colorValue:palette[a.color]});
        width=Math.max(width,mx+pad,lx+labelWidth/2+pad);height=Math.max(height,my+pad,ly+labelHeight+pad);
      }else{
        if(!a.members.every(id=>lookup.has(id)))continue;
        const memberSet=new Set();for(const id of a.members)for(const child of descendants(doc.nodes,id))memberSet.add(child);
        const ps=positions.filter(p=>memberSet.has(p.node.id));
        const nested=a.type==='boundary'?doc.annotations.filter(b=>b.id!==a.id&&b.type==='boundary'&&b.members.every(id=>memberSet.has(id))&&b.members.length<a.members.length).length:0;
        const extra=nested*26;
        const x=Math.min(...ps.map(p=>p.x))-20-extra,y=Math.min(...ps.map(p=>p.y))-26-extra,right=Math.max(...ps.map(p=>p.x+p.width))+20+extra,bottom=Math.max(...ps.map(p=>p.y+p.height))+22+extra;
        const labelLines=textLines(a.label||(a.type==='summary'?'概要':'分组'),194,15,measure),labelHeight=labelLines.length*22+14;
        const same=annotations.filter(k=>k.type===a.type&&k.y<bottom&&k.bottom>y).length;
        const labelX=a.type==='summary'?allRight+54+same*245:x+14,labelY=a.type==='summary'?(y+bottom-labelHeight)/2:y-labelHeight/2;
        annotations.push({...a,x,y,right,bottom,labelX,labelY,labelLines,labelHeight,colorValue:palette[a.color]});
        width=Math.max(width,labelX+235+pad);height=Math.max(height,bottom+pad);
      }
    }
    // Offset the entire drawing when relation handles extend past its top/left edge.
    const minY=Math.min(0,...annotations.map(a=>(a.type==='relation'?Math.min(a.my,a.ly-a.labelHeight):Math.min(a.y,a.labelY))-24));
    const minX=Math.min(0,...annotations.map(a=>(a.type==='relation'?Math.min(a.mx,a.lx-a.labelWidth/2):Math.min(a.x,a.labelX))-24));
    if(minY<0||minX<0){
      for(const p of positions){p.x-=minX;p.y-=minY;}
      for(const a of annotations){if(a.type==='relation'){for(const key of ['x1','x2','mx','lx'])a[key]-=minX;for(const key of ['y1','y2','my','ly'])a[key]-=minY;}else{for(const key of ['x','right','labelX'])a[key]-=minX;for(const key of ['y','bottom','labelY'])a[key]-=minY;}}
      width-=minX;height-=minY;
    }
    return {positions,edges,annotations,width,height};
  }
  const api={palette,copy,uid,alignment,textStyle,vectorText,nodeVector,descendants,roots,cleanAnnotations,move,duplicate,siblingRange,manualLines,textLines,layout};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.MapEditorCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
