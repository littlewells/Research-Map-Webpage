"""Consistent business snapshots and all-or-nothing replacement; credentials stay local."""
import json
import paper_labels
import remote
import sqlite3

TABLES=('settings','nodes','papers','personal_papers','library','recommendations','paper_metrics','paper_importance','paper_impact_overrides','paper_research','paper_manual_scores','map_node_details','map_editor_document','citation_edges','citation_checks','paper_documents','paper_references','node_recommendation_preferences','recommendation_reads')
EPHEMERAL=('task_history','app_errors','usage','refresh_log')
RECOMMENDATION_TABLES=('recommendations','recommendation_reads')
EXPORT_TABLES=set(TABLES)-set(RECOMMENDATION_TABLES)-{'map_node_details'}
PAPER_KEYS={
    'papers':('id',),'library':('paper_id',),'paper_metrics':('paper_id',),
    'paper_importance':('paper_id',),'paper_impact_overrides':('paper_id',),
    'paper_research':('paper_id',),'paper_manual_scores':('paper_id',),
    'citation_edges':('citing_id','cited_id'),'citation_checks':('paper_id',),
    'paper_documents':('paper_id',),'paper_references':('citing_id',),
}

def ordered(items):
    return sorted(items,key=lambda r:json.dumps(r,ensure_ascii=False,sort_keys=True))

def personal_only(data):
    owned={row['paper_id'] for row in data['personal_papers']}
    return {
        table:[] if table in RECOMMENDATION_TABLES else
        [row for row in rows if all(row[key] in owned for key in PAPER_KEYS.get(table,()))]
        for table,rows in data.items()
    }

def pack(data,version=4):
    data=personal_only(data)
    details={row['node_id']:dict(details=json.loads(row['details'])) for row in data['map_node_details']}
    if version==3:
        for row in data['map_node_details']:details[row['node_id']]['hidden']=row['hidden']
    else:
        data['nodes']=[{k:v for k,v in r.items() if k!='last_refresh'} for r in data['nodes']]
        data['map_editor_document']=[{k:r[k] for k in ('id','revision','annotations')} for r in data['map_editor_document']]
    return {table:ordered([{**row,'map_details':details.get(row['id'])} for row in rows]) if table=='nodes' else rows
            for table,rows in data.items() if table in EXPORT_TABLES}

def unpack(data,version):
    result={**data,'recommendations':[],'recommendation_reads':[],'map_node_details':[],'nodes':[]}
    if version==4:
        if any(set(row)!={'id','revision','annotations'} for row in data['map_editor_document']):
            raise ValueError('备份的导图文档字段无效')
        result['map_editor_document']=[dict(row,history='[]',cursor=0,signature='') for row in data['map_editor_document']]
    for row in data['nodes']:
        fields=dict(row)
        entry=fields.pop('map_details')
        if version==4:
            if 'last_refresh' in fields:raise ValueError('备份不应包含推荐刷新记录')
            fields['last_refresh']=None
        if entry is not None:
            if (not isinstance(entry,dict) or set(entry)!=({'details'} if version==4 else {'hidden','details'}) or
                type(entry.get('hidden',0)) is not int or entry.get('hidden',0) not in (0,1) or not isinstance(entry['details'],dict)):
                raise ValueError('备份的节点详情格式不正确')
            result['map_node_details'].append(dict(node_id=fields['id'],hidden=entry.get('hidden',0),details=json.dumps(entry['details'],ensure_ascii=False)))
        result['nodes'].append(fields)
    return result

def secret_key(key):
    return any(word in str(key).lower() for word in ('api_key','apikey','secret','password','credential','access_token','refresh_token','private_key'))

def snapshot(c):
    out={}
    for table in TABLES:
        items=[dict(row) for row in c.execute('SELECT * FROM '+table)]
        if table=='settings':items=[r for r in items if not secret_key(r['key'])]
        out[table]=ordered(items)
    return out

def export(s):
    with s.LOCK,s.connect() as c:
        c.execute('BEGIN')
        data=pack(snapshot(c))
    return dict(format='research-map',version=4,exported_at=s.now(),data=data)

def replace(c,data):
    c.execute('PRAGMA defer_foreign_keys=ON')
    for table in EPHEMERAL+tuple(reversed(TABLES)):c.execute('DELETE FROM '+table)
    for table in TABLES:
        columns=[row[1] for row in c.execute('PRAGMA table_info('+table+')')]
        for item in data[table]:
            if not isinstance(item,dict) or set(item)!=set(columns):raise ValueError('备份字段不完整或版本不兼容：'+table)
            if any(isinstance(v,(dict,list)) for v in item.values()):raise ValueError('表行字段类型无效：'+table)
            c.execute('INSERT INTO '+table+'('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',tuple(item[k] for k in columns))

def validate(s,payload):
    if not isinstance(payload,dict) or payload.get('format')!='research-map' or payload.get('version') not in (2,3,4):raise ValueError('请使用 Research Map JSON 备份（版本 2、3 或 4）')
    version=payload['version']
    data=payload.get('data')
    if not isinstance(data,dict) or set(data)!=(EXPORT_TABLES if version>=3 else set(TABLES)) or any(not isinstance(v,list) or any(not isinstance(r,dict) for r in v) for v in data.values()):raise ValueError('备份业务表不完整，未恢复任何数据')
    if any(secret_key(r.get('key','')) for r in data['settings'] if isinstance(r,dict)):raise ValueError('备份不得包含密钥或凭据设置')
    memory=sqlite3.connect(':memory:');memory.row_factory=sqlite3.Row
    try:
        expected=data
        if version>=3:
            data=unpack(expected,version)
            if personal_only(data)!=data:raise ValueError('备份包含未收录到个人论文库的资料')
        with s.connect() as source:source.backup(memory)
        memory.execute('PRAGMA foreign_keys=ON');memory.execute('BEGIN')
        replace(memory,data)
        if memory.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('备份存在无效的数据关联，未恢复任何数据')
        cfg={row['key']:json.loads(row['value']) for row in memory.execute('SELECT * FROM settings')}
        if not (set(s.config())-{'paper_labels','network_mode'}).issubset(cfg):raise ValueError('备份设置不完整')
        if 'paper_labels' in cfg:paper_labels.validate(cfg['paper_labels'])
        if cfg.get('network_mode',remote.DEFAULT_MODEL_NETWORK) not in remote.NETWORK_MODES:raise ValueError('备份网络方式无效')
        if not isinstance(cfg.get('base_url'),str) or not isinstance(cfg.get('model'),str):raise ValueError('备份模型设置无效')
        for table,columns in {'personal_papers':('snapshot',),'paper_documents':('methods','metadata_evidence','reading_coverage'),'paper_research':('analysis','sources'),'map_node_details':('details',),'map_editor_document':('annotations','history')}.items():
            for row in memory.execute('SELECT * FROM '+table):
                for column in columns:
                    if row[column]:json.loads(row[column])
        doc=s.map_editor.document(memory)
        roots=[n['id'] for n in doc['nodes'] if n['parent_id'] is None]
        if len(roots)!=1:raise ValueError('备份思维导图根节点无效')
        s.map_editor.validate(doc,roots[0])
        normalized=snapshot(memory)
        restored=pack(normalized,version) if version>=3 else normalized
        if restored!={table:ordered(rows) for table,rows in expected.items()}:raise ValueError('备份无法无损恢复，未修改当前数据')
        s.map_editor.discard_legacy_history(memory)
        memory.execute('UPDATE nodes SET last_refresh=NULL WHERE last_refresh IS NOT NULL')
        normalized=snapshot(memory)
        if memory.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('清理旧记录后存在无效关联，未恢复任何数据')
        if version==4 and pack(normalized)!=restored:raise ValueError('备份包含历史关联，未恢复任何数据')
        memory.commit()
        return personal_only(normalized)
    except (sqlite3.Error,TypeError,KeyError,json.JSONDecodeError) as error:
        raise ValueError('备份校验失败，未修改当前数据：'+str(error)[:180]) from None
    finally:memory.close()

def restore(s,payload):
    with s.LOCK:
        if s.TASK_CONTROLS or s.ACTIVE or any(t.get('status')=='running' for t in s.TASKS.values()):raise ValueError('请先等待或中断全部任务，待任务结束后再恢复备份')
        data=validate(s,payload)
        try:
            with s.connect() as c:
                c.execute('BEGIN IMMEDIATE');replace(c,data)
                if c.execute('PRAGMA foreign_key_check').fetchone() or snapshot(c)!=data:raise ValueError('恢复结果校验不一致，已整体回滚')
        except sqlite3.Error as error:raise ValueError('恢复失败，已整体回滚：'+str(error)[:160]) from None
        s.TASKS.clear();s.REFRESHING.clear();s.map_editor.clear_history()
        return dict(ok=True,tables=len(EXPORT_TABLES),papers=len(data['personal_papers']),message='个人论文库、导图和设置已恢复；本机密钥保留，推荐、任务、错误和 API 用量已清空')
