"""Task lifecycle retained for the current server run."""
import json
import datetime as dt

def initialize(c,when):
    c.execute('''CREATE TABLE IF NOT EXISTS task_history(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,node_id TEXT,paper_id TEXT,status TEXT NOT NULL,stage TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,details TEXT NOT NULL DEFAULT '{}',error_id TEXT,resolved INTEGER NOT NULL DEFAULT 0)''')
    c.execute("UPDATE task_history SET status='interrupted',stage='服务重启，任务中断，可重新发起',finished_at=? WHERE status='running'",(when,))

def begin_session(s):
    """Called only when a new server owns the port, before starting any jobs."""
    with s.LOCK:
        if s.TASK_CONTROLS or any(item['status']=='running' for item in s.TASKS.values()):
            raise RuntimeError('仍有运行中的任务，不能开始新的任务周期')
        with s.connect() as c:
            c.execute('DELETE FROM task_history')
            c.execute('DELETE FROM app_errors')
            # PDF bytes are not retained: a stopped worker cannot resume a pending check.
            for row in c.execute('SELECT paper_id,reading_coverage FROM paper_documents').fetchall():
                coverage=json.loads(row['reading_coverage']);changed=False
                online=coverage.get('online_verification',{})
                if online.get('status')=='pending':
                    online.update(status='interrupted',label='服务重启，联网核实未完成；已有资料保留');changed=True
                reference=coverage.get('reference_verification',{})
                if reference.get('status')=='pending' or reference.get('processing'):
                    reference.update(status='disabled' if reference.get('status')=='disabled' else 'failed',processing=False,interrupted_before_commit=True,reason='服务重启，参考文献处理未完成；已完成正文评分保留');changed=True
                if changed:
                    c.execute('UPDATE paper_documents SET reading_coverage=? WHERE paper_id=?',(json.dumps(coverage,ensure_ascii=False),row['paper_id']))
                    for research in c.execute('SELECT node_id,analysis FROM paper_research WHERE paper_id=?',(row['paper_id'],)).fetchall():
                        analysis=json.loads(research['analysis'] or '{}');analysis['reading_coverage']=coverage
                        if reference:analysis['reference_verification']=reference
                        c.execute('UPDATE paper_research SET analysis=? WHERE paper_id=? AND node_id=?',(json.dumps(analysis,ensure_ascii=False),row['paper_id'],research['node_id']))
        s.TASKS.clear()
        s.TASK_CONTROLS.clear()
        s.ACTIVE.clear()
        s.REFRESHING.clear()

def start(s,kind,task_id=None,stage='准备执行'):
    task_id=task_id or s.uid();title,nid,pid=s.task_title(kind)
    s.execute("INSERT OR IGNORE INTO task_history(id,kind,title,node_id,paper_id,status,stage,started_at) VALUES (?,?,?,?,?,'running',?,?)",(task_id,kind,title,nid,pid,stage,s.now()))
    return task_id

def finish(s,task_id,status,details,error_id=None):
    stage={'done':'已完成','warning':details.get('result',{}).get('warning') or '已完成，部分资料或交叉核验待补充','error':'执行失败','interrupted':'任务中断'}[status]
    s.execute('UPDATE task_history SET status=?,stage=?,finished_at=?,details=?,error_id=?,resolved=? WHERE id=?',(status,stage,s.now(),json.dumps(details,ensure_ascii=False),error_id,int(status=='done'),task_id))

def records(s,status='',offset=0,limit=100):
    items=s.rows('SELECT * FROM task_history ORDER BY started_at DESC')
    linked={x['error_id'] for x in items if x['error_id']}
    for item in items:item['details']=json.loads(item['details'])
    for error in s.error_records():
        if error['id'] in linked:continue
        items.append(dict(id=error['id'],kind='legacy',title=error['operation'],node_id=error['node_id'],paper_id=error['paper_id'],status='warning' if '部分来源' in error['operation'] else 'error',stage=error['message'],started_at=error['created_at'],finished_at=error['created_at'],details={'legacy':error['details']},resolved=error['resolved'],legacy=True))
    items.sort(key=lambda x:x['started_at'],reverse=True)
    current=dt.datetime.fromisoformat(s.now())
    for item in items:
        try:
            end=dt.datetime.fromisoformat(item['finished_at']) if item.get('finished_at') else current
            item['elapsed_seconds']=max(0,(end-dt.datetime.fromisoformat(item['started_at'])).total_seconds())
        except (ValueError,TypeError):item['elapsed_seconds']=None
    if status=='attention':items=[x for x in items if not x['resolved'] and x['status'] in ('warning','error','interrupted')]
    elif status:items=[x for x in items if x['status']==status]
    return dict(items=items[offset:offset+limit],total=len(items),offset=offset,limit=limit)

def cancel(s,task_id):
    with s.LOCK:
        control=s.TASK_CONTROLS.get(task_id)
        if not control:
            if s.rows('SELECT id FROM task_history WHERE id=?',(task_id,)):return
            raise ValueError('任务不存在或已结束')
        record=s.rows('SELECT status FROM task_history WHERE id=?',(task_id,))
        if not record or record[0]['status']!='running':return
        control.cancel()
        s.execute("UPDATE task_history SET stage='正在中断，停止后续处理' WHERE id=? AND status='running'",(task_id,))
        s.cancel_queued_pdf(task_id)

def clear(s):
    # Keep worker bookkeeping until each worker exits; cleared records stay deleted.
    with s.LOCK:
        for control in s.TASK_CONTROLS.values():control.cleared=True;control.cancel()
        for task_id in list(s.TASKS):
            if task_id not in s.TASK_CONTROLS:s.TASKS.pop(task_id,None)
        with s.connect() as c:
            c.execute('DELETE FROM task_history')
            c.execute('DELETE FROM app_errors')
        for task_id in list(s.PDF_QUEUE):s.cancel_queued_pdf(task_id)

def resolve(s,task_id=None,all_tasks=False,resolved=True):
    if all_tasks:
        s.execute("UPDATE task_history SET resolved=1 WHERE status!='running'")
        s.execute('UPDATE app_errors SET resolved=1 WHERE resolved=0');return
    item=s.rows('SELECT * FROM task_history WHERE id=?',(task_id,))
    if item:
        if item[0]['status']=='running':raise ValueError('运行中的任务不能标记为已处理')
        s.execute('UPDATE task_history SET resolved=? WHERE id=?',(int(resolved),task_id))
        if item[0]['error_id']:s.execute('UPDATE app_errors SET resolved=? WHERE id=?',(int(resolved),item[0]['error_id']))
        return
    error=next((x for x in s.error_records() if x['id']==task_id),None)
    if not error:raise ValueError('任务不存在')
    members=error.get('members') or [error['id']]
    with s.connect() as c:c.executemany('UPDATE app_errors SET resolved=? WHERE id=?',[(int(resolved),x) for x in members])
