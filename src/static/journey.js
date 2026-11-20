(function (scope) {
  'use strict';
  let cancelFlight = null;
  const easing = t => 1 - Math.pow(1 - t, 3);
  async function zoomFallback(render,{entering=true,origin}={}) {
    cancelFlight?.();
    render();
    const view=document.querySelector('#view');
    if(!view?.animate)return;
    const r=view.getBoundingClientRect();
    const center=origin?((origin.x+origin.width/2-r.x)+'px '+(origin.y+origin.height/2-r.y)+'px'):'50% 35%';
    const animation=view.animate([
      {opacity:.15,transform:'scale('+(entering?.82:1.2)+')',transformOrigin:center},
      {opacity:1,transform:'scale(1)',transformOrigin:center}
    ],{duration:420,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
    let stopped=false;
    const cleanup=()=>{
      if(stopped)return;stopped=true;
      animation.finished.catch(()=>{});animation.cancel();
      document.body.classList.remove('travelling');
      if(cancelFlight===cleanup)cancelFlight=null;
    };
    cancelFlight=cleanup;document.body.classList.add('travelling');
    try {await animation.finished;} catch {} finally {cleanup();}
  }
  function diagramSnapshot() {
    const elements = [...document.querySelectorAll('#view [data-map-id], #view [data-context-id]')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
    return new Map(elements.map(el => {
      const id = el.dataset.mapId || el.dataset.contextId, rect = el.getBoundingClientRect();
      const text = el.querySelector('.map-node-title') || el.querySelector('.node-label') || el.querySelector('.context-title') || el;
      const shape=el.querySelector('rect'), svg=el.ownerSVGElement, local=shape?Number(shape.getAttribute('width')):el.offsetWidth;
      const textStyle=getComputedStyle(text), shapeStyle=getComputedStyle(shape||el);
      const style = getComputedStyle(el), font = getComputedStyle(text), scale = rect.width / (local || rect.width);
      const lines=[...text.querySelectorAll('tspan')];
      const name=lines.length?lines.map(t=>t.textContent).join('\n'):(text.innerText || text.textContent);
      return [id, { id, name, x:rect.x, y:rect.y, width:rect.width, height:rect.height,
        fontSize:parseFloat(font.fontSize) * scale, fontFamily:font.fontFamily, fontWeight:font.fontWeight, fontStyle:font.fontStyle, textDecoration:font.textDecorationLine, strokeWidth:(parseFloat(font.strokeWidth)||0)*scale,
        color:svg?textStyle.fill:font.color, background:svg?shapeStyle.fill:style.backgroundColor, borderColor:svg?shapeStyle.stroke:style.borderColor,
        radius:(parseFloat(style.borderRadius)||10) * scale, padding:Math.max(4,(parseFloat(font.paddingLeft)||12) * scale) }];
    }));
  }
  function frameStyle(p) {
    return {left:p.x+'px',top:p.y+'px',width:p.width+'px',height:p.height+'px',fontSize:p.fontSize+'px',
      color:p.color,backgroundColor:p.background,borderColor:p.borderColor,borderRadius:p.radius+'px',paddingLeft:p.padding+'px',paddingRight:p.padding+'px',webkitTextStroke:(p.strokeWidth||0)+'px currentColor',paintOrder:'stroke fill'};
  }
  function lerpRect(a,b,t) {
    const result={};
    for(const key of ['x','y','width','height']) result[key]=a[key]+(b[key]-a[key])*t;
    return result;
  }
  function curve(a,b) {
    const x=a.x+a.width, y=a.y+a.height/2, endX=b.x, endY=b.y+b.height/2;
    const bend=Math.max(24,Math.abs(endX-x)*.5);
    return 'M'+x+','+y+' C'+(x+bend)+','+y+' '+(endX-bend)+','+endY+' '+endX+','+endY;
  }
  async function run({render,entering,id,origin,tree,trail,color}) {
    cancelFlight?.();
    const before=diagramSnapshot();
    if(!before.size || !before.has(id)) return zoomFallback(render,{entering,origin});
    if(origin)before.set(id,{...before.get(id),x:origin.x,y:origin.y,width:origin.width,height:origin.height});
    const oldSheet=document.querySelector('.paper-surface');
    const paperRect=oldSheet?.getBoundingClientRect();
    const paperCopy=oldSheet ? oldSheet.cloneNode(true) : null;
    const layer=document.createElement('div');
    layer.className='journey-layer'; layer.setAttribute('aria-hidden','true');layer.inert=true;
    const wire=document.createElementNS('http://www.w3.org/2000/svg','svg');
    wire.classList.add('journey-wires');layer.append(wire);
    const svgPaths=tree.filter(n=>n.parent_id && before.has(n.id) && before.has(n.parent_id)).map(n=>{
      const path=document.createElementNS(wire.namespaceURI,'path');
      path.setAttribute('stroke',trail.has(n.id)?color:'#aebed4');
      path.setAttribute('stroke-width',trail.has(n.id)?'2.8':'1.3');
      path.setAttribute('opacity',trail.has(n.id)?'.9':'.45');wire.append(path);
      return {path,a:n.parent_id,b:n.id};
    });
    render();
    const after=diagramSnapshot();
    const actual=[...document.querySelectorAll('#view .map-stage, #view .context-vector')];
    if(!after.has(id)) return zoomFallback(()=>{},{entering,origin});
    document.body.append(layer);
    layer.style.setProperty('--branch',color);
    actual.forEach(el=>el.style.visibility='hidden');
    const source=before.get(id);
    const anchor={x:source.x+source.width/2,y:source.y+source.height/2};
    const target=after.get(id);
    const focal={x:target.x+target.width/2,y:target.y+target.height/2};
    const lens=document.createElement('div');lens.className='journey-lens';lens.setAttribute('aria-hidden','true');layer.append(lens);
    const halo=document.createElement('div');halo.className='journey-halo';layer.append(halo);
    const lensSize=Math.min(290,innerHeight*.44),lensFrom=Math.max(32,source.width*.5);
    const glass=document.createElementNS(wire.namespaceURI,'svg');glass.setAttribute('viewBox','0 0 '+lensSize+' '+lensSize);glass.setAttribute('class','journey-lens-content');lens.append(glass);
    const optical=before,zoom=1.65;
    for(const p of optical.values()){
      const x=lensSize/2+(p.x-anchor.x)*zoom,y=lensSize/2+(p.y-anchor.y)*zoom;
      const box=document.createElementNS(wire.namespaceURI,'rect');
      for(const [k,v] of Object.entries({x,y,width:p.width*zoom,height:p.height*zoom,rx:10,fill:p.background,stroke:p.borderColor}))box.setAttribute(k,v);
      glass.append(box);
      const text=document.createElementNS(wire.namespaceURI,'text'),lines=String(p.name).split('\n'),size=p.fontSize*zoom;
      text.setAttribute('x',x+p.width*zoom/2);text.setAttribute('y',y+p.height*zoom/2-(lines.length-1)*size*.7);text.setAttribute('text-anchor','middle');text.setAttribute('dominant-baseline','central');text.setAttribute('font-size',size);text.setAttribute('fill',p.color);text.style.fontFamily=p.fontFamily;text.style.fontWeight=p.fontWeight;text.style.fontStyle=p.fontStyle;text.style.textDecoration=p.textDecoration;text.setAttribute('stroke',p.color);text.setAttribute('stroke-width',(p.strokeWidth||0)*zoom);text.setAttribute('stroke-linejoin','round');text.setAttribute('paint-order','stroke fill');
      lines.forEach((line,i)=>{const span=document.createElementNS(wire.namespaceURI,'tspan');span.setAttribute('x',x+p.width*zoom/2);span.setAttribute('dy',i?size*1.4:0);span.textContent=line;text.append(span);});glass.append(text);
    }
    const focus=new Map([...before.keys()].map(key=>{
      const p=before.get(key), zoom=entering?1.65:.6;
      return [key,{...p,x:focal.x+(p.x-anchor.x)*zoom,y:focal.y+(p.y-anchor.y)*zoom,
        width:p.width*zoom,height:p.height*zoom,fontSize:p.fontSize*zoom,strokeWidth:(p.strokeWidth||0)*zoom,radius:p.radius*zoom,padding:p.padding*zoom}];
    }));
    const switching=!!oldSheet && !!document.querySelector('.paper-surface');
    const duration=switching?480:entering?640:530, split=entering?.5:.55, animations=[];
    let stopped=false, raf=0;
    document.body.classList.add('travelling');
    const cleanup=()=>{
      if(stopped)return;stopped=true;cancelAnimationFrame(raf);
      animations.forEach(a=>{a.finished.catch(()=>{});a.cancel();});actual.forEach(el=>el.style.visibility='');
      layer.remove();document.body.classList.remove('travelling');cancelFlight=null;
    };
    cancelFlight=cleanup;
    try {
      animations.push(halo.animate([
        {left:anchor.x+'px',top:anchor.y+'px',transform:'translate(-50%,-50%) scale(.2)',opacity:0},
        {left:anchor.x+'px',top:anchor.y+'px',transform:'translate(-50%,-50%) scale(1)',opacity:.55,offset:.3},
        {left:focal.x+'px',top:focal.y+'px',transform:'translate(-50%,-50%) scale(2.2)',opacity:0}
      ],{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'}));
      animations.push(lens.animate([
        {left:(anchor.x-lensFrom/2)+'px',top:(anchor.y-lensFrom/2)+'px',width:lensFrom+'px',height:lensFrom+'px',opacity:0,offset:0},
        {left:(focal.x-lensSize/2)+'px',top:(focal.y-lensSize/2)+'px',width:lensSize+'px',height:lensSize+'px',opacity:.9,offset:split},
        {left:(target.x-12)+'px',top:(target.y-12)+'px',width:(target.width+24)+'px',height:(target.height+24)+'px',opacity:0,offset:1}
      ],{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'}));
      for(const [key,p] of before) {
        const q=after.get(key);if(!q)continue;
        const ghost=document.createElement('div');
        ghost.className='journey-node'+(key===id?' journey-selected':'');
        ghost.textContent=p.name;ghost.style.fontFamily=p.fontFamily;ghost.style.fontWeight=p.fontWeight;ghost.style.fontStyle=p.fontStyle;ghost.style.textDecoration=p.textDecoration;
        Object.assign(ghost.style,frameStyle(p));layer.append(ghost);
        animations.push(ghost.animate([
          {...frameStyle(p),opacity:1,offset:0,easing:'cubic-bezier(.3,0,.25,1)'},
          {...frameStyle(focus.get(key)),opacity:trail.has(key)?1:.25,offset:split,easing:'cubic-bezier(.2,.75,.2,1)'},
          {...frameStyle(q),opacity:1,offset:1}
        ],{duration,fill:'both'}));
      }
      const sheet=document.querySelector('.paper-surface');
      const canvas=document.querySelector('.map-canvas');
      const panel=document.querySelector('.context-focus');
      if(panel){const r=panel.getBoundingClientRect();const center=(target.x+target.width/2-r.x)+'px '+(target.y+target.height/2-r.y)+'px';animations.push(panel.animate([{clipPath:'circle(0% at '+center+')',opacity:.3},{clipPath:'circle(150% at '+center+')',opacity:1}],{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'}));}
      if(entering && sheet) {
        const r=sheet.getBoundingClientRect(),scale=Math.max(.08,Math.min(.4,source.width/r.width));
        const from='translate('+(anchor.x-r.x-r.width/2)+'px,'+(anchor.y-r.y-r.height/2)+'px) scale('+scale+')';
        for(const el of document.querySelectorAll('.branch-tether, .overview-selection, .context-bridge, #edit-direction')) {
          animations.push(el.animate([{opacity:0,offset:0},{opacity:0,offset:.72},{opacity:1,offset:1}],{duration,fill:'both'}));
        }
        animations.push(sheet.animate([
          {opacity:0,transform:from,transformOrigin:'50% 50%',offset:0},
          {opacity:.15,transform:from,transformOrigin:'50% 50%',offset:.25},
          {opacity:1,transform:'translate(0px,0px) scale(1)',transformOrigin:'50% 50%',offset:1}
        ],{duration,easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'}));
      } else if(canvas) animations.push(canvas.animate([{opacity:.5},{opacity:1}],{duration,fill:'both'}));
      if(paperCopy && paperRect) {
        const copy=paperCopy;
        copy.classList.add('journey-paper');copy.removeAttribute('id');copy.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
        Object.assign(copy.style,{left:paperRect.x+'px',top:paperRect.y+'px',width:paperRect.width+'px',height:paperRect.height+'px'});
        layer.append(copy);
        const scale=Math.max(.08,Math.min(.4,target.width/paperRect.width));
        const to='translate('+(focal.x-paperRect.x-paperRect.width/2)+'px,'+(focal.y-paperRect.y-paperRect.height/2)+'px) scale('+scale+')';
        animations.push(copy.animate([
          {opacity:1,transform:'translate(0px,0px) scale(1)',transformOrigin:'50% 50%'},
          {opacity:0,transform:to,transformOrigin:'50% 50%'}
        ],{duration,fill:'both',easing:'cubic-bezier(.4,0,.2,1)'}));
      }
      const started=performance.now();
      const tick=now=>{
        if(stopped)return;
        const t=Math.min(1,(now-started)/duration);
        const current=new Map([...before].map(([key,p])=>{
          const f=focus.get(key),q=after.get(key)||p;
          return [key,t<split?lerpRect(p,f,easing(t/split)):lerpRect(f,q,easing((t-split)/(1-split)))];
        }));
        svgPaths.forEach(({path,a,b})=>path.setAttribute('d',curve(current.get(a),current.get(b))));
        if(t<1)raf=requestAnimationFrame(tick);
      };
      tick(started);
      await Promise.allSettled(animations.map(a=>a.finished));
    } finally {cleanup();}
  }
  scope.BranchJourney={run,zoom:zoomFallback,cancel:()=>cancelFlight?.()};
})(globalThis);
