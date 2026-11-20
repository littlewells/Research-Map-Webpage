"""Only article bibliographies corroborated by independent records create graph edges."""
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

def doi(value):
    match=re.search(r'10[.][0-9]{4,9}/[^\s<>"#?]+',urllib.parse.unquote(value or ''),re.I)
    return match.group(0).rstrip('.,;):]').lower() if match else ''

def aid(value):
    match=re.fullmatch(r'(?:(?:arxiv:)|(?:https?://(?:www[.])?arxiv[.]org/(?:abs|pdf|html)/)|(?:(?:doi:|https?://doi[.]org/)?10[.]48550/arxiv[.]))?([0-9]{4}[.][0-9]{4,5})(?:v[0-9]+)?(?:[.]pdf)?',value or '',re.I)
    return match.group(1).lower() if match else ''

def identifiers(p):
    out=set();d=doi(p.get('doi','') or p.get('identity',''));a=aid(p.get('identity','')) or aid(p.get('url','')) or aid(p.get('doi',''))
    if d:out.add('doi:'+d)
    if a:out.add('arxiv:'+a)
    return out

def extracted(text):
    out=set()
    for item in re.findall(r'10[.][0-9]{4,9}/[^\s<>"#?]+',text,re.I):
        d=doi(item)
        if d:out.add('doi:'+d)
    for item in re.findall(r'(?:arxiv:|arxiv[.]org/(?:abs|pdf|html)/)([0-9]{4}[.][0-9]{4,5})(?:v[0-9]+)?',text,re.I):out.add('arxiv:'+item.lower())
    return out

class BibliographyHTML(HTMLParser):
    def __init__(self):
        super().__init__();self.stack=[];self.blocks=[];self.active=None;self.owner=set();self.watermark_depth=None
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs);classes=attrs.get('class','').split()
        if attrs.get('id')=='watermark-tr':self.watermark_depth=len(self.stack)
        if tag=='a' and self.active is None and attrs.get('title')=='Back to abstract page':
            identifier=aid('https://arxiv.org'+attrs.get('href',''))
            if identifier:self.owner.add('arxiv:'+identifier)
        if tag=='meta':
            name=attrs.get('name','').lower();value=attrs.get('content','')
            if name=='citation_doi' and doi(value):self.owner.add('doi:'+doi(value))
            if name=='citation_arxiv_id' and aid(value):self.owner.add('arxiv:'+aid(value))
            if name=='citation_pdf_url' and aid(value):self.owner.add('arxiv:'+aid(value))
        if tag=='link' and attrs.get('rel')=='canonical' and aid(attrs.get('href','')):self.owner.add('arxiv:'+aid(attrs['href']))
        if 'ltx_bibitem' in classes and self.active is None:self.active=dict(depth=len(self.stack),parts=[],anchor=attrs.get('id',''))
        if self.active is not None:
            for key in ('href','data-doi'):
                if attrs.get(key):self.active['parts'].append(urllib.parse.unquote(attrs[key]))
        if tag not in ('area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'):self.stack.append(tag)
    def handle_endtag(self,tag):
        if tag not in self.stack:return
        position=len(self.stack)-1-self.stack[::-1].index(tag);self.stack=self.stack[:position]
        if self.watermark_depth is not None and len(self.stack)<=self.watermark_depth:self.watermark_depth=None
        if self.active is not None and len(self.stack)<=self.active['depth']:
            self.blocks.append(self.active);self.active=None
    def handle_data(self,text):
        if self.active is not None:self.active['parts'].append(text)
        if self.watermark_depth is not None:
            match=re.search(r'arXiv:([0-9]{4}[.][0-9]{4,5})(?:v[0-9]+)?',text,re.I)
            if match:self.owner.add('arxiv:'+match.group(1))

def html_references(text,p,url,when):
    parser=BibliographyHTML();parser.feed(text);parser.close()
    if not identifiers(p).intersection(parser.owner):raise ValueError('公开 HTML 的论文标识未通过核验')
    if not parser.blocks:raise ValueError('公开 HTML 未提供可提取的参考文献列表')
    out=[]
    for block in parser.blocks:
        raw=' '.join(block['parts']);keys=extracted(raw)
        if keys:out.append(dict(keys=keys,source='arXiv HTML 参考文献',url=url+('#'+block['anchor'] if block['anchor'] else ''),excerpt=' '.join(raw.split())[:1200],checked_at=when))
    return out

def xml_references(raw,p,url,when):
    root=ET.fromstring(raw)
    for element in root.iter():element.tag=element.tag.split('}')[-1]
    owner={'doi:'+doi(x.text or '') for x in root.findall('.//article-meta/article-id') if x.get('pub-id-type')=='doi' and doi(x.text or '')}
    if not identifiers(p).intersection(owner):raise ValueError('公开 XML 的论文标识未通过核验')
    if not root.findall('.//ref-list/ref'):raise ValueError('公开 XML 未提供参考文献列表')
    out=[]
    for ref in root.findall('.//ref-list/ref'):
        raw=' '.join(ref.itertext());keys=extracted(raw)
        for item in ref.iter():
            for value in item.attrib.values():keys.update(extracted(value))
            if item.tag=='pub-id' and item.get('pub-id-type')=='doi' and doi(item.text or ''):keys.add('doi:'+doi(item.text))
        if keys:out.append(dict(keys=keys,source='Europe PMC 正文参考文献',url=url+'#'+ref.get('id','references'),excerpt=' '.join(raw.split())[:1200],checked_at=when))
    return out

def registry_references(s,p):
    identifier=doi(p.get('doi',''));out=[]
    if not identifier:return out
    url='https://api.crossref.org/works/'+urllib.parse.quote(identifier,safe='')
    item=s.request_json(url,timeout=15)['message']
    if doi(item.get('DOI',''))!=identifier:raise ValueError('Crossref 引用来源 DOI 不匹配')
    for ref in item.get('reference',[]):
        key=doi(ref.get('DOI',''));keys={'doi:'+key} if key else extracted(ref.get('unstructured',''))
        if keys:out.append(dict(keys=keys,source='Crossref 出版方参考文献记录',url=url,excerpt=ref.get('unstructured') or ref.get('key') or key,checked_at=s.now()))
    return out

def content_references(s,p):
    refs=[];checked=[];errors=[];a=next((key[6:] for key in identifiers(p) if key.startswith('arxiv:')),'');d=doi(p.get('doi',''))
    if a:
        url='https://arxiv.org/html/'+a
        try:
            raw=s.remote.fetch(url,timeout=25,raw=True).decode('utf-8',errors='replace')
            refs.extend(html_references(raw,p,url,s.now()));checked.append('arXiv HTML')
        except Exception as error:errors.append('arXiv 正文参考文献：'+str(error))
    if d:
        url='https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+urllib.parse.urlencode({'query':'DOI:'+d,'format':'json','resultType':'core','pageSize':3})
        try:
            result=s.request_json(url,timeout=15)
            item=next((x for x in result.get('resultList',{}).get('result',[]) if doi(x.get('doi',''))==d and x.get('isOpenAccess')=='Y' and re.fullmatch('PMC[0-9]+',x.get('pmcid',''))),None)
            if item:
                xml_url='https://www.ebi.ac.uk/europepmc/webservices/rest/'+item['pmcid']+'/fullTextXML'
                refs.extend(xml_references(s.remote.fetch(xml_url,timeout=25,raw=True),p,xml_url,s.now()));checked.append('Europe PMC XML')
        except Exception as error:errors.append('Europe PMC 正文参考文献：'+str(error))
    return refs,checked,errors

def semantic_references(s,p):
    keys=identifiers(p);key=next((x for x in sorted(keys) if x.startswith('doi:')),next(iter(keys),'')).replace('doi:','DOI:').replace('arxiv:','ARXIV:')
    if not key:return []
    url='https://api.semanticscholar.org/graph/v1/paper/'+urllib.parse.quote(key,safe='')+'?fields=externalIds,title,references.externalIds'
    item=s.request_json(url,timeout=15);ids=item.get('externalIds') or {};owner=identifiers(dict(doi=ids.get('DOI') or '',identity='arxiv:'+(ids.get('ArXiv') or '')))
    if not owner.intersection(keys):raise ValueError('Semantic Scholar 来源标识不匹配')
    out=[]
    for ref in item.get('references') or []:
        ids=ref.get('externalIds') or {};matched=identifiers(dict(doi=ids.get('DOI') or '',identity='arxiv:'+(ids.get('ArXiv') or '')))
        if matched:out.append(dict(keys=matched,source='Semantic Scholar 参考文献索引',url=url,excerpt=ref.get('title',''),checked_at=s.now()))
    return out

def initialize(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS citation_edges(citing_id TEXT NOT NULL REFERENCES papers(id),cited_id TEXT NOT NULL REFERENCES papers(id),evidence TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(citing_id,cited_id));
CREATE TABLE IF NOT EXISTS citation_checks(paper_id TEXT PRIMARY KEY REFERENCES papers(id),checked_at TEXT NOT NULL,status TEXT NOT NULL,details TEXT NOT NULL);''')

def graph(s,nid):
    ids=[x['paper_id'] for x in s.rows('SELECT paper_id FROM library WHERE node_id=?',(nid,))]
    if not ids:return dict(edges=[],checks=[],verified=0)
    placeholders=','.join('?' for _ in ids)
    edges=s.rows('SELECT * FROM citation_edges WHERE citing_id IN ('+placeholders+') AND cited_id IN ('+placeholders+')',tuple(ids+ids))
    checks=s.rows('SELECT * FROM citation_checks WHERE paper_id IN ('+placeholders+')',tuple(ids))
    for edge in edges:edge['evidence']=json.loads(edge['evidence'])
    for check in checks:check['details']=json.loads(check['details'])
    return dict(edges=edges,checks=checks,verified=len(edges))

def refresh(s,nid):
    papers=s.rows('SELECT p.* FROM papers p JOIN library l ON l.paper_id=p.id WHERE l.node_id=?',(nid,))
    if not papers:raise ValueError('此方向还没有已收录论文')
    warnings=0
    for index,p in enumerate(papers):
        s.task_progress('提取并交叉核验参考文献 '+str(index+1)+'/'+str(len(papers)))
        content,checked,errors=content_references(s,p);other=[]
        try:other.extend(registry_references(s,p))
        except Exception as error:errors.append('Crossref 参考文献：'+str(error))
        content_keys=set().union(*(x['keys'] for x in content)) if content else set()
        other_keys=set().union(*(x['keys'] for x in other)) if other else set()
        library_keys=set().union(*(identifiers(item) for item in papers if item['id']!=p['id']))
        if content_keys.intersection(library_keys)-other_keys:
            try:other.extend(semantic_references(s,p))
            except Exception as error:errors.append('Semantic Scholar 交叉核验：'+str(error))
        verified=[];pending=0
        for target in papers:
            if target['id']==p['id']:continue
            keys=identifiers(target);primary=[x for x in content if keys.intersection(x['keys'])];secondary=[x for x in other if keys.intersection(x['keys'])]
            if primary and secondary:
                evidence=[{k:v for k,v in x.items() if k!='keys'} for x in [primary[0],secondary[0]]]
                verified.append((p['id'],target['id'],json.dumps(evidence,ensure_ascii=False),s.now()))
            elif primary or secondary:pending+=1
        details=dict(article_content_sources=checked,extracted_references=len(content),crosscheck_references=len(other),verified_edges=len(verified),pending_edges=pending,errors=errors,scope='仅连接当前方向已收录文献；需正文参考文献与独立索引一致，无证据不连线')
        status='complete' if checked and not errors else 'partial' if checked or other else 'unavailable'
        with s.connect() as c:
            # Preserve previously corroborated evidence on source outages.
            if checked and not errors:
                target_ids=[target['id'] for target in papers if target['id']!=p['id']]
                if target_ids:c.execute('DELETE FROM citation_edges WHERE citing_id=? AND cited_id IN ('+','.join('?' for _ in target_ids)+')',tuple([p['id']]+target_ids))
            for row in verified:c.execute('INSERT OR REPLACE INTO citation_edges VALUES (?,?,?,?)',row)
            c.execute('INSERT OR REPLACE INTO citation_checks VALUES (?,?,?,?)',(p['id'],s.now(),status,json.dumps(details,ensure_ascii=False)))
        if errors or not checked or pending:
            warnings+=1;s.log_problem('引用网络','参考文献交叉核验',p['title']+'：存在未能交叉确认的资料',nid,p['id'],json.dumps(details,ensure_ascii=False))
    return dict(papers=len(papers),warnings=warnings,verified=graph(s,nid)['verified'])
