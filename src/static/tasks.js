(function(scope){
  'use strict';
  const labels={running:'进行中',done:'已完成',warning:'警告',error:'失败',interrupted:'已中断'};
  let filter='',offset=0,version=0,loading=false,open=new Set(),host,fingerprint='',panel,trigger,closeTimer,pointerInside=false;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mount(options){
    host=options;panel=document.querySelector('#task-popover');trigger=document.querySelector('#task-trigger');
    const button=document.querySelector('#activity');let suppressFocus=false;
    const cancelClose=()=>clearTimeout(closeTimer);
    const scheduleClose=()=>{cancelClose();closeTimer=setTimeout(()=>{if(!pointerInside&&!panel.contains(document.activeElement)&&!trigger.contains(document.activeElement))hide();},180);};
    for(const el of [trigger,panel]){
      el.addEventListener('pointerenter',()=>{pointerInside=true;cancelClose();show();});
      el.addEventListener('pointerleave',()=>{pointerInside=false;scheduleClose();});
      el.addEventListener('focusin',()=>{if(!suppressFocus){cancelClose();show();}});
      el.addEventListener('focusout',()=>setTimeout(()=>{if(!panel.contains(document.activeElement)&&!trigger.contains(document.activeElement))scheduleClose();},0));
    }
    button.onclick=()=>show();
    document.addEventListener('pointerdown',event=>{if(!trigger.contains(event.target)&&!panel.contains(event.target))hide();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();hide();suppressFocus=true;button.focus({preventScroll:true});suppressFocus=false;}});
    window.addEventListener('resize',position);
  }
  function position(){
    if(!panel||panel.hidden)return;
    const anchor=trigger.getBoundingClientRect(),top=Math.min(anchor.bottom+8,innerHeight-100);
    Object.assign(panel.style,{top:top+'px',right:Math.max(12,innerWidth-anchor.right)+'px',maxHeight:Math.max(80,innerHeight-top-12)+'px'});
  }
  function show(){
    if(!panel)return;
    clearTimeout(closeTimer);
    if(!panel.hidden)return;
    panel.hidden=false;document.querySelector('#activity').setAttribute('aria-expanded','true');
    position();fingerprint='';render(true);
  }
  function hide(){
    if(!panel)return;
    clearTimeout(closeTimer);panel.hidden=true;document.querySelector('#activity').setAttribute('aria-expanded','false');
    ++version;loading=false;
  }
  async function render(initial=false){
    if(!host||panel.hidden||loading&&!initial)return;
    const token=++version;loading=true;
    try{
      const data=await host.api('/api/tasks?limit=40&offset='+offset+'&status='+encodeURIComponent(filter));
      if(token!==version||panel.hidden)return;
      const nextFingerprint=JSON.stringify(data);
      if(!initial&&fingerprint===nextFingerprint)return;
      fingerprint=nextFingerprint;
      const old=panel.querySelector('.task-list');if(old)open=new Set([...old.querySelectorAll('details[open]')].map(x=>x.dataset.task));
      const scroll=old?.scrollTop||0;
      panel.innerHTML='<section class="task-center"><header class="task-heading"><strong>任务中心</strong><select id="task-filter" aria-label="任务筛选">'+[['','本次启动'],['running','进行中'],['attention','待处理'],['done','已完成'],['warning','部分完成'],['error','失败'],['interrupted','已中断']].map(([value,label])=>'<option value="'+value+'" '+(value===filter?'selected':'')+'>'+label+'</option>').join('')+'</select><button id="tasks-close" aria-label="关闭任务浮窗">×</button></header><div class="task-popover-actions"><button id="tasks-resolve-all">一键标记已处理</button><button id="tasks-clear" class="danger">一键清空</button><button id="tasks-refresh">刷新</button></div><div class="task-list">'+(data.items.length?data.items.map(row).join(''):'<p class="task-empty">此分类暂无任务记录。</p>')+'</div><footer class="task-pagination"><button id="tasks-prev" '+(!offset?'disabled':'')+'>上一页</button><span>共 '+data.total+' 条 · '+(Math.floor(offset/40)+1)+' / '+Math.max(1,Math.ceil(data.total/40))+'</span><button id="tasks-next" '+(offset+40>=data.total?'disabled':'')+'>下一页</button></footer></section>';
      panel.querySelector('#tasks-close').onclick=hide;
      document.querySelector('.task-list').scrollTop=scroll;
      document.querySelector('#task-filter').onchange=e=>{filter=e.target.value;offset=0;render(true);};
      document.querySelector('#tasks-prev').onclick=()=>{offset=Math.max(0,offset-40);render(true);};
      document.querySelector('#tasks-next').onclick=()=>{offset+=40;render(true);};
      document.querySelector('#tasks-refresh').onclick=()=>render(true);
      document.querySelector('#tasks-resolve-all').onclick=async()=>{try{await host.api('/api/tasks/resolve',{all:true});await host.updated();render(true);}catch(e){host.error(e);}};
      document.querySelector('#tasks-clear').onclick=async()=>{if(!confirm('清空本次全部任务和错误记录，并中断运行中的任务？已入库论文、用量和设置会保留。'))return;try{await host.api('/api/tasks/clear',{});offset=0;open.clear();await host.updated();render(true);}catch(e){host.error(e);}};
      document.querySelectorAll('[data-task-cancel]').forEach(button=>button.onclick=async()=>{if(!confirm('中断此任务？已入库论文会保留；供应商可能仍对已发送请求计费。'))return;button.disabled=true;try{await host.api('/api/tasks/cancel',{id:button.dataset.taskCancel});await host.updated();render(true);}catch(e){button.disabled=false;host.error(e);}});
      document.querySelectorAll('[data-task-resolve]').forEach(button=>button.onclick=async()=>{try{await host.api('/api/tasks/resolve',{id:button.dataset.taskResolve,resolved:button.dataset.resolved==='true'});await host.updated();render(true);}catch(e){host.error(e);}});
    }catch(e){host.error(e);}finally{if(token===version)loading=false;}
  }
  function row(item){
    const details=item.details||{},diagnostics=(details.errors||[]).map(x=>x.source+'：'+x.message+(x.details?'\n'+x.details:'')).join('\n\n');
    const resultNames={added:'新增推荐',candidates:'核验候选',papers:'处理论文',warnings:'待补充论文',warning:'提示',no_new:'本次无新论文',verified:'确认引用关系',assessed:'完成评估',skipped:'跳过重复检查',ok:'执行结果',reading_method:'实际阅读方式',fallback_reason:'本地回退原因',references:'参考文献',score:'评分',pdf_saved:'是否保存 PDF'};
    const results=Object.entries(details.result||{}).map(([key,value])=>(resultNames[key]||key)+'：'+value).join(' · ');
    const stages=(details.stages||[]).map(x=>new Date(x.started_at).toLocaleTimeString('zh-CN',{hour12:false})+' · '+x.name).join('\n');
    const calls=(details.model_calls||[]).map(x=>x.purpose+' · '+x.elapsed_seconds+'秒 · '+x.status+(x.reasoning_mode?' · '+x.reasoning_mode:'')+' · 输出 '+(x.output_tokens??'未知')+' · 实际推理 '+(x.reasoning_tokens??'未知')+' token'+(x.reasoning_mode?.includes('effort=none')&&x.reasoning_tokens>0?'（接口仍返回推理用量）':'')).join('\n');
    const check=details.reference_verification;
    const referenceDetails=check?[(check.status==='disabled'?'参考文献本地核验：本次已关闭，未执行题名匹配':'参考文献本地核验：'+check.matched+' / '+check.total+' 条题名匹配 · '+(check.reason||'已通过')+'；基于本地解析文字，结果仅供参考'),...(check.failed_items||[]).map(x=>'参考文献未通过 #'+x.ordinal+' · 第 '+(x.page||x.source_page||'未知')+' 页 · '+(x.title||'题名缺失')+'\n原因：'+x.reason+'\n条目：'+(x.raw||'')),...(check.filtered_items||[]).map(x=>'参考条目清理 · '+(x.title||'无题名残片')+' · '+x.reason+(x.raw?'\n条目：'+x.raw:'')),...(check.failed_batches||[]).map(x=>'参考文献 API 分片 '+x.batch+'：'+x.message)].join('\n\n'):'';
    const content=[item.kind,results,referenceDetails,stages?'任务阶段：\n'+stages:'',calls?'模型调用耗时：\n'+calls:'',details.legacy,diagnostics,details.failure?'任务原因：'+details.failure:'',details.omitted?'另有 '+details.omitted+' 条补充诊断。':''].filter(Boolean).join('\n\n');
    const seconds=Math.floor(item.elapsed_seconds||0),duration=(seconds>=3600?Math.floor(seconds/3600)+'时 ':'')+(seconds>=60?Math.floor(seconds%3600/60)+'分 ':'')+(seconds%60)+'秒';
    return '<article class="task-row" data-status="'+esc(item.status)+'"><div class="task-row-header"><strong>'+esc(item.title)+'</strong><span class="task-status '+esc(item.status)+'">'+esc(labels[item.status]||item.status)+'</span><time>'+esc(new Date(item.started_at).toLocaleString('zh-CN',{hour12:false}))+'</time><span class="task-duration">耗时 '+duration+'</span>'+(item.resolved?'<span class="subtle">已处理</span>':'')+'</div><p>'+esc(item.stage)+'</p><details data-task="'+esc(item.id)+'" '+(open.has(item.id)?'open':'')+'><summary>任务与来源详情</summary><pre>'+esc(content||'任务已完成，没有来源错误。')+'</pre>'+(item.finished_at?'<small>结束：'+esc(new Date(item.finished_at).toLocaleString('zh-CN',{hour12:false}))+'</small>':'')+'</details>'+(item.status==='running'?'<button data-task-cancel="'+esc(item.id)+'" class="danger">中断任务</button>':item.status!=='done'?'<button data-task-resolve="'+esc(item.id)+'" data-resolved="'+(!item.resolved)+'">'+(item.resolved?'重新打开':'标为已处理')+'</button>':'')+'</article>';
  }
  scope.TaskCenter={mount,show,hide,refresh:()=>render(),get isOpen(){return !!panel&&!panel.hidden;}};
})(globalThis);
