(function (scope) {
  'use strict';
  const groups=new Map(), ease='cubic-bezier(.22,1,.36,1)';
  const reduced=()=>scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function cancel(key) {
    const group=groups.get(key);if(!group)return;
    group.animations.forEach(a=>a.cancel());group.ghost?.remove();groups.delete(key);
  }
  function group(key) { cancel(key);const g={animations:[]};groups.set(key,g);return g; }
  function play(g,el,frames,options={}) {
    if(!el || !el.animate || reduced())return null;
    const a=el.animate(frames,{duration:560,easing:ease,...options});g.animations.push(a);
    a.finished.catch(()=>{});return a;
  }
  function snapshot(el) {
    const r=el.getBoundingClientRect(),copy=el.cloneNode(true);
    copy.removeAttribute('id');copy.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
    copy.querySelectorAll('[data-paper],[data-rec],[data-context-id],[data-map-id]').forEach(n=>['data-paper','data-rec','data-context-id','data-map-id'].forEach(a=>n.removeAttribute(a)));
    copy.classList.add('motion-ghost');copy.setAttribute('aria-hidden','true');copy.inert=true;
    Object.assign(copy.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',margin:'0',zIndex:'24',pointerEvents:'none',overflow:'hidden'});
    document.body.append(copy);return copy;
  }
  function swap(el,render,{key='collection',direction=1,shared=false}={}) {
    cancel(key);
    if(reduced() || !el?.children.length){render();return;}
    const before=new Map(shared?[...el.querySelectorAll('[data-paper]')].map(n=>[n.dataset.paper,n.getBoundingClientRect()]):[]);
    const g=group(key);g.ghost=snapshot(el);
    try {render();}catch(error){cancel(key);throw error;}
    const leaving=play(g,g.ghost,[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:`translateY(${-direction*16}px)`}],{duration:300});
    leaving?.finished.finally(()=>g.ghost?.remove()).catch(()=>{});
    const cards=[...el.querySelectorAll('[data-paper],.recommendation-row,.usage-totals>div,.settings-form,.empty')];
    if(!cards.length)play(g,el.firstElementChild,[{opacity:0,transform:`translateY(${direction*22}px)`,filter:'blur(3px)'},{opacity:1,transform:'none',filter:'blur(0)'}]);
    cards.forEach((n,i)=>{
      const old=before.get(n.dataset.paper),r=n.getBoundingClientRect();
      if(old && r.width && r.height)play(g,n,[{opacity:.35,transform:`translate(${old.x-r.x}px,${old.y-r.y}px) scale(${old.width/r.width},${old.height/r.height})`,transformOrigin:'0 0'},{opacity:1,transform:'none',transformOrigin:'0 0'}],{duration:720});
      else play(g,n,[{opacity:0,transform:`translateY(${direction*24}px) scale(.97)`},{opacity:1,transform:'none'}],{delay:Math.min(i*35,175),duration:600});
    });
  }
  function reveal(el,selector) {
    if(reduced() || !el)return;const g=group('reveal');
    [...el.querySelectorAll(selector)].forEach((n,i)=>play(g,n,[{opacity:0,transform:'translateY(12px)'},{opacity:1,transform:'none'}],{delay:Math.min(i*28,220),duration:650}));
  }
  let origin=null;
  function openDialog(dialog,source) {
    const g=group('dialog');origin=source?.isConnected?source:null;
    const r=dialog.getBoundingClientRect(),s=origin?.getBoundingClientRect();
    const from=s?`translate(${s.x+s.width/2-r.x-r.width/2}px,${s.y+s.height/2-r.y-r.height/2}px) scale(${Math.min(.75,s.width/r.width)},${Math.min(.6,s.height/r.height)})`:'translateY(24px) scale(.96)';
    play(g,dialog,[{opacity:0,transform:from,filter:'blur(3px)'},{opacity:1,transform:'none',filter:'blur(0)'}],{duration:460});
  }
  async function closeDialog(dialog) {
    const g=group('dialog');if(reduced())return true;
    const r=dialog.getBoundingClientRect(),s=origin?.isConnected?origin.getBoundingClientRect():null;
    const to=s?`translate(${s.x+s.width/2-r.x-r.width/2}px,${s.y+s.height/2-r.y-r.height/2}px) scale(${Math.min(.75,s.width/r.width)},${Math.min(.6,s.height/r.height)})`:'translateY(16px) scale(.97)';
    const a=play(g,dialog,[{opacity:1,transform:'none'},{opacity:0,transform:to}],{duration:280});
    try{await a?.finished;return true;}catch{return false;}
  }
  scope.AtlasMotion={swap,reveal,openDialog,closeDialog,cancel};
})(globalThis);
