(function(scope){
  'use strict';
  const C=scope.MapEditorCore,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const alignments={left:'左对齐',center:'居中',right:'右对齐'};
  const colors={blue:'雾蓝',indigo:'靛蓝',slate:'岩蓝',violet:'蓝紫'},styles={default:'跟随分支',soft:'柔和填充',outline:'清透描边',emphasis:'深色强调'};
  let current=null,clipboard=null,mode=false,selection=new Set(),camera=null;
  const options=(values,chosen)=>Object.entries(values).map(([v,label])=>'<option value="'+v+'" '+(v===chosen?'selected':'')+'>'+label+'</option>').join('');
  class Editor{
    constructor(host){this.host=host;this.doc=C.copy(host.document());this.closed=false;this.busy=false;this.inline=null;this.annotation=null;this.gesture=null;this.matches=[];this.matchIndex=-1;this.collapsed=host.collapsed;this.mount();}
    mount(){
      $('#context-actions').innerHTML='<button id="edit-map" aria-pressed="'+mode+'" class="'+(mode?'selected':'')+'">✎ '+(mode?'完成编辑':'编辑地图')+'</button>';
      $('#view').innerHTML='<section id="map-canvas" class="map-canvas map-editor '+(mode?'is-editing':'')+'" aria-label="研究地图"><div id="map-stage" class="map-stage"></div><div class="map-editor-strip"><div class="map-search"><input id="map-search" type="search" placeholder="查找方向或备注" aria-label="查找方向或备注"><span id="map-search-count"></span><button data-map-command="find-next" aria-label="下一个搜索结果" title="Enter 下一个结果">↓</button></div><select id="map-expand" aria-label="导图展开层级"><option value="">展开层级</option><option value="all">全部展开</option><option value="1">只看一级</option><option value="2">展开到二级</option><option value="3">展开到三级</option><option value="none">全部折叠</option></select><button class="map-alignment" data-map-command="typography-global">全局文字</button><button class="map-alignment" data-map-command="alignment">全局对齐</button><div class="map-history"><button data-map-command="undo" aria-label="撤销" title="撤销 Ctrl+Z">↶</button><button data-map-command="redo" aria-label="重做" title="重做 Ctrl+Y">↷</button></div><span class="map-save-state" id="map-save-state" role="status">已保存</span></div><div id="node-tools" class="node-tools map-editor-tools" hidden></div><div id="map-more" class="map-editor-popover" hidden></div><div id="map-drop-hint" class="map-drop-hint" hidden></div><div id="map-selection-box" hidden></div><div class="map-caption" id="map-caption"></div><div class="canvas-tools"><button data-map-command="zoom-out" aria-label="缩小">−</button><span id="zoom-label"></span><button data-map-command="zoom-in" aria-label="放大">＋</button><button data-map-command="fit" aria-label="居中显示" title="居中显示">⤢</button><button data-map-command="help" aria-label="编辑快捷键" title="编辑快捷键">?</button></div></section>';
      this.canvas=$('#map-canvas');this.stage=$('#map-stage');
      $('#edit-map').onclick=async()=>{if(this.busy||!await this.flush())return;mode=!mode;selection.clear();this.host.remount();};
      this.canvas.onclick=e=>this.click(e);
      this.canvas.ondblclick=e=>{const n=e.target.closest('[data-enter]');if(mode&&n){e.preventDefault();this.rename(n.dataset.enter);}};
      this.canvas.oncontextmenu=e=>{if(!mode)return;const n=e.target.closest('[data-map-id]');if(n){e.preventDefault();selection=new Set([n.dataset.mapId]);this.annotation=null;this.paintSelection();this.menu();}};
      this.canvas.onpointerdown=e=>this.pointerDown(e);this.canvas.onpointermove=e=>this.pointerMove(e);this.canvas.onpointerup=e=>this.pointerUp(e);this.canvas.onpointercancel=()=>this.cancelGesture();
      this.canvas.addEventListener('wheel',e=>{if(e.target.closest('input,textarea,select,.map-editor-popover,.node-tools'))return;e.preventDefault();const r=this.canvas.getBoundingClientRect();this.zoom(Math.exp(-e.deltaY*.0014),e.clientX-r.x,e.clientY-r.y);},{passive:false});
      $('#map-search').oninput=()=>this.search();$('#map-search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();this.findNext();}if(e.key==='Escape'){e.target.value='';this.search();e.target.blur();}};
      $('#map-expand').onchange=e=>{const value=e.target.value;if(!value)return;this.collapsed.clear();if(value!=='all')for(const n of this.doc.nodes){let depth=0,p=n;while(p.parent_id){depth++;p=this.get(p.parent_id);}if(value==='none'||depth>=Number(value))this.collapsed.add(n.id);}this.persistCollapse();this.draw();this.fit();e.target.value='';};
      this.keyHandler=e=>this.key(e);document.addEventListener('keydown',this.keyHandler);
      this.observer=new ResizeObserver(()=>{if(!this.closed&&!this.inline&&!this.gesture)this.fit();});this.observer.observe(this.canvas);
      this.draw();if(!camera)this.fit();else this.applyCamera();
    }
    destroy(){this.closed=true;this.host.editing(false);this.observer?.disconnect();document.removeEventListener('keydown',this.keyHandler);this.cancelGesture();}
    get(id){return this.doc.nodes.find(n=>n.id===id);}
    draft(){return {nodes:C.copy(this.doc.nodes),annotations:C.copy(this.doc.annotations)};}
    selected(){return [...selection].filter(id=>this.get(id));}
    persistCollapse(){try{localStorage.setItem('atlas-collapsed-nodes',JSON.stringify([...this.collapsed]));}catch{}}
    sync(doc){if(this.busy||this.inline||this.closed||this.gesture)return;this.doc=C.copy(doc);this.draw();}
    status(text,error=false){const el=$('#map-save-state');if(el){el.textContent=text;el.classList.toggle('failed',error);}}
    async commit(next,action='save'){
      if(this.busy||this.closed)return false;
      this.busy=true;this.status('正在保存…');this.updateHistory();
      try{
        const result=await this.host.api('/api/map/action',{action,revision:this.doc.revision,fingerprint:this.doc.fingerprint,...(next?{document:next}:{})});
        this.doc=result;await this.host.updated(result);this.busy=false;
        if(!this.closed){this.draw();this.status('已保存');}return true;
      }catch(e){this.busy=false;this.status('未保存 · 可重试',true);if(e.message==='文字样式格式无效'&&next?.nodes.some(n=>['typography','global_typography'].some(k=>n[k]&&Object.keys(n[k]).some(p=>p.endsWith('_thickness')))))e=Error('服务未接受增粗样式，可能仍在运行旧版后端。请关闭旧的启动窗口并重新运行启动研究地图，再保存当前设置；若仍失败，请查看报错信息。');this.host.error(e);this.updateHistory();return false;}
    }
    async command(name){
      if(name==='zoom-in'){this.zoom(1.16);return;}if(name==='zoom-out'){this.zoom(.86);return;}if(name==='fit'){this.fit();return;}if(name==='help'){this.help();return;}if(name==='find-next'){this.findNext();return;}
      if(name==='alignment'){if(!this.busy&&await this.flush())this.alignmentForm();return;}
      if(name==='typography-global'){if(!this.busy&&await this.flush())this.typographyForm(true);return;}
      if(!mode||this.busy)return;
      if(name==='rename'){this.rename(this.selected()[0]);return;}
      if(!await this.flush())return;
      $('#map-more').hidden=true;
      const id=this.selected()[0];
      try{
        if(name==='undo'||name==='redo'){if(this.doc['can_'+name])await this.commit(null,name);return;}
        if(name==='child'||name==='sibling'||name==='parent'){await this.add(name,id);return;}
        if(name==='notes'){this.nodeForm(id);return;}
        if(name==='summary'||name==='boundary'||name==='relation'){this.annotationForm(name);return;}
        if(name==='more'){this.menu();return;}
        if(name==='delete'){this.remove();return;}
        if(name==='copy'||name==='cut'){this.copy(name==='cut');return;}
        if(name==='paste'){await this.paste(id);return;}
        if(name==='move'){this.moveForm();return;}
        if(name==='style'){this.styleForm();return;}
        if(name==='typography'){this.typographyForm(false);return;}
        if(name==='collapse'){this.toggle(id);return;}
        if(name==='annotation-edit'){this.annotationForm(null,this.annotation);return;}
        if(name==='annotation-delete'){this.removeAnnotation(this.annotation);return;}
      }catch(e){this.host.error(e);}
    }
    draw(){
      if(this.closed||!this.stage?.isConnected)return;
      const ctx=document.createElement('canvas').getContext('2d'),family=getComputedStyle(document.body).fontFamily;
      this.layout=C.layout(this.doc,this.collapsed,(s,size,style={})=>{ctx.font=(style.italic?'italic ':'')+(style.weight||500)+' '+size+'px '+family;const m=ctx.measureText(s);return Math.max(m.width,(m.actualBoundingBoxLeft||0)+(m.actualBoundingBoxRight||0));});this.host.layout(this.layout);
      const l=this.layout;this.stage.style.width=l.width+'px';this.stage.style.height=l.height+'px';
      const dash=a=>a.line==='dashed'?' stroke-dasharray="7 5"':'';
      let svg='<svg class="map-wires" width="'+l.width+'" height="'+l.height+'" aria-hidden="true">';
      for(const [p,q] of l.edges){const x=p.x+p.width,y=p.y+p.height/2,ey=q.y+q.height/2;svg+='<path d="M '+x+' '+y+' C '+(x+48)+' '+y+' '+(q.x-48)+' '+ey+' '+q.x+' '+ey+'" stroke="'+q.branch+'"/>';}
      svg+='</svg><svg class="map-annotation-wires" width="'+l.width+'" height="'+l.height+'" aria-label="导图概要、联系与分组"><defs>';
      for(const [key,color] of Object.entries(C.palette))svg+='<marker id="map-arrow-'+key+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="'+color+'" stroke-width="1.5"/></marker>';
      svg+='</defs>';
      for(const a of l.annotations){const chosen=this.annotation===a.id;
        if(a.type==='boundary')svg+='<rect class="map-boundary '+(chosen?'selected':'')+'" data-annotation="'+a.id+'" x="'+a.x+'" y="'+a.y+'" width="'+(a.right-a.x)+'" height="'+(a.bottom-a.y)+'" rx="18" stroke="'+a.colorValue+'" fill="'+a.colorValue+'"'+dash(a)+'/>';
        if(a.type==='summary')svg+='<path class="map-summary-bracket" data-annotation="'+a.id+'" d="M '+(a.right-4)+' '+a.y+' Q '+(a.right+10)+' '+a.y+' '+(a.right+10)+' '+(a.y+16)+' L '+(a.right+10)+' '+(a.bottom-16)+' Q '+(a.right+10)+' '+a.bottom+' '+(a.right-4)+' '+a.bottom+' M '+(a.right+10)+' '+((a.y+a.bottom)/2)+' L '+(a.labelX-7)+' '+((a.y+a.bottom)/2)+'" stroke="'+a.colorValue+'"'+dash(a)+'/>';
        if(a.type==='relation')svg+='<g class="map-relation '+(chosen?'selected':'')+'" data-annotation="'+a.id+'"><path class="map-relation-hit" d="M '+a.x1+' '+a.y1+' Q '+a.mx+' '+a.my+' '+a.x2+' '+a.y2+'"/><path class="map-relation-line" d="M '+a.x1+' '+a.y1+' Q '+a.mx+' '+a.my+' '+a.x2+' '+a.y2+'" stroke="'+a.colorValue+'"'+dash(a)+(a.direction!=='none'?' marker-end="url(#map-arrow-'+a.color+')"':'')+(a.direction==='both'?' marker-start="url(#map-arrow-'+a.color+')"':'')+'/></g>';
      }svg+='</svg>';
      let labels='';
      for(const a of l.annotations){const relation=a.type==='relation',x=relation?a.lx-a.labelWidth/2:a.labelX,y=relation?a.ly-a.labelHeight/2:a.labelY,w=relation?a.labelWidth:220;
        labels+='<button class="map-annotation-label '+a.type+' '+(this.annotation===a.id?'chosen':'')+'" data-annotation="'+a.id+'" aria-label="编辑'+({summary:'概要',boundary:'分组',relation:'联系'}[a.type])+'：'+esc(a.label)+'" style="left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+a.labelHeight+'px;--annotation:'+a.colorValue+'"><svg viewBox="0 0 '+w+' '+a.labelHeight+'" aria-hidden="true">'+C.vectorText(a.labelLines,w,a.labelHeight,{size:relation?14:15,lineHeight:relation?20:22,align:relation?'center':'left'})+'</svg></button>';
        if(relation&&mode&&this.annotation===a.id)labels+='<button class="map-curve-handle" data-curve="'+a.id+'" aria-label="拖拽调整联系线弧度" title="拖拽调整联系线弧度" style="left:'+(a.mx-8)+'px;top:'+(a.my-8)+'px"></button>';
      }
      const align=C.alignment(this.doc);
      this.stage.innerHTML=svg+l.positions.map(p=>{
        const n=p.node,kids=this.doc.nodes.some(k=>k.parent_id===n.id),folded=this.collapsed.has(n.id);
        const inherited=this.inherit(n,'style')||'default';
        return '<div class="map-node '+(!p.depth?'root ':p.depth===1?'branch-node ':'')+(kids?'has-children ':'')+'map-style-'+inherited+' '+(selection.has(n.id)?'chosen ':'')+(this.matches.includes(n.id)?'search-match':'')+'" data-map-id="'+esc(n.id)+'" style="left:'+p.x+'px;top:'+p.y+'px;width:'+p.width+'px;height:'+p.height+'px;--branch:'+p.branch+';--node-title-align:'+align.title+'"><button class="node-label" data-enter="'+esc(n.id)+'" aria-label="'+esc(n.name)+'" title="'+esc(n.name)+'" style="font-size:'+p.fontSize+'px;line-height:'+p.lineHeight+'">'+C.nodeVector(p,align)+'</button>'+(kids?'<button class="node-fold" data-fold="'+esc(n.id)+'" aria-label="'+(folded?'展开子方向':'折叠子方向')+'" aria-expanded="'+(!folded)+'" title="'+(folded?'展开子方向':'折叠子方向')+'"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M5 10H15'+(folded?' M10 5V15':'')+'"/></svg></button>':'')+'</div>';
      }).join('')+labels;
      selection=new Set(this.selected());this.applyCamera();this.updateHistory();this.updateCaption();
    }
    inherit(n,key){const seen=new Set();while(n&&!seen.has(n.id)){seen.add(n.id);if(n[key]&&n[key]!=='default')return n[key];n=this.get(n.parent_id);}return '';}
    updateHistory(){for(const action of ['undo','redo']){const b=$('[data-map-command="'+action+'"]');if(b)b.disabled=!mode||this.busy||!this.doc['can_'+action];}}
    updateCaption(){const e=$('#map-caption');if(e)e.textContent=mode?'双击改名 · Tab 子方向 · Enter 同级 · Ctrl 多选 · Shift 拖拽框选 · 拖动节点调整结构':'点击方向进入文献 · 拖动画布 · 滚轮缩放';}
    applyCamera(){if(!camera||this.closed)return;Object.assign(this.stage.style,{transform:'translate('+camera.x/camera.z+'px,'+camera.y/camera.z+'px)',zoom:camera.z,left:'0px',top:'0px'});$('#zoom-label').textContent=Math.round(camera.z*100)+'%';if(!this.gesture)this.tools();}
    fit(){if(!this.layout||this.closed)return;const {width:w,height:h}=this.layout,z=Math.max(.02,Math.min(1.12,(this.canvas.clientWidth-64)/w,(this.canvas.clientHeight-132)/h));camera={z,x:(this.canvas.clientWidth-w*z)/2,y:74+(this.canvas.clientHeight-132-h*z)/2};this.applyCamera();}
    zoom(factor,x=this.canvas.clientWidth/2,y=this.canvas.clientHeight/2){if(!camera)return;const z=Math.max(.02,Math.min(3,camera.z*factor)),r=z/camera.z;camera={z,x:x-(x-camera.x)*r,y:y-(y-camera.y)*r};this.applyCamera();}
    reveal(id){let n=this.get(id);while(n){this.collapsed.delete(n.id);n=this.get(n.parent_id);}this.persistCollapse();this.draw();const p=this.layout.positions.find(p=>p.node.id===id);if(p){camera.z=Math.max(camera.z,.8);camera.x=this.canvas.clientWidth/2-(p.x+p.width/2)*camera.z;camera.y=this.canvas.clientHeight/2-(p.y+p.height/2)*camera.z;this.applyCamera();}}
    tools(){
      const bar=$('#node-tools');if(!bar)return;const ids=this.selected(),p=this.layout?.positions.find(p=>p.node.id===ids[0]),a=this.layout?.annotations.find(a=>a.id===this.annotation);
      bar.hidden=!mode||(!p&&!a)||!!this.inline;if(bar.hidden)return;
      const commands=a?[['annotation-edit','编辑标注'],['annotation-delete','删除标注']]:ids.length>1?[['summary','概要'],['boundary','分组'],['relation','联系'],['typography','文字'],['style','样式'],['move','移动'],['more','更多']]:[['rename','改名'],['child','＋ 子方向'],['notes','备注'],['typography','文字'],['relation','联系'],['more','更多']];
      bar.innerHTML=commands.map(([key,label])=>'<button data-map-command="'+key+'">'+label+'</button>').join('');
      const x=p?p.x:a.type==='relation'?a.lx:a.labelX,y=p?p.y:a.type==='relation'?a.ly:a.labelY;
      const px=camera.x+x*camera.z,py=camera.y+y*camera.z,w=p?p.width*camera.z:0,h=p?p.height*camera.z:25,bw=bar.offsetWidth,bh=bar.offsetHeight;
      const rects=this.layout.positions.map(n=>({x:camera.x+n.x*camera.z,y:camera.y+n.y*camera.z,w:n.width*camera.z,h:n.height*camera.z}));
      const choices=[[px,py-bh-12],[px,py+h+12],[px+w+12,py],[px-bw-12,py],[px,66]].map(([x,y])=>({x:Math.max(10,Math.min(this.canvas.clientWidth-bw-10,x)),y:Math.max(64,Math.min(this.canvas.clientHeight-bh-64,y))}));
      const overlap=c=>rects.reduce((sum,r)=>sum+Math.max(0,Math.min(c.x+bw,r.x+r.w+5)-Math.max(c.x,r.x-5))*Math.max(0,Math.min(c.y+bh,r.y+r.h+5)-Math.max(c.y,r.y-5)),0);
      let best=choices[0];for(const c of choices)if(overlap(c)<overlap(best))best=c;
      bar.style.left=best.x+'px';bar.style.top=best.y+'px';
    }
    paintSelection(){for(const e of $$('[data-map-id]'))e.classList.toggle('chosen',selection.has(e.dataset.mapId));this.tools();}
    async click(e){
      if(this.suppressClick){this.suppressClick=false;return;}
      const command=e.target.closest('[data-map-command]');if(command){await this.command(command.dataset.mapCommand);return;}
      const fold=e.target.closest('[data-fold]');if(fold){if(await this.flush())this.toggle(fold.dataset.fold);return;}
      const annotation=e.target.closest('[data-annotation]');if(annotation){if(!await this.flush())return;if(mode){this.annotation=annotation.dataset.annotation;selection.clear();this.draw();}else this.showAnnotation(annotation.dataset.annotation);return;}
      const n=e.target.closest('[data-enter]');if(n){if(!await this.flush())return;const id=n.dataset.enter;if(this.linking){if(id!==this.linking){const start=this.linking;this.linking=null;selection=new Set([start,id]);this.annotationForm('relation');}return;}
        if(mode){this.annotation=null;if(e.ctrlKey||e.metaKey){selection.has(id)?selection.delete(id):selection.add(id);}else selection=new Set([id]);this.paintSelection();$('#map-more').hidden=true;}
        else if(!this.busy)this.host.enter(id);return;
      }
      if(!e.target.closest('.map-editor-strip,.node-tools,.canvas-tools,.map-editor-popover,input,textarea,a')){if(await this.flush()){selection.clear();this.annotation=null;this.draw();$('#map-more').hidden=true;}}
    }
    async toggle(id){if(!this.get(id))return;if(this.collapsed.has(id))this.collapsed.delete(id);else this.collapsed.add(id);this.persistCollapse();this.draw();}
    rename(id){
      if(!id||this.busy||this.inline)return;const n=this.get(id),el=$$('[data-map-id]').find(e=>e.dataset.mapId===id);if(!n||!el)return;
      const input=document.createElement('textarea');input.className='inline-name map-inline-name';input.maxLength=160;input.value=n.name;input.setAttribute('aria-label','方向名称');input.wrap='off';input.rows=2;input.title="Shift+Enter 换行，Enter 保存";const style=C.textStyle(this.doc,n,n.parent_id?1:0).title;Object.assign(input.style,{fontSize:style.size+'px',fontWeight:style.weight,fontStyle:style.italic?'italic':'normal',textDecoration:style.underline?'underline':'none',webkitTextStroke:style.strokeWidth+'px currentColor',paintOrder:'stroke fill'});
      el.querySelector('.node-label').replaceWith(input);this.inline={id,input};this.host.editing(true);this.tools();input.focus();input.select();
      input.oninput=()=>{const ctx=document.createElement('canvas').getContext('2d'),font=getComputedStyle(input);ctx.font=font.fontStyle+' '+font.fontWeight+' '+font.fontSize+' '+font.fontFamily;const measure=t=>{const m=ctx.measureText(t);return Math.max(m.width,(m.actualBoundingBoxLeft||0)+(m.actualBoundingBoxRight||0));};const lines=C.manualLines(input.value),width=Math.ceil(Math.max(64,...lines.map(line=>measure(line)+42+style.strokeWidth)));el.style.width=width+'px';el.style.height=Math.max(56,lines.length*parseFloat(font.lineHeight)+24+style.strokeWidth)+'px';};
      input.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopPropagation();this.flush();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.inline=null;this.host.editing(false);this.draw();}};
      input.onblur=()=>{const entry=this.inline;setTimeout(()=>{if(entry&&entry===this.inline&&!this.closed&&!$('#modal').open)this.flush();},100);};
    }
    async flush(){
      const entry=this.inline;if(!entry)return !this.busy;if(entry.saving)return entry.saving;
      const name=entry.input.value.trim();if(!name){this.host.error(Error('方向名称不能为空'));entry.input.focus();return false;}
      if(name===this.get(entry.id)?.name){this.inline=null;this.host.editing(false);this.draw();return true;}
      entry.saving=(async()=>{const doc=this.draft();doc.nodes.find(n=>n.id===entry.id).name=name;const ok=await this.commit(doc);if(ok){this.inline=null;this.host.editing(false);this.draw();}else{entry.saving=null;entry.input.focus();}return ok;})();return entry.saving;
    }
    async add(kind,id){
      const n=this.get(id);if(!n)throw Error('请先选择一个方向');
      if(kind!=='child'&&!n.parent_id)throw Error('根节点只能添加子方向');
      const doc=this.draft(),nid=C.uid(),next={id:nid,parent_id:kind==='child'?id:n.parent_id,name:'新方向',keywords:'',remark:'',notes:'',style:'',color:'',icon:'',link:''};
      if(kind==='parent'){doc.nodes.find(x=>x.id===id).parent_id=nid;next.name='新父方向';}
      let index=kind==='sibling'?doc.nodes.findIndex(x=>x.id===id)+1:kind==='parent'?doc.nodes.findIndex(x=>x.id===id):doc.nodes.length;doc.nodes.splice(index,0,next);
      C.cleanAnnotations(doc);
      const save=async(rename=true)=>{const ok=await this.commit(doc);if(ok){selection=new Set([nid]);this.collapsed.delete(kind==='child'?id:n.parent_id);this.persistCollapse();this.reveal(nid);if(rename)this.rename(nid);}return ok;};
      const removed=this.doc.annotations.length-doc.annotations.length;
      if(removed)this.confirmChange('调整分支结构','插入方向后，'+removed+' 项概要或分组将因范围失效被移除。方向和论文保留。',()=>save(false),'确认调整',()=>this.rename(nid));else await save();
    }
    menu(){
      const el=$('#map-more'),bar=$('#node-tools');if(!el||!bar)return;
      const rows=[['sibling','添加同级方向','Enter'],['parent','插入父方向',''],['notes','方向备注',''],['summary','概要','Ctrl 多选'],['boundary','分组边界','Ctrl 多选'],['relation','联系线',''],['typography','文字样式',''],['style','样式与标记',''],['move','移动到其他方向',''],['copy','复制分支','Ctrl+C'],['cut','剪切分支','Ctrl+X'],['paste','粘贴为子方向','Ctrl+V'],['collapse','折叠 / 展开','Space'],['delete','移除分支','Delete']];
      el.innerHTML=rows.map(([key,label,hint])=>'<button data-map-command="'+key+'"><span>'+label+'</span><small>'+hint+'</small></button>').join('');el.hidden=false;
      el.style.left=Math.max(10,Math.min(this.canvas.clientWidth-252,parseFloat(bar.style.left)||20))+'px';el.style.top=Math.max(66,Math.min(this.canvas.clientHeight-el.offsetHeight-58,(parseFloat(bar.style.top)||68)+bar.offsetHeight+7))+'px';
    }
    typographyForm(global=false){
      const ids=this.selected();if(!global&&!ids.length)return;
      const root=this.doc.nodes.find(n=>!n.parent_id),values=global?(root.global_typography||{}):(this.get(ids[0]).typography||{});
      const inherited=C.textStyle(this.doc,this.get(ids[0])||root,(this.get(ids[0])||root).parent_id?1:0);
      const field=(key,label,defaultSize,max)=>'<fieldset class="map-typography-group"><legend>'+label+'</legend><div class="map-typography-fields"><label class="field">'+label+'字号<input name="'+key+'_size" type="number" min="10" max="'+max+'" step="1" value="'+(values[key+'_size']??'')+'" placeholder="'+(global?defaultSize:'跟随全局')+'"><small>10–'+max+'；留空'+(global?'使用默认字号':'跟随全局')+'</small></label>'+[['bold','加粗'],['italic','斜体'],['underline','下划线']].map(([property,text])=>{const name=key+'_'+property,choices=global?{'':'默认','true':'开启','false':'关闭'}:{'':'跟随全局','true':'开启','false':'关闭'};return '<label class="field">'+label+text+'<select name="'+name+'">'+options(choices,values[name]===undefined?'':String(values[name]))+'</select></label>';}).join('')+'</div><div class="map-thickness-control"><label class="field">'+label+'增粗强度<input name="'+key+'_thickness" data-thickness="'+key+'" type="number" min="0" max="100" step="1" value="'+(values[key+'_thickness']??'')+'" placeholder="'+(global?'0':'跟随全局')+'"></label><input type="range" min="0" max="100" step="1" data-thickness-slider="'+key+'" aria-label="'+label+'增粗强度滑块" value="'+(values[key+'_thickness']??(global?0:inherited[key].thickness))+'"><button type="button" data-thickness-reset="'+key+'">'+(global?'默认':'跟随全局')+'</button></div><small class="subtle">0–100，在现有字重上继续增粗；留空'+(global?'使用默认值0':'跟随全局')+'。</small></fieldset>';
      this.host.modal(global?'全局文字样式':ids.length>1?'批量设置节点文字':'节点文字样式','<form id="map-typography-form" class="map-editor-form"><p class="subtle">'+(global?'应用到所有跟随全局的节点，新建节点自动沿用。单独设置过的节点保留自己的样式。':'仅应用到选中节点。每一项均可单独设置，留空或选择“跟随全局”即可继承全局样式。')+'</p>'+field('title','标题','根节点 26，其余 22',72)+field('remark','备注','14',48)+'<div class="map-typography-preview" aria-label="文字样式实时预览"><div data-preview="title"></div><div data-preview="remark"></div></div><div class="form-footer"><button type="button" id="map-reset-typography">'+(global?'恢复全局默认':'全部跟随全局')+'</button><button class="primary">保存文字样式</button></div></form>');
      const save=async values=>{const doc=this.draft();if(global){const target=doc.nodes.find(n=>!n.parent_id);delete target.global_typography;if(Object.keys(values).length)target.global_typography=values;}else for(const n of doc.nodes)if(ids.includes(n.id)){delete n.typography;if(Object.keys(values).length)n.typography=C.copy(values);}if(await this.commit(doc)){this.host.closeModal();this.fit();}};
      $('#map-typography-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),values={};for(const prefix of ['title','remark']){const size=String(f.get(prefix+'_size')||'').trim();if(size){const value=Number(size),max=prefix==='title'?72:48;if(!Number.isInteger(value)||value<10||value>max){this.host.error(Error('字号超出允许范围'));return;}values[prefix+'_size']=value;}const thickness=String(f.get(prefix+'_thickness')??'').trim();if(thickness!==''){const value=Number(thickness);if(!Number.isInteger(value)||value<0||value>100){this.host.error(Error('增粗强度应为0–100的整数'));return;}values[prefix+'_thickness']=value;}for(const key of ['bold','italic','underline']){const value=f.get(prefix+'_'+key);if(value==='true'||value==='false')values[prefix+'_'+key]=value==='true';}}await save(values);};
      $('#map-reset-typography').onclick=()=>save({});
      const form=$('#map-typography-form');if(!form.querySelector)return;
      const preview=()=>{const sample=C.copy(this.doc),node=sample.nodes.find(n=>n.id===(global?root.id:ids[0])),settings={};for(const prefix of ['title','remark']){for(const property of ['size','thickness']){const raw=form.elements[prefix+'_'+property].value;if(raw!==''){const value=Number(raw),max=property==='thickness'?100:prefix==='title'?72:48;if(Number.isInteger(value)&&value>=(property==='size'?10:0)&&value<=max)settings[prefix+'_'+property]=value;}}for(const property of ['bold','italic','underline']){const raw=form.elements[prefix+'_'+property].value;if(raw==='true'||raw==='false')settings[prefix+'_'+property]=raw==='true';}}if(global){node.global_typography=settings;delete node.typography;}else node.typography=settings;const style=C.textStyle(sample,node,node.parent_id?1:0);for(const prefix of ['title','remark']){const el=form.querySelector('[data-preview="'+prefix+'"]'),s=style[prefix];el.textContent=prefix==='title'?node.name:node.remark||'备注';Object.assign(el.style,{fontSize:s.size+'px',fontWeight:s.weight,fontStyle:s.italic?'italic':'normal',textDecoration:s.underline?'underline':'none',webkitTextStroke:s.strokeWidth+'px currentColor',paintOrder:'stroke fill'});}};
      for(const prefix of ['title','remark']){const number=form.elements[prefix+'_thickness'],slider=form.querySelector('[data-thickness-slider="'+prefix+'"]');slider.oninput=()=>{number.value=slider.value;preview();};number.oninput=()=>{slider.value=number.value===''?(global?0:C.textStyle(this.doc,{...this.get(ids[0]),typography:{}},this.get(ids[0]).parent_id?1:0)[prefix].thickness):number.value;preview();};form.querySelector('[data-thickness-reset="'+prefix+'"]').onclick=()=>{number.value='';number.oninput();};}
      form.oninput=preview;form.onchange=preview;preview();
    }
    alignmentForm(){
      const align=C.alignment(this.doc);
      this.host.modal('全局文字对齐','<form id="map-alignment-form" class="map-editor-form"><p class="subtle">应用到整张思维导图的所有方向，包括之后新增的方向。</p><div class="form-grid"><label class="field">标题对齐<select name="title">'+options(alignments,align.title)+'</select></label><label class="field">备注对齐<select name="remark">'+options(alignments,align.remark)+'</select></label></div><div class="form-footer"><button type="button" id="map-alignment-cancel">取消</button><button class="primary">应用到全图</button></div></form>');
      $('#map-alignment-cancel').onclick=()=>this.host.closeModal();
      $('#map-alignment-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),doc=this.draft(),root=doc.nodes.find(n=>!n.parent_id);root.text_align=f.get('title');root.remark_align=f.get('remark');if(await this.commit(doc))this.host.closeModal();};
    }
    nodeForm(id){
      const n=this.get(id);if(!n)return;
      this.host.modal('方向备注','<form id="map-node-form" class="map-editor-form"><label class="field">方向名称<textarea name="name" required rows="2" maxlength="160">'+esc(n.name)+'</textarea></label><label class="field">简短备注<small>显示在方向名称下方，使用灰色小字；仅手动换行，节点宽度随内容调整。</small><textarea name="remark" rows="3" maxlength="500">'+esc(n.remark)+'</textarea></label><div class="form-footer"><button class="primary">保存</button></div></form>');
      $('#map-node-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),doc=this.draft(),target=doc.nodes.find(x=>x.id===id);for(const key of ['name','remark'])target[key]=String(f.get(key)||'').trim();if(await this.commit(doc))this.host.closeModal();};
    }
    annotationForm(type,id){
      const existing=this.doc.annotations.find(a=>a.id===id),ids=this.selected();type=existing?.type||type;
      let a=existing?C.copy(existing):{id:C.uid(),type,label:'',color:'blue',line:'solid',direction:'single',curve:-90};
      if(!existing){if(type==='relation'){if(ids.length<2){if(ids.length===1){this.linking=ids[0];$('#map-caption').textContent='请点击另一个方向，创建跨分支联系 · Esc 取消';return;}throw Error('请选择联系线的起点与终点');}if(ids.length!==2)throw Error('联系线需要恰好两个方向');a.from=ids[0];a.to=ids[1];}else a.members=C.siblingRange(this.doc.nodes,ids);}
      const range=type==='relation'?'<label class="field">起点<select name="from">'+this.doc.nodes.map(n=>'<option value="'+n.id+'" '+(n.id===a.from?'selected':'')+'>'+esc(n.name)+'</option>').join('')+'</select></label><label class="field">终点<select name="to">'+this.doc.nodes.map(n=>'<option value="'+n.id+'" '+(n.id===a.to?'selected':'')+'>'+esc(n.name)+'</option>').join('')+'</select></label><label class="field">箭头<select name="direction">'+options({single:'单向 →',both:'双向 ↔',none:'无箭头'},a.direction)+'</select></label>':'<fieldset class="map-range"><legend>范围 · 连续的同级方向</legend>'+this.doc.nodes.filter(n=>n.parent_id===this.get(a.members[0])?.parent_id).map(n=>'<label><input type="checkbox" name="members" value="'+n.id+'" '+(a.members.includes(n.id)?'checked':'')+'>'+esc(n.name)+'</label>').join('')+'</fieldset>';
      this.host.modal(({summary:'概要',boundary:'分组边界',relation:'联系线'})[type],'<form id="map-annotation-form" class="map-editor-form"><label class="field">'+(type==='relation'?'联系说明':'名称')+'<textarea name="label" rows="2" maxlength="300">'+esc(a.label)+'</textarea></label>'+range+'<div class="form-grid"><label class="field">颜色<select name="color">'+options(colors,a.color)+'</select></label><label class="field">线条<select name="line">'+options({solid:'实线',dashed:'虚线'},a.line)+'</select></label></div><div class="form-footer">'+(existing?'<button type="button" class="danger" id="map-remove-annotation">删除</button>':'')+'<button class="primary">保存</button></div></form>');
      $('#map-annotation-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),doc=this.draft();for(const key of ['label','color','line'])a[key]=String(f.get(key)||'');if(type==='relation'){for(const key of ['from','to','direction'])a[key]=String(f.get(key));if(a.from===a.to){this.host.error(Error('联系线需要连接两个不同的方向'));return;}}else{a.members=f.getAll('members');try{a.members=C.siblingRange(doc.nodes,a.members);}catch(e){this.host.error(e);return;}}doc.annotations=doc.annotations.filter(x=>x.id!==a.id);doc.annotations.push(a);this.annotation=a.id;selection.clear();if(await this.commit(doc)){this.host.closeModal();this.fit();}};
      if(existing)$('#map-remove-annotation').onclick=()=>this.removeAnnotation(a.id);
    }
    showAnnotation(id){const a=this.doc.annotations.find(x=>x.id===id);if(!a)return;const names=a.type==='relation'?[a.from,a.to]:a.members;this.host.modal(a.label||({summary:'概要',boundary:'分组',relation:'联系'})[a.type],'<div class="map-note-view"><p>'+names.map(id=>esc(this.get(id)?.name||'')).join(a.type==='relation'?' ↔ ':'<br>')+'</p></div>');}
    styleForm(){
      const ids=this.selected();if(!ids.length)return;const first=this.get(ids[0]);
      this.host.modal(ids.length>1?'批量设置节点样式':'节点样式','<form id="map-style-form" class="map-editor-form"><label class="field">外观<select name="style">'+options(styles,first.style||'default')+'</select></label><label class="field">分支色系<select name="color">'+options({'':'跟随分支',...colors},first.color||'')+'</select></label><label class="field">标记<select name="icon">'+options({'':'无标记','★':'★ 重点','◆':'◆ 方法','✓':'✓ 已梳理','?':'? 待研究','!':'! 关键问题'},first.icon||'')+'</select></label><p class="subtle">颜色和外观沿分支继承，节点标记只应用到选中方向。</p><div class="form-footer"><button type="button" id="map-reset-style">恢复默认</button><button class="primary">保存</button></div></form>');
      $('#map-style-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),doc=this.draft();for(const n of doc.nodes)if(ids.includes(n.id))for(const key of ['style','color','icon'])n[key]=String(f.get(key)||'');if(await this.commit(doc))this.host.closeModal();};
      $('#map-reset-style').onclick=async()=>{const doc=this.draft();for(const n of doc.nodes)if(ids.includes(n.id))for(const key of ['style','color','icon'])n[key]='';if(await this.commit(doc))this.host.closeModal();};
    }
    confirmChange(title,message,proceed,label='确认执行',after){
      const fingerprint=this.doc.fingerprint;
      this.host.modal(title,'<div class="map-editor-form"><p class="map-confirm-message">'+esc(message)+'</p><p class="subtle">确认后执行，可通过撤销恢复。</p><div class="form-footer"><button id="map-cancel-action" autofocus>取消</button><button id="map-confirm-action" class="danger">'+esc(label)+'</button></div></div>');
      $('#map-cancel-action').onclick=()=>this.host.closeModal();
      $('#map-confirm-action').onclick=async e=>{if(this.busy||e.currentTarget.disabled)return;if(this.closed||this.doc.fingerprint!==fingerprint){this.host.closeModal();this.host.error(Error('导图已更新，请重新选择要操作的分支'));return;}const button=e.currentTarget;button.disabled=true;try{if(await proceed()!==false){await this.host.closeModal();after?.();}}catch(error){this.host.error(error);}finally{button.disabled=false;}};
    }
    removeAnnotation(id){const a=this.doc.annotations.find(a=>a.id===id);if(!a)return;this.confirmChange('删除标注','将删除'+({summary:'概要',boundary:'分组边界',relation:'联系线'}[a.type])+'「'+(a.label||'未命名')+'」。方向与论文保留。',async()=>{const doc=this.draft();doc.annotations=doc.annotations.filter(a=>a.id!==id);const ok=await this.commit(doc);if(ok){this.annotation=null;this.draw();}return ok;},'确认删除');}
    moveForm(){
      const ids=C.roots(this.doc.nodes,this.selected()),excluded=new Set();for(const id of ids)for(const d of C.descendants(this.doc.nodes,id))excluded.add(d);
      if(!ids.length||ids.some(id=>!this.get(id).parent_id))throw Error('请选择根节点以外的方向');
      this.host.modal('移动方向','<form id="map-move-form" class="map-editor-form"><label class="field">新的父方向<select name="parent">'+this.doc.nodes.filter(n=>!excluded.has(n.id)).map(n=>'<option value="'+n.id+'">'+esc(n.name)+'</option>').join('')+'</select></label><p class="subtle">论文归属跟随原节点保留；下一步确认移动范围。</p><div class="form-footer"><button class="primary">下一步</button></div></form>');
      $('#map-move-form').onsubmit=e=>{e.preventDefault();try{this.moveBranches(ids,new FormData(e.target).get('parent'));}catch(e){this.host.error(e);}};
    }
    moveBranches(ids,target,position='inside',after){
      const doc=C.move(this.draft(),ids,target,position),names=ids.map(id=>'「'+this.get(id).name+'」').join('、'),destination='「'+this.get(target).name+'」'+({inside:'内',before:'之前',after:'之后'}[position]);
      const removed=this.doc.annotations.length-doc.annotations.length;
      this.confirmChange('移动分支','将 '+names+' 及其子方向从原位置移动到 '+destination+'。'+(removed?'同时移除 '+removed+' 项不再适用的概要或分组。':'')+'已有论文与阅读结果保留。',async()=>{const ok=await this.commit(doc);if(ok){this.collapsed.delete(target);this.persistCollapse();selection=new Set(ids);after?.();this.reveal(ids[0]);}return ok;},'确认移动');
    }
    copy(cut){
      const ids=C.roots(this.doc.nodes,this.selected());if(!ids.length)return;if(cut&&ids.some(id=>!this.get(id).parent_id))throw Error('根节点不能剪切');
      const save=()=>{clipboard={document:this.draft(),ids,cut,fingerprint:this.doc.fingerprint};this.host.toast(cut?'已标记剪切，粘贴并确认后移动分支':'已复制方向结构、备注与标注；不复制论文');};
      if(cut)this.confirmChange('剪切分支','将剪切 '+ids.map(id=>'「'+this.get(id).name+'」').join('、')+' 及其全部子方向。当前内容暂时保留，粘贴并确认后将从原位置移走；论文归属保留。',save,'确认剪切');else save();
    }
    async paste(parent){
      if(!clipboard||!this.get(parent))throw Error('请先复制分支，再选择一个粘贴目标');
      if(clipboard.cut){if(clipboard.fingerprint!==this.doc.fingerprint)throw Error('导图已修改，请重新剪切');this.moveBranches(clipboard.ids,parent,'inside',()=>{clipboard=null;});return;}
      const doc=this.draft(),part=C.duplicate(clipboard.document,clipboard.ids,parent);doc.nodes.push(...part.nodes);doc.annotations.push(...part.annotations);
      if(await this.commit(doc)){selection=new Set(part.selected);this.collapsed.delete(parent);this.persistCollapse();this.reveal(part.selected[0]);}
    }
    remove(){
      const ids=C.roots(this.doc.nodes,this.selected());if(ids.some(id=>!this.get(id).parent_id))throw Error('根节点不能移除');if(!ids.length)return;
      const deleted=new Set();for(const id of ids)for(const d of C.descendants(this.doc.nodes,id))deleted.add(d);
      this.confirmChange('移除分支','将移除 '+ids.map(id=>'「'+this.get(id).name+'」').join('、')+' 及其子方向，共 '+deleted.size+' 个方向，并解除这些方向的论文关联。论文与阅读结果仍在论文库中；撤销只恢复导图，不恢复论文关联。',async()=>{const doc=this.draft();doc.nodes=doc.nodes.filter(n=>!deleted.has(n.id));C.cleanAnnotations(doc);const ok=await this.commit(doc);if(ok){selection.clear();this.draw();}return ok;},'确认移除');
    }
    search(){const query=$('#map-search').value.trim().toLocaleLowerCase();this.matches=query?this.doc.nodes.filter(n=>(n.name+' '+n.remark).toLocaleLowerCase().includes(query)).map(n=>n.id):[];this.matchIndex=-1;$('#map-search-count').textContent=query?(this.matches.length+' 项'):'';if(!this.inline)this.draw();}
    findNext(){if(!this.matches.length)return;this.matchIndex=(this.matchIndex+1)%this.matches.length;selection=new Set([this.matches[this.matchIndex]]);this.annotation=null;this.reveal(this.matches[this.matchIndex]);$('#map-search-count').textContent=(this.matchIndex+1)+' / '+this.matches.length;}
    key(e){
      if(this.closed||this.host.view()!=='map'||$('#modal').open||e.isComposing)return;
      const editable=e.target.closest('input,textarea,select,[contenteditable="true"]');
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&!editable){e.preventDefault();$('#map-search').focus();return;}
      if(editable)return;
      if(e.key==='Escape'){if(this.gesture){this.cancelGesture();return;}if(this.linking){this.linking=null;this.updateCaption();return;}selection.clear();this.annotation=null;$('#map-more').hidden=true;this.draw();return;}
      if(!mode||this.busy)return;
      const key=e.key.toLowerCase(),ctrl=e.ctrlKey||e.metaKey;
      if(ctrl){const command={z:e.shiftKey?'redo':'undo',y:'redo',c:'copy',x:'cut',v:'paste'}[key];if(command){e.preventDefault();this.command(command);return;}if(key==='a'){e.preventDefault();selection=new Set(this.layout.positions.map(p=>p.node.id));this.paintSelection();return;}}
      const id=this.selected()[0];if(!id)return;
      const command={F2:'rename',Tab:'child',Enter:'sibling',Delete:'delete',Backspace:'delete',' ':'collapse'}[e.key];if(command){e.preventDefault();this.command(command);return;}
      if(e.key.startsWith('Arrow')){e.preventDefault();const n=this.get(id),siblings=this.doc.nodes.filter(x=>x.parent_id===n.parent_id),index=siblings.findIndex(x=>x.id===id);let next;
        if(e.key==='ArrowLeft')next=n.parent_id;if(e.key==='ArrowRight'){this.collapsed.delete(id);next=this.doc.nodes.find(x=>x.parent_id===id)?.id;}if(e.key==='ArrowUp')next=siblings[Math.max(0,index-1)]?.id;if(e.key==='ArrowDown')next=siblings[Math.min(siblings.length-1,index+1)]?.id;if(next){selection=new Set([next]);this.reveal(next);}}
    }
    pointerDown(e){
      if(e.button!==0||this.busy||this.inline||e.target.closest('.map-editor-strip,.node-tools,.map-editor-popover,.canvas-tools,input,textarea,a,[data-fold]'))return;
      e.preventDefault();
      const r=this.canvas.getBoundingClientRect(),point={x:e.clientX-r.x,y:e.clientY-r.y};
      const handle=e.target.closest('[data-curve]');if(handle){this.gesture={kind:'curve',id:handle.dataset.curve,start:point,curve:this.doc.annotations.find(a=>a.id===handle.dataset.curve).curve};this.canvas.setPointerCapture(e.pointerId);return;}
      const n=e.target.closest('[data-map-id]');
      if(n&&mode){if(e.ctrlKey||e.metaKey)return;this.gesture={kind:'node',id:n.dataset.mapId,start:point,active:false,ids:selection.has(n.dataset.mapId)?this.selected():[n.dataset.mapId]};return;}
      if(e.target.closest('[data-annotation]'))return;
      this.gesture={kind:mode&&e.shiftKey?'box':'pan',start:point,base:{...camera},selected:new Set(selection),ctrl:e.ctrlKey||e.metaKey};if(!n)this.canvas.setPointerCapture(e.pointerId);
    }
    pointerMove(e){
      if(!this.gesture)return;
      this.pendingPointer={clientX:e.clientX,clientY:e.clientY,pointerId:e.pointerId};
      if(!this.pointerFrame)this.pointerFrame=requestAnimationFrame(()=>{this.pointerFrame=0;const last=this.pendingPointer;this.pendingPointer=null;if(last)this.moveGesture(last);});
    }
    moveGesture(e){
      const g=this.gesture;if(!g)return;const r=this.canvas.getBoundingClientRect(),x=e.clientX-r.x,y=e.clientY-r.y,dx=x-g.start.x,dy=y-g.start.y;
      if(g.kind==='pan'){if(!g.active&&Math.hypot(dx,dy)<=4)return;if(!g.active){g.active=true;this.canvas.setPointerCapture(e.pointerId);}camera.x=g.base.x+dx;camera.y=g.base.y+dy;this.canvas.classList.add('dragging');this.applyCamera();}
      if(g.kind==='box'){
        g.active=true;const b=$('#map-selection-box'),left=Math.min(g.start.x,x),top=Math.min(g.start.y,y),right=Math.max(g.start.x,x),bottom=Math.max(g.start.y,y);b.hidden=false;b.style.cssText='left:'+left+'px;top:'+top+'px;width:'+(right-left)+'px;height:'+(bottom-top)+'px';selection=g.ctrl?new Set(g.selected):new Set();
        for(const p of this.layout.positions){const px=camera.x+p.x*camera.z,py=camera.y+p.y*camera.z;if(px<right&&px+p.width*camera.z>left&&py<bottom&&py+p.height*camera.z>top)selection.add(p.node.id);}this.paintSelection();
      }
      if(g.kind==='node'){
        if(!g.active&&Math.hypot(dx,dy)<7)return;
        if(!g.active){g.active=true;selection=new Set(g.ids);this.paintSelection();this.canvas.setPointerCapture(e.pointerId);}
        const stageX=(x-camera.x)/camera.z,stageY=(y-camera.y)/camera.z;
        const p=this.layout.positions.find(p=>stageX>=p.x&&stageX<=p.x+p.width&&stageY>=p.y&&stageY<=p.y+p.height);
        g.target=p?.node.id;g.mode=p?(stageY<p.y+p.height*.24?'before':stageY>p.y+p.height*.76?'after':'inside'):'inside';
        let valid=g.valid;if(g.lastTarget!==g.target||g.lastMode!==g.mode){valid=false;if(p){try{C.move(this.draft(),g.ids,g.target,g.mode);valid=true;}catch{}}g.lastTarget=g.target;g.lastMode=g.mode;}
        g.valid=valid;for(const el of $$('[data-map-id]')){el.classList.toggle('map-drag-source',g.ids.includes(el.dataset.mapId));el.classList.toggle('map-drop-target',valid&&el.dataset.mapId===g.target);el.dataset.dropMode=valid&&el.dataset.mapId===g.target?g.mode:'';}
        const hint=$('#map-drop-hint');hint.hidden=false;hint.textContent=valid?({inside:'放入此方向',before:'放在此方向之前',after:'放在此方向之后'})[g.mode]:'拖到其他方向：中部放入，上下边缘排序';hint.style.left=Math.max(8,Math.min(this.canvas.clientWidth-300,x+15))+'px';hint.style.top=Math.min(this.canvas.clientHeight-60,y+20)+'px';
      }
      if(g.kind==='curve'){
        g.active=true;const a=this.layout.annotations.find(a=>a.id===g.id),model=this.doc.annotations.find(a=>a.id===g.id);if(!a||!model)return;
        model.curve=Math.max(-800,Math.min(800,g.curve+(dx*a.nx+dy*a.ny)/camera.z));this.draw();
      }
    }
    async pointerUp(e){if(this.pointerFrame){cancelAnimationFrame(this.pointerFrame);this.pointerFrame=0;}if(this.pendingPointer){this.moveGesture(this.pendingPointer);this.pendingPointer=null;}const g=this.gesture;if(!g)return;this.gesture=null;if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);this.clearGestureStyles();this.tools();this.suppressClick=!!g.active;
      if(g.kind==='node'&&g.active&&g.valid){try{this.moveBranches(g.ids,g.target,g.mode);}catch(e){this.host.error(e);}}
      if(g.kind==='curve'&&g.active){const doc=this.draft();this.doc.annotations.find(a=>a.id===g.id).curve=g.curve;if(!await this.commit(doc))this.draw();}
    }
    clearGestureStyles(){this.canvas?.classList.remove('dragging');const b=$('#map-selection-box'),hint=$('#map-drop-hint');if(b)b.hidden=true;if(hint)hint.hidden=true;for(const e of $$('[data-map-id]'))e.classList.remove('map-drag-source','map-drop-target');}
    cancelGesture(){if(this.pointerFrame)cancelAnimationFrame(this.pointerFrame);this.pointerFrame=0;this.pendingPointer=null;const g=this.gesture;if(g?.kind==='curve'){const a=this.doc.annotations.find(a=>a.id===g.id);if(a)a.curve=g.curve;}this.gesture=null;this.clearGestureStyles();}
    help(){this.host.modal('导图编辑操作','<div class="map-editor-help"><p>点击顶栏“编辑地图”后使用以下操作。</p>'+[['双击 / F2','原位修改方向名称；Shift+Enter 换行，Enter 保存'],['Tab / Enter','新建子方向 / 同级方向'],['Ctrl + 点击 / Shift + 拖拽空白处','多选 / 框选'],['拖拽方向','中部放入，上下边缘调整同级顺序'],['Ctrl + C / X / V','复制 / 剪切 / 粘贴分支（不复制论文）'],['Ctrl + Z / Y','撤销 / 重做，保留最近50步'],['方向键','选择父方向、子方向或同级方向'],['Space / Esc','折叠展开 / 取消选择或连线'],['Ctrl + F','查找名称和备注，自动展开定位'],['备注 / 概要 / 联系','选中节点后使用浮动工具条；更多中可设置样式与分组']].map(([key,label])=>'<div><kbd>'+key+'</kbd><span>'+label+'</span></div>').join('')+'</div>');}
  }
  scope.MapEditor={mount(host){current?.destroy();current=new Editor(host);},destroy(){current?.destroy();current=null;},draw(doc){current?.sync(doc);},fit(){current?.fit();},flush(){return current?.flush()??Promise.resolve(true);},get busy(){return !!(current?.busy||current?.gesture);}};
})(globalThis);
