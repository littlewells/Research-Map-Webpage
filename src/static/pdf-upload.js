(function(scope){
  'use strict';
  function open({nid,paper,tagOptions,modal,close,monitor,updated,error,toast}){
    modal(paper?'重新上传 PDF 阅读':'上传论文 PDF','<form id="pdf-import-form"><p class="notice">PDF 先在本地提取并交叉核对文字，再交给 API 阅读；不发送 PDF 或页面图像。PDF 和完整正文不保存。'+(paper?'须上传同一篇论文，简短备注与人工评分保留。':'最多两篇同时阅读，其余自动排队。')+'</p><label class="field">'+(paper?'论文文件':'论文文件（可多选）')+'<input id="paper-pdf" type="file" accept="application/pdf,.pdf" required'+(paper?'':' multiple')+'></label>'+(paper?'':'<label class="field">论文标签<select id="pdf-tag">'+tagOptions+'</select></label>')+'<p id="pdf-upload-status" aria-live="polite"></p><div class="form-footer"><button class="primary" id="pdf-upload-submit">上传并阅读</button></div></form>');
    const form=document.querySelector('#pdf-import-form');
    const input=form.querySelector('#paper-pdf'),status=form.querySelector('#pdf-upload-status'),button=form.querySelector('#pdf-upload-submit');
    let retry=null;
    input.onchange=()=>{retry=null;button.textContent='上传并阅读';status.textContent='';};
    form.onsubmit=async event=>{
      event.preventDefault();
      if(button.disabled)return;
      const files=retry||Array.from(input.files),failures=[];
      if(!files.length){status.textContent='请选择非空的有效 PDF';return;}
      button.disabled=input.disabled=true;
      try{
        const query=new URLSearchParams({node:nid,tag:form.querySelector('#pdf-tag')?.value||'',replace:paper?.id||''});
        let queued=0;
        for(const [index,file] of files.entries()){
          status.textContent='正在上传 '+(index+1)+' / '+files.length+'：'+file.name;
          try{
            if(!file.size)throw Error('PDF 文件为空');
            const response=await fetch('/api/pdf/import?'+query,{method:'POST',headers:{'Content-Type':'application/pdf','X-ResearchMap':'1'},body:file});
            const task=await response.json();if(!response.ok)throw Error(task.error||'PDF 上传失败');
            if(task.queued)queued++;
            monitor(task,file.name,async result=>{await updated(nid);toast(file.name+'：'+(result.warning||('阅读完成，提取 '+result.references+' 条参考文献')));},async()=>{await updated(nid);});
          }catch(e){failures.push({file,message:file.name+'：'+e.message});}
        }
        const accepted=files.length-failures.length;
        if(accepted)toast('已接收 '+accepted+' 份 PDF'+(queued?'，其中 '+queued+' 份进入队列':''));
        if(failures.length){
          retry=failures.map(x=>x.file);
          button.textContent='重试未上传文件';
          status.textContent=failures.map(x=>x.message).join('；');
          return;
        }
        if(form.isConnected)await close();
        await updated(nid);
      }catch(e){error(e);}
      finally{button.disabled=input.disabled=false;}
    };
  }
  scope.PdfUpload={open};
})(globalThis);
