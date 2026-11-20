"""Personal ownership is independent of direction memberships."""
import json
import paper_labels

MEMBER_TABLES=('library','paper_research','paper_manual_scores','paper_impact_overrides','paper_importance')

def initialize(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS personal_papers(paper_id TEXT PRIMARY KEY REFERENCES papers(id),added_at TEXT,snapshot TEXT NOT NULL DEFAULT '{}');
CREATE TRIGGER IF NOT EXISTS personal_library_insert AFTER INSERT ON library BEGIN
 INSERT OR IGNORE INTO personal_papers(paper_id,added_at) VALUES(NEW.paper_id,NEW.added_at);
END;''')
    c.execute('INSERT OR IGNORE INTO personal_papers(paper_id,added_at) SELECT paper_id,min(added_at) FROM library GROUP BY paper_id')
    c.execute('INSERT OR IGNORE INTO personal_papers(paper_id,added_at) SELECT paper_id,created_at FROM paper_documents')

def remember(c,pid):
    """Archive node-scoped personal data before the last membership is removed."""
    old=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
    snapshot=json.loads(old['snapshot'] or '{}') if old else {}
    snapshot.update({table:[{**dict(row),'node_id':''} for row in c.execute('SELECT * FROM '+table+' WHERE paper_id=?',(pid,))] for table in MEMBER_TABLES})
    if snapshot['library']:
        c.execute('UPDATE personal_papers SET snapshot=? WHERE paper_id=?',(json.dumps(snapshot,ensure_ascii=False),pid))

def strip_snapshot_directions(c):
    for row in c.execute("SELECT paper_id,snapshot FROM personal_papers WHERE snapshot<>'{}'").fetchall():
        snapshot=json.loads(row['snapshot'])
        changed=False
        for table in MEMBER_TABLES:
            for item in snapshot.get(table,[]):
                if item.get('node_id'):
                    item['node_id']=''
                    changed=True
        if changed:c.execute('UPDATE personal_papers SET snapshot=? WHERE paper_id=?',(json.dumps(snapshot,ensure_ascii=False),row['paper_id']))

def remove_membership(c,pid,nid):
    if c.execute('SELECT count(*) FROM library WHERE paper_id=?',(pid,)).fetchone()[0]==1:remember(c,pid)
    c.execute('DELETE FROM library WHERE node_id=? AND paper_id=?',(nid,pid))

def purge_record(c,pid,replacement=None):
    """Delete all parent dependencies; incoming raw bibliography belongs to its author."""
    if replacement:
        source=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
        target=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(replacement,)).fetchone()
        remark=json.loads(source['snapshot']).get('remark') if source else None
        if remark and target:
            snapshot=json.loads(target['snapshot'])
            if not snapshot.get('remark'):
                snapshot['remark']=remark
                c.execute('UPDATE personal_papers SET snapshot=? WHERE paper_id=?',(json.dumps(snapshot,ensure_ascii=False),replacement))
    for table in ('task_history','app_errors'):
        if replacement:c.execute('UPDATE '+table+' SET paper_id=? WHERE paper_id=?',(replacement,pid))
        else:
            c.execute('DELETE FROM '+table+' WHERE paper_id=? OR details LIKE ?',(pid,'%'+pid+'%'))
    # Inspect actual schema so a newly added FK cannot silently break deletion again.
    tables=[row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for table in tables:
        if not table.replace('_','').isalnum():continue
        columns={fk[3] for fk in c.execute('PRAGMA foreign_key_list("'+table+'")') if fk[2]=='papers'}
        for column in columns:c.execute('DELETE FROM "'+table+'" WHERE "'+column+'"=?',(pid,))
    c.execute('DELETE FROM papers WHERE id=?',(pid,))

def detail(s,pid):
    with s.connect() as c:
        row=c.execute('SELECT p.*,o.snapshot FROM papers p JOIN personal_papers o ON o.paper_id=p.id WHERE p.id=?',(pid,)).fetchone()
        if not row:raise ValueError('论文不在个人文献库')
        paper=dict(row);saved=json.loads(paper.pop('snapshot') or '{}');members=directions(c,pid)
        paper['remark']=saved.get('remark','')
        reading=best_reading(c,pid)
        if not reading:
            readings=saved.get('paper_research',[])
            reading=next((r for r in readings if r['status']=='complete'),readings[0] if readings else None)
        first=c.execute('SELECT * FROM library WHERE paper_id=? ORDER BY added_at LIMIT 1',(pid,)).fetchone()
        first=dict(first) if first else next(iter(saved.get('library',[])),{})
        paper.update({key:first.get(key,'') for key in ('tag','notes','summary','summary_kind','added_at')})
        paper.update(directions=members,primary_node=members[0]['id'] if members else None,research_status=reading['status'] if reading else None,ai_score=reading['score'] if reading else None,ai_summary=reading['summary'] if reading else '',research_analysis=json.loads(reading['analysis'] or '{}') if reading else {},research_sources=json.loads(reading['sources'] or '[]') if reading else [],research_error=reading['error'] if reading else '',research_completed_at=reading['completed_at'] if reading else None)
        manual=c.execute('SELECT score FROM paper_manual_scores WHERE paper_id=? ORDER BY updated_at DESC LIMIT 1',(pid,)).fetchone()
        paper['manual_score']=manual['score'] if manual else next(iter(saved.get('paper_manual_scores',[])),{}).get('score')
        doc=c.execute('SELECT page_count,methods,metadata_evidence,reading_coverage,created_at FROM paper_documents WHERE paper_id=?',(pid,)).fetchone()
        paper['pdf_document']=dict(doc) if doc else None
        if doc:
            for key in ('methods','metadata_evidence','reading_coverage'):paper['pdf_document'][key]=json.loads(doc[key])
            import paper_web
            paper_web.attach_article(paper)
        override=saved.get('publication_override')
        if override:
            if not paper['pdf_document']:paper['pdf_document']=dict(page_count=0,methods=[],metadata_evidence=[],reading_coverage={})
            paper['pdf_document']['reading_coverage']['online_verification']=override
        paper['references']=[dict(r) for r in c.execute('SELECT ordinal,raw,page,doi,arxiv,title,authors,year FROM paper_references WHERE citing_id=? ORDER BY ordinal',(pid,))]
        return paper
def directions(c,pid):
    return [dict(row) for row in c.execute('SELECT n.id,n.name,l.added_at FROM library l JOIN nodes n ON n.id=l.node_id WHERE l.paper_id=? ORDER BY n.name',(pid,))]

def publication_override(c,pid):
    row=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
    return json.loads(row['snapshot'] or '{}').get('publication_override') if row else None

def correct_publication(s,payload):
    import datetime as dt
    import urllib.parse
    pid=str(payload.get('paper_id',''));fields={}
    for key in ('authors','published','venue','url'):
        value=payload.get(key,'')
        if not isinstance(value,str) or len(value)>4000:raise ValueError('发表信息字段格式不正确')
        fields[key]=value.strip()
    if fields['published']:
        try:dt.date.fromisoformat(fields['published'])
        except ValueError:raise ValueError('发表日期请填写 YYYY-MM-DD，未知可留空') from None
    if fields['url']:
        url=urllib.parse.urlsplit(fields['url'])
        if url.scheme not in ('http','https') or not url.hostname or url.username or url.password:raise ValueError('论文链接须为有效的 HTTP(S) 地址')
    with s.LOCK,s.connect() as c:
        row=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
        if not row:raise ValueError('论文不在个人文献库')
        snapshot=json.loads(row['snapshot'] or '{}')
        status=dict(status='manual',label='发表信息已手动矫正',venue=fields['venue'],publication_url=fields['url'],checked_at=s.now(),research_mode='manual',missing_fields=[k for k in ('published','authors','venue') if not fields[k]])
        snapshot['publication_override']=status
        c.execute('UPDATE personal_papers SET snapshot=? WHERE paper_id=?',(json.dumps(snapshot,ensure_ascii=False),pid))
        c.execute('UPDATE papers SET authors=?,published=?,venue=?,url=?,year=CASE WHEN ?<>\'\' THEN CAST(substr(?,1,4) AS INTEGER) ELSE year END WHERE id=?',(fields['authors'],fields['published'],fields['venue'],fields['url'],fields['published'],fields['published'],pid))
        doc=c.execute('SELECT reading_coverage FROM paper_documents WHERE paper_id=?',(pid,)).fetchone()
        if doc:
            coverage=json.loads(doc['reading_coverage']);coverage['online_verification']=status
            c.execute('UPDATE paper_documents SET reading_coverage=? WHERE paper_id=?',(json.dumps(coverage,ensure_ascii=False),pid))
    return dict(ok=True,paper_id=pid)

def annotate(s,payload):
    pid=str(payload.get('paper_id',''));nid=str(payload.get('node_id') or '')
    remark=payload.get('remark','')
    if not isinstance(remark,str) or len(remark)>120 or '\n' in remark or '\r' in remark:raise ValueError('论文备注须为一行，最多 120 字')
    score=payload.get('manual_score')
    if 'manual_score' in payload and score is not None and (type(score) is not int or not 0<=score<=100):raise ValueError('用户评分应为0–100整数')
    with s.LOCK,s.connect() as c:
        row=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
        if not row:raise ValueError('论文不在个人文献库')
        saved=json.loads(row['snapshot'] or '{}')
        member=c.execute('SELECT node_id,tag FROM library WHERE paper_id=?'+(' AND node_id=?' if nid else '')+' LIMIT 1',(pid,nid) if nid else (pid,)).fetchone()
        if nid and not member:raise ValueError('该方向未收录此论文')
        if 'tag' in payload:
            definitions=c.execute("SELECT value FROM settings WHERE key='paper_labels'").fetchone()
            current=member['tag'] if member else next(iter(saved.get('library',[])),{}).get('tag','')
            paper_labels.check_tag(payload['tag'],json.loads(definitions['value']) if definitions else paper_labels.DEFAULTS,current)
        if member:
            nid=member['node_id']
            if 'tag' in payload:c.execute('UPDATE library SET tag=? WHERE paper_id=? AND node_id=?',(payload['tag'],pid,nid))
            if 'manual_score' in payload:
                if score is None:c.execute('DELETE FROM paper_manual_scores WHERE paper_id=? AND node_id=?',(pid,nid))
                else:c.execute('INSERT OR REPLACE INTO paper_manual_scores VALUES (?,?,?,?)',(nid,pid,score,s.now()))
        else:
            members=saved.setdefault('library',[dict(node_id='',paper_id=pid,tag='',notes='',summary='',summary_kind='',added_at=s.now())])
            if 'tag' in payload:
                for item in members:item['tag']=payload['tag']
            if 'manual_score' in payload:saved['paper_manual_scores']=[] if score is None else [dict(node_id='',paper_id=pid,score=score,updated_at=s.now())]
        if 'remark' in payload:
            if remark.strip():saved['remark']=remark.strip()
            else:saved.pop('remark',None)
        if not member or 'remark' in payload:
            c.execute('UPDATE personal_papers SET snapshot=? WHERE paper_id=?',(json.dumps(saved,ensure_ascii=False),pid))
    return dict(ok=True,paper_id=pid)

def best_reading(c,pid):
    reading=c.execute("SELECT * FROM paper_research WHERE paper_id=? ORDER BY CASE WHEN status='complete' THEN 0 WHEN status='reading' THEN 1 ELSE 2 END,completed_at DESC",(pid,)).fetchone()
    if reading:return reading
    owned=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
    entries=json.loads(owned['snapshot']).get('paper_research',[]) if owned else []
    return next((r for r in entries if r['status']=='complete'),entries[0] if entries else None)

def copy_reading(c,pid,target,source=None):
    source=source or best_reading(c,pid)
    if not source:return
    old=c.execute('SELECT status FROM paper_research WHERE paper_id=? AND node_id=?',(pid,target)).fetchone()
    if old and old['status']=='complete':return
    if old and source['status']!='complete' and old['status'] not in ('reading','queued'):return
    columns=('status','score','summary','analysis','sources','error','started_at','completed_at')
    c.execute('INSERT OR REPLACE INTO paper_research(node_id,paper_id,'+','.join(columns)+') VALUES (?,?,?,?,?,?,?,?,?,?)',(target,pid)+tuple(source[k] for k in columns))
    if source['status']=='complete':
        c.execute("UPDATE library SET summary=?,summary_kind='复用已完成的 AI 阅读' WHERE node_id=? AND paper_id=?",(source['summary'],target,pid))

def attach(s,c,pid,target,source_node=None):
    if not c.execute('SELECT 1 FROM nodes WHERE id=?',(target,)).fetchone():raise ValueError('目标方向不存在')
    source=c.execute('SELECT * FROM library WHERE paper_id=?'+(' AND node_id=?' if source_node else '')+' ORDER BY added_at LIMIT 1',(pid,source_node) if source_node else (pid,)).fetchone()
    if not source:
        owned=c.execute('SELECT snapshot FROM personal_papers WHERE paper_id=?',(pid,)).fetchone()
        if not owned:raise ValueError('论文尚未添加到个人文献库')
        saved=json.loads(owned['snapshot']);source=next(iter(saved.get('library',[])),dict(tag='',notes='',summary='',summary_kind='',node_id=''))
        c.execute('INSERT OR IGNORE INTO library(node_id,paper_id,tag,notes,summary,summary_kind,added_at) VALUES (?,?,?,?,?,?,?)',(target,pid,source['tag'],source['notes'],source['summary'],source['summary_kind'],s.now()))
        for table in MEMBER_TABLES[1:]:
            entries=saved.get(table,[])
            entry=next((r for r in entries if r.get('status')=='complete'),entries[0] if entries else None)
            if entry:
                entry={**entry,'node_id':target,'paper_id':pid};columns=list(entry)
                c.execute('INSERT OR IGNORE INTO '+table+'('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',tuple(entry[k] for k in columns))
        return dict(ok=True,paper_id=pid,node_id=target)
    c.execute('INSERT OR IGNORE INTO library(node_id,paper_id,tag,notes,summary,summary_kind,added_at) VALUES (?,?,?,?,?,?,?)',(target,pid,source['tag'],source['notes'],source['summary'],source['summary_kind'],s.now()))
    copy_reading(c,pid,target)
    for table in ('paper_manual_scores','paper_impact_overrides'):
        c.execute('INSERT OR IGNORE INTO '+table+'(node_id,paper_id,score,updated_at) SELECT ?,paper_id,score,updated_at FROM '+table+' WHERE paper_id=? AND node_id=?',(target,pid,source['node_id']))
    return dict(ok=True,paper_id=pid,node_id=target)

def sync_reading(c,pid,source_node):
    source=c.execute('SELECT * FROM paper_research WHERE paper_id=? AND node_id=?',(pid,source_node)).fetchone()
    for row in c.execute('SELECT node_id FROM library WHERE paper_id=? AND node_id<>?',(pid,source_node)).fetchall():copy_reading(c,pid,row['node_id'],source)

def listing(s,query=''):
    with s.connect() as c:
        items=[]
        for paper in c.execute('SELECT p.*,o.snapshot FROM papers p JOIN personal_papers o ON o.paper_id=p.id ORDER BY p.title').fetchall():
            item=dict(paper);item['directions']=directions(c,paper['id']);reading=best_reading(c,paper['id'])
            saved=json.loads(item.pop('snapshot') or '{}')
            item['remark']=saved.get('remark','')
            if not reading:reading=next((r for r in saved.get('paper_research',[]) if r['status']=='complete'),next(iter(saved.get('paper_research',[])),None))
            item['research_status']=reading['status'] if reading else None;item['ai_score']=reading['score'] if reading else None
            item['primary_node']=item['directions'][0]['id'] if item['directions'] else None
            haystack=' '.join(str(item.get(k) or '') for k in ('title','authors','doi','year'))+' '+' '.join(d['name'] for d in item['directions'])
            if not query or query.casefold() in haystack.casefold():items.append(item)
        return dict(papers=items,total=len(items))

def manage(s,payload):
    action=payload.get('action');pid=str(payload.get('paper_id',''))
    if action not in ('attach','move','remove','delete'):raise ValueError('文献管理操作无效')
    with s.LOCK,s.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        memberships=directions(c,pid)
        if not c.execute('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)).fetchone():raise ValueError('论文不在个人文献库')
        active=c.execute("SELECT 1 FROM paper_research WHERE paper_id=? AND status='reading'",(pid,)).fetchone()
        if action in ('move','remove','delete') and active:raise ValueError('论文正在 AI 阅读中，请先在任务中心中断后管理')
        source=str(payload.get('source_node',''));target=str(payload.get('target_node',''))
        if action in ('move','remove') and source not in {x['id'] for x in memberships}:raise ValueError('来源方向未收录此论文')
        if action in ('attach','move'):
            if action=='move' and source!=target and target in {x['id'] for x in memberships}:raise ValueError('目标方向已收录此论文，未移动或覆盖两边的笔记与评分')
            attach(s,c,pid,target,source if action=='move' else None)
            if action=='move' and source!=target:
                for table in ('paper_manual_scores','paper_impact_overrides','paper_importance'):
                    columns=[row[1] for row in c.execute('PRAGMA table_info('+table+')')]
                    extras=[k for k in columns if k not in ('node_id','paper_id')]
                    c.execute('INSERT OR IGNORE INTO '+table+'(node_id,paper_id,'+','.join(extras)+') SELECT ?,paper_id,'+','.join(extras)+' FROM '+table+' WHERE node_id=? AND paper_id=?',(target,source,pid))
                c.execute('DELETE FROM library WHERE node_id=? AND paper_id=?',(source,pid))
        elif action=='remove':remove_membership(c,pid,source)
        elif action=='delete':
            for task in c.execute('SELECT id FROM task_history WHERE paper_id=?',(pid,)).fetchall():
                control=s.TASK_CONTROLS.get(task['id'])
                if control:control.cleared=True;control.cancel()
                s.TASKS.pop(task['id'],None)
            purge_record(c,pid)
            # Cached finished task results are also an API surface, not just database rows.
            for tid,task in list(s.TASKS.items()):
                if pid in json.dumps(task,ensure_ascii=False):s.TASKS.pop(tid,None)
    return dict(ok=True,paper_id=pid)

def reuse_staged(s,c,nid,staged_pid,target_pid):
    """Transfer a pending membership only after source-verified identity match."""
    pending=c.execute('SELECT * FROM library WHERE node_id=? AND paper_id=?',(nid,staged_pid)).fetchone()
    if not pending:raise ValueError('论文已移除，未重新收录')
    if c.execute("SELECT 1 FROM paper_research WHERE paper_id=? AND status='complete'",(staged_pid,)).fetchone() or c.execute('SELECT 1 FROM paper_references WHERE citing_id=?',(staged_pid,)).fetchone():
        raise ValueError('原记录已有独立核验资料，未自动覆盖或合并，请在论文库核查两条记录')
    for member in c.execute('SELECT * FROM library WHERE paper_id=?',(staged_pid,)).fetchall():
        target_node=member['node_id']
        existing=c.execute('SELECT 1 FROM library WHERE node_id=? AND paper_id=?',(target_node,target_pid)).fetchone()
        if existing and (member['notes'] or member['tag'] or c.execute('SELECT 1 FROM paper_manual_scores WHERE node_id=? AND paper_id=?',(target_node,staged_pid)).fetchone()):
            raise ValueError('同一方向两条记录存在个人资料，未自动合并，请在论文库核查')
        attach(s,c,target_pid,target_node,target_node if existing else None)
        if not existing:
            c.execute('UPDATE library SET tag=?,notes=? WHERE node_id=? AND paper_id=?',(member['tag'],member['notes'],target_node,target_pid))
            for table in ('paper_manual_scores','paper_impact_overrides'):
                c.execute('INSERT OR REPLACE INTO '+table+' SELECT node_id,?,score,updated_at FROM '+table+' WHERE node_id=? AND paper_id=?',(target_pid,target_node,staged_pid))
    c.execute('UPDATE task_history SET paper_id=? WHERE paper_id=?',(target_pid,staged_pid))
    c.execute('DELETE FROM library WHERE paper_id=?',(staged_pid,))
    # Preserve the upload fingerprint as pending provenance when the old paper has no PDF.
    target_doc=c.execute('SELECT 1 FROM paper_documents WHERE paper_id=?',(target_pid,)).fetchone()
    if not target_doc:
        c.execute("INSERT INTO paper_documents SELECT ?,sha256,page_count,methods,metadata_evidence,reading_coverage,created_at FROM paper_documents WHERE paper_id=?",(target_pid,staged_pid))
    if not c.execute('SELECT 1 FROM library WHERE paper_id=?',(staged_pid,)).fetchone():
        purge_record(c,staged_pid,replacement=target_pid)
    return target_pid
