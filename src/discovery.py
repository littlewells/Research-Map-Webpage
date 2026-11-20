"""Discovery adapters: search snippets never become verified paper metadata."""
import re
import difflib
import urllib.parse
import xml.etree.ElementTree as ET

def datacite(s,query,recent=False):
    doi=s.doi_of(query)
    if doi:items=[s.request_json('https://api.datacite.org/dois/'+urllib.parse.quote(doi,safe=''))['data']]
    else:
        params={'query':query,'page[size]':20,'sort':'-published' if recent else 'relevance'}
        if recent:params['query']+=' AND publicationYear:['+s.cutoff()[:4]+' TO '+str(s.dt.datetime.now(s.UTC).year)+']'
        items=s.request_json('https://api.datacite.org/dois?'+urllib.parse.urlencode(params)).get('data',[])
    out=[]
    for item in items:
        a=item.get('attributes') or {};identifier=a.get('doi') or item.get('id','')
        kind=(a.get('types') or {}).get('resourceTypeGeneral','')
        if not doi and kind not in ('Text','Preprint','JournalArticle','ConferencePaper'):continue
        title=next((x.get('title') for x in a.get('titles',[]) if x.get('title')),'')
        if not s.doi_of(identifier) or not title:continue
        published=next((d.get('date','') for d in a.get('dates',[]) if d.get('dateType') in ('Issued','Available')),'')[:10]
        if not re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}',published):published=''
        authors=', '.join(x.get('name') or ' '.join(filter(None,[x.get('givenName'),x.get('familyName')])) for x in a.get('creators',[])[:30])
        abstract=next((x.get('description','') for x in a.get('descriptions',[]) if x.get('descriptionType')=='Abstract'),'')
        out.append(s.paper('doi:'+identifier,title,authors,a.get('publicationYear'),published,a.get('publisher',''),identifier,'https://doi.org/'+identifier,abstract,'DataCite'))
    return out

def exact_doi(s,query,recent=False):
    errors=[]
    for source in (s.crossref,s.datacite):
        try:
            items=source(query,recent)
            items=[p for p in items if p.get('doi','').lower()==(s.doi_of(query) or '').lower()]
            if items:return items
        except Exception as error:errors.append(str(error))
    raise RuntimeError('; '.join(errors) or 'DOI 注册来源未找到记录')

def web(s,query,recent=False):
    suffix=' after:'+s.cutoff() if recent else ''
    url='https://www.bing.com/search?'+urllib.parse.urlencode({'q':query+' (paper OR arxiv OR DOI)'+suffix,'format':'rss'})
    root=ET.fromstring(s.remote.fetch(url,timeout=20,raw=True))
    if root.tag!='rss':raise RuntimeError('搜索引擎未返回 RSS 结果，已跳过')
    found=[];seen=set();errors=[];title_lookups=0
    for item in root.findall('.//item')[:12]:
        text=' '.join(item.findtext(k,'') for k in ('link','title','description'))
        identifiers=[];doi=s.doi_of(text)
        if doi:identifiers.append(('doi',doi.rstrip(')')))
        match=re.search('arxiv[.]org/(?:abs|pdf|html)/([0-9]{4}[.][0-9]{4,5})(?:v[0-9]+)?',text,re.I)
        if match:identifiers.append(('arxiv',match.group(1)))
        if not identifiers and title_lookups<3:
            title=item.findtext('title','').strip()
            if len(title)>24:
                title_lookups+=1
                try:
                    for candidate in s.crossref(title):
                        if difflib.SequenceMatcher(None,s.norm(title),s.norm(candidate['title'])).ratio()<.88:continue
                        candidate['source']+=' · 搜索引擎题名匹配后注册题录核验';found.append(candidate);break
                except Exception as error:errors.append(str(error))
        for kind,key in identifiers:
            if (kind,key) in seen or len(seen)>=6:continue
            seen.add((kind,key))
            try:
                candidates=s.verified_doi(key) if kind=='doi' else s.arxiv(key)
                for candidate in candidates:
                    if kind=='doi' and candidate.get('doi','').lower()!=key.lower():continue
                    if kind=='arxiv' and s.arxiv_identifier(candidate)!=key:continue
                    candidate['source']+=' · 搜索引擎发现后精确核验';found.append(candidate)
            except Exception as error:errors.append(str(error))
    if errors:s.log_problem('文献检索','搜索引擎候选核验','部分标识符回查未成功',details='; '.join(errors))
    return found
