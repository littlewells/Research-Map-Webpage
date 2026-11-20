"""Citation edges come only from located uploaded bibliography and exact library records."""
import re
import json
import unicodedata
import urllib.parse
from contextlib import nullcontext

def norm(value):return re.sub(r'[^a-z0-9\u4e00-\u9fff]','',unicodedata.normalize('NFKC',str(value or '')).casefold())
def doi(value):
    match=re.search(r'10[.]\d{4,9}/[^\s<>"#?]+',urllib.parse.unquote(value or ''),re.I)
    return match.group(0).rstrip('.,;):]').lower() if match else ''
def aid(value):
    match=re.fullmatch(r'(?:(?:arxiv:)|(?:https?://(?:www[.])?arxiv[.]org/(?:abs|html|pdf)/)|(?:(?:doi:|https?://doi[.]org/)?10[.]48550/arxiv[.]))?(\d{4}[.]\d{4,5})(?:v\d+)?(?:[.]pdf)?',str(value or '').strip(),re.I)
    return match.group(1) if match else ''
def aid_in_text(value):
    match=re.search(r'(?:arxiv[:.]\s*|arxiv[.]org/(?:abs|html|pdf)/)(\d{4}[.]\d{4,5})(?:v\d+)?',value or '',re.I)
    return match.group(1) if match else ''
def keys(p):
    d=doi(p.get('doi') or p.get('identity'));a=aid(p.get('identity')) or aid(p.get('doi')) or aid(p.get('url'))
    return {x for x in ('doi:'+d if d else '', 'arxiv:'+a if a else '') if x}

def first_author(value):
    """Extract the first name line; affiliations and later authors are not surnames."""
    lines=[line.strip() for line in str(value or '').splitlines() if line.strip()]
    if not lines:return ''
    name=re.split(r',|;|\s+and\s+|\s*&\s*',lines[0],maxsplit=1,flags=re.I)[0]
    name=re.split(r'\b(?:university|institute|department|school|laboratory|college|faculty)\b',name,maxsplit=1,flags=re.I)[0]
    name=re.sub(r'[\d*†‡]+','',unicodedata.normalize('NFKC',name)).strip()
    return name if len(re.findall(r'[A-Za-z\u4e00-\u9fff]+',name))>=2 else ''

def author_agrees(author,prefix):
    author=first_author(author)
    if not author:return False
    tokens=re.findall(r'[A-Za-z\u4e00-\u9fff]+(?:[-’\'][A-Za-z\u4e00-\u9fff]+)*',author)
    # A full first author or an initial plus the complete compound family name.
    prefix=re.sub(r'^\s*(?:\[\d+\]|\d+[.)])\s*','',prefix)
    actual=first_author(prefix)
    other=re.findall(r'[A-Za-z\u4e00-\u9fff]+(?:[-’\'][A-Za-z\u4e00-\u9fff]+)*',actual)
    if len(tokens)<2 or len(other)<2:return False
    return norm(tokens[-1])==norm(other[-1]) and len(norm(tokens[-1]))>=3 and tokens[0][0].casefold()==other[0][0].casefold() and (len(tokens[0])==1 or len(other[0])==1 or norm(tokens[0])==norm(other[0]))

def matches(ref,target):
    d=ref.get('doi') or doi(ref['raw']);a=ref.get('arxiv') or aid_in_text(ref['raw']);ids={x for x in ('doi:'+d if d else '', 'arxiv:'+a if a else '') if x}
    if ids:
        return bool(ids.intersection(keys(target)))
    title=norm(ref.get('title'));raw=norm(ref['raw']);target_title=norm(target['title'])
    if not title and len(target_title)>=16 and target_title in raw:title=target_title
    if len(title)<16 or title!=target_title or title not in raw:return False
    year=target.get('year');authors=str(target.get('authors') or '')
    if not year or str(year) not in ref['raw'] or not authors:return False
    # Match the author portion before the exact title, never affiliations or body mentions.
    prefix=ref['raw']
    offset=norm(prefix).find(title)
    if offset<1:return False
    normalized='';end=0
    for end,char in enumerate(prefix):
        normalized+=norm(char)
        if len(normalized)>=offset:break
    return author_agrees(authors,prefix[:end+1])

def rebuild(s,connection=None):
    import task_control
    task_control.check()
    read=lambda sql:[dict(row) for row in connection.execute(sql)] if connection else s.rows(sql)
    papers=read('SELECT DISTINCT p.* FROM papers p JOIN library l ON p.id=l.paper_id')
    references=read('SELECT * FROM paper_references ORDER BY citing_id,ordinal');edges={}
    documents={x['paper_id']:x for x in read('SELECT * FROM paper_documents')}
    for document in documents.values():
        coverage=json.loads(document['reading_coverage']);verification=coverage.get('reference_verification',{})
        if verification.get('status')=='pending' or verification.get('processing') or verification.get('interrupted_before_commit'):verification=coverage.get('previous_reference_verification',verification)
        document['reference_verification']=verification
    for ref in references:
        verification=documents.get(ref['citing_id'],{}).get('reference_verification',{})
        if verification.get('version')==2:
            checked=next((item for item in verification.get('items',[]) if item['ordinal']==ref['ordinal']),{})
            # Title badges are relaxed; graph edges still require located original evidence.
            if checked.get('status') not in ('passed','not_checked') or not checked.get('source_raw_verified'):continue
        for target in papers:
            if target['id']==ref['citing_id'] or not matches(ref,target):continue
            evidence=[dict(source='上传 PDF 参考文献原文',url='',excerpt=ref['raw'],page=ref['page'],checked_at=s.now(),method='PDF 原文定位'),dict(source='已收录论文题录交叉匹配',url=target.get('url',''),excerpt=target['title']+' · '+str(target.get('year') or '年份未知')+' · '+first_author(target.get('authors'))+' · '+(target.get('doi') or target['identity']),checked_at=s.now(),method='精确标识' if ref.get('doi') or ref.get('arxiv') else '完整题名、首作者及年份严格一致')]
            edges[(ref['citing_id'],target['id'])]=evidence
    with nullcontext(connection) if connection else s.connect() as c:
        # Only PDF-derived citing records are replaced; old verified records retain historical provenance.
        for pid in documents:c.execute('DELETE FROM citation_edges WHERE citing_id=?',(pid,))
        for (citing,cited),proof in edges.items():c.execute('INSERT OR REPLACE INTO citation_edges VALUES (?,?,?,?)',(citing,cited,json.dumps(proof,ensure_ascii=False),s.now()))
        for pid in documents:
            count=sum(ref['citing_id']==pid for ref in references)
            c.execute('INSERT OR REPLACE INTO citation_checks VALUES (?,?,?,?)',(pid,s.now(),'complete',json.dumps(dict(extracted_references=count,verified_edges=sum(a==pid for a,b in edges),pending_edges=0,errors=[],scope='上传 PDF 原文与已收录论文严格交叉匹配，无文献库接口'),ensure_ascii=False)))
    return dict(papers=len(documents),verified=len(edges),warnings=0)

def graph(s,nid,related=False):
    membership=s.rows('SELECT l.paper_id,l.node_id,n.name AS node_name FROM library l JOIN nodes n ON n.id=l.node_id WHERE NOT EXISTS(SELECT 1 FROM map_node_details d WHERE d.node_id=n.id AND d.hidden=1)')
    groups={}
    for item in membership:groups.setdefault(item['paper_id'],[]).append(dict(id=item['node_id'],name=item['node_name']))
    own={x['paper_id'] for x in membership if x['node_id']==nid};edges=s.rows('SELECT * FROM citation_edges')
    edges=[e for e in edges if e['citing_id'] in groups and e['cited_id'] in groups]
    selected=set(own)
    if related:
        changed=True
        while changed:
            changed=False
            for edge in edges:
                if edge['citing_id'] in selected or edge['cited_id'] in selected:
                    for pid in (edge['citing_id'],edge['cited_id']):
                        if pid not in selected:selected.add(pid);changed=True
    visible=[e for e in edges if e['citing_id'] in selected and e['cited_id'] in selected]
    boundary=[e for e in edges if (e['citing_id'] in own) != (e['cited_id'] in own)]
    for edge in visible+boundary:
        if isinstance(edge['evidence'],str):edge['evidence']=json.loads(edge['evidence'])
    papers=s.rows('SELECT DISTINCT p.* FROM papers p JOIN library l ON p.id=l.paper_id')
    selected_papers=[dict(p,directions=groups.get(p['id'],[]),local=p['id'] in own) for p in papers if p['id'] in selected]
    checks=s.rows('SELECT * FROM citation_checks')
    checks=[c for c in checks if c['paper_id'] in selected]
    for check in checks:check['details']=json.loads(check['details'])
    return dict(papers=selected_papers,edges=visible,boundary_edges=[] if related else boundary,checks=checks,verified=len(visible),local_ids=sorted(own),scope='related' if related else 'local')
