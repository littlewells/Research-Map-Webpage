"""Model-planned public-page research. Never treat an invented URL as evidence."""
import datetime as dt
import html
from html.parser import HTMLParser
import ipaddress
import re
import socket
import urllib.parse
import urllib.request
import time
import xml.etree.ElementTree as ET
import safe_web
import concurrent.futures
import contextvars
import json
import task_control

def public_url(url):
    return safe_web.validate(url)

class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        public_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def fetch(url,limit=1500000):
    return safe_web.fetch(url,limit)

class ArticlePage(HTMLParser):
    def __init__(self):super().__init__();self.meta={};self.parts=[];self.title=[];self.in_title=False;self.skip=0;self.links=[];self.structured=[];self.in_json=False;self.json_parts=[];self.comments=[];self.journal_reference=[];self.comment_depth=0;self.row_depth=0;self.row_parts=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if self.comment_depth:self.comment_depth+=1
        elif 'comments' in attrs.get('class','').split():self.comment_depth=1
        if tag=='tr':self.row_depth+=1;self.row_parts=[]
        if tag=='script' and attrs.get('type','').lower()=='application/ld+json':self.in_json=True;self.json_parts=[]
        if tag in ('script','style','nav','footer'):self.skip+=1
        if tag=='title':self.in_title=True
        if tag=='meta':
            key=(attrs.get('name') or attrs.get('property') or '').lower()
            if key and attrs.get('content'):self.meta.setdefault(key,[]).append(attrs['content'])
        if tag=='a' and attrs.get('href'):self.links.append(attrs['href'])
    def handle_endtag(self,tag):
        if self.comment_depth:self.comment_depth-=1
        if tag=='tr' and self.row_depth:
            row=' '.join(self.row_parts)
            if re.match(r'\s*Comments\s*:',row,re.I):self.comments.append(re.sub(r'^\s*Comments\s*:\s*','',row,flags=re.I))
            if re.match(r'\s*Journal reference\s*:',row,re.I):self.journal_reference.append(re.sub(r'^\s*Journal reference\s*:\s*','',row,flags=re.I))
            self.row_depth-=1
        if tag=='script' and self.in_json:
            try:self.structured.append(json.loads(''.join(self.json_parts)))
            except ValueError:pass
            self.in_json=False
        if tag in ('script','style','nav','footer'):self.skip=max(0,self.skip-1)
        if tag=='title':self.in_title=False
    def handle_data(self,text):
        if self.comment_depth:self.comments.append(text)
        if self.row_depth:self.row_parts.append(text)
        if self.in_json:self.json_parts.append(text)
        if self.in_title:self.title.append(text)
        if not self.skip and text.strip():self.parts.append(text.strip())

def clean(text):return re.sub(r'\s+',' ',html.unescape(str(text or ''))).strip()
def norm(text):return re.sub(r'[^a-z0-9\u4e00-\u9fff]','',clean(text).lower())

class ResearchUnavailable(RuntimeError):
    """No discovery source could be reached; distinct from a valid empty search."""

def page(url):
    raw,final=fetch(url);parsed=ArticlePage();parsed.feed(raw)
    def first(*names):return next((parsed.meta[n][0] for n in names if parsed.meta.get(n)),'')
    title=clean(first('citation_title','dc.title') or ' '.join(parsed.title))
    abstract=clean(first('citation_abstract','dc.description','description','og:description'))
    date=first('citation_publication_date','citation_date','dc.date','dc.date.issued','article:published_time','prism.publicationdate')
    if not date:
        pending=list(parsed.structured)
        while pending:
            item=pending.pop()
            if isinstance(item,list):pending.extend(item)
            elif isinstance(item,dict):
                if item.get('@type') in ('ScholarlyArticle','Article','MedicalScholarlyArticle') and item.get('datePublished'):date=str(item['datePublished']);break
                if '@graph' in item:pending.append(item['@graph'])
    date=date.replace('/','-')[:10]
    if not re.fullmatch(r'\d{4}-\d{1,2}-\d{1,2}',date):date=''
    if date:
        try:date=dt.date(*map(int,date.split('-'))).isoformat()
        except ValueError:date=''
    if date>dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat():date=''
    doi=clean(first('citation_doi','dc.identifier','prism.doi'))
    doi_match=re.search(r'10[.]\d{4,9}/[^\s<>]+',doi,re.I);doi=doi_match.group(0).rstrip('.,;') if doi_match else ''
    authors=parsed.meta.get('citation_author') or parsed.meta.get('dc.creator') or []
    text=' '.join(parsed.parts)
    # Search discovery must land on a paper, not an arbitrary topical result page.
    scholarly=bool(first('citation_title','citation_doi','citation_pdf_url','dc.identifier') or re.search(r'/(?:abs|html)/\d{4}[.]\d{4,5}',final))
    venue=clean(first('citation_journal_title','citation_conference_title','prism.publicationname'))
    kind='journal' if first('citation_journal_title','prism.publicationname') else 'conference' if first('citation_conference_title') else 'preprint' if urllib.parse.urlsplit(final).hostname in ('arxiv.org','www.arxiv.org','www.biorxiv.org','www.medrxiv.org') else 'unknown'
    if not venue:
        comments=clean(' '.join(parsed.comments));comments=re.split(r'\b(?:Project(?: page)?|Code|Video)\s*:',comments,flags=re.I)[0].strip(' .;')
        conference=re.match(r'(?i)^(?:accepted (?:at|to)|published (?:at|in)|to appear (?:at|in))\s+(.{3,180})',comments)
        if not conference:conference=re.match(r'^(.{3,140}?(?:Conference|Symposium|Workshop|Robotics:\s*Science and Systems|\b(?:ICRA|IROS|RSS|CoRL|NeurIPS|ICML|ICLR|CVPR|ICCV|ECCV|AAAI|IJCAI)\b).{0,60}?)(?:[.;]|$)',comments)
        if conference and not re.search(r'submitted|under review|rejected|not accepted',comments,re.I) and re.search(r'Conference|Symposium|Workshop|Robotics:\s*Science and Systems|\b(?:ICRA|IROS|RSS|CoRL|NeurIPS|ICML|ICLR|CVPR|ICCV|ECCV|AAAI|IJCAI)\b',conference.group(1),re.I):venue=conference.group(1).strip(' .;');kind='conference'
        elif parsed.journal_reference:venue=clean(parsed.journal_reference[0])[:300];kind='journal'
        elif re.match(r'(?i)^(?:accepted|published) in\s+',comments) and not re.search(r'not accepted|under review|submitted',comments,re.I):venue=re.sub(r'(?i)^(?:accepted|published) in\s+','',comments)[:200];kind='journal'
    links=[]
    for link in parsed.links:
        link=urllib.parse.urljoin(final,link);host=urllib.parse.urlsplit(link).hostname or ''
        if host and (host=='doi.org' or any(domain in host for domain in ('roboticsproceedings.org','ieee.org','acm.org','springer.com','springerlink.com','nature.com','science.org','sciencedirect.com','elsevier.com','wiley.com','tandfonline.com','journals.','proceedings.'))) and not link.lower().split('?')[0].endswith('.pdf') and link not in links:links.append(link)
    if doi and 'https://doi.org/'+doi not in links:links.insert(0,'https://doi.org/'+doi)
    host=urllib.parse.urlsplit(final).hostname or ''
    platform=any(host==domain or host.endswith('.'+domain) for domain in ('ieee.org','acm.org','springer.com','springerlink.com','link.springer.com','nature.com','science.org','sciencedirect.com','elsevier.com','wiley.com','tandfonline.com','frontiersin.org','mdpi.com','iop.org','sagepub.com','oxfordacademic.com','oup.com','plos.org','cell.com','annualreviews.org','aps.org','aip.org','royalsocietypublishing.org'))
    return dict(title=title,abstract=abstract,published=date,doi=doi,authors=', '.join(authors[:30]),venue=venue,url=final,text=text[:18000],scholarly=scholarly,source='公开论文网页',publication_kind=kind,publication_links=links[:8],platform_verified=platform)

def search(query):
    url='https://www.bing.com/search?'+urllib.parse.urlencode({'q':query,'format':'rss'})
    raw,_=fetch(url,600000);root=ET.fromstring(raw)
    if root.tag!='rss':raise ValueError('搜索引擎未返回可核验的检索结果')
    return [dict(title=clean(x.findtext('title','')),url=x.findtext('link',''),snippet=clean(x.findtext('description',''))) for x in root.findall('.//item')[:8]]

def academic_search(query):
    # Public HTML discovery only; dates and metadata still come from opened papers.
    identifier=re.search(r'\b(\d{4}[.]\d{4,5})(?:v\d+)?\b',query)
    if identifier:return [dict(url='https://arxiv.org/abs/'+identifier.group(1),title='',snippet='精确 arXiv 标识')]
    query=re.sub(r'\b(?:after|before|site):\S+','',query)
    quoted=re.search(r'"([^"]+)"',query)
    exact=quoted.group(1) if quoted else ''
    terms=re.findall(r'[A-Za-z][A-Za-z0-9-]*',exact or query)
    terms=[t for t in terms if t.lower() not in ('and','or','not','paper','papers','research','recent','latest','study','studies')][:16]
    if not terms:return []
    links=[]
    alternatives=[terms]
    if len(terms)>2:alternatives.append(terms[:2])
    for words in alternatives:
        url='https://arxiv.org/search/?'+urllib.parse.urlencode(dict(query=' '.join(words),searchtype='all',abstracts='show',order='-announced_date_first',size=25))
        raw,final=fetch(url);parsed=ArticlePage();parsed.feed(raw)
        for link in parsed.links:
            link=urllib.parse.urljoin(final,link)
            if re.fullmatch(r'https://arxiv[.]org/abs/\d{4}[.]\d{4,5}(?:v\d+)?',link) and link not in links:links.append(link)
        if links:break
    return [dict(url=link,title='',snippet='') for link in links[:8]]

def collect(s,queries,maximum=10,local_only=False):
    seen=set();out=[];found=[];failures=[];rejected=0;available=0;opened=0
    if not local_only:
        s.task_progress('优先调用 API 联网搜索调研论文')
        try:
            import model_web
            found=model_web.discover(s,queries);available+=1
        except Exception as error:
            message=s.credentials.redact(error)[:260];failures.append('API 联网搜索：'+message)
            s.log_problem('网页调研','API 联网搜索降级',message,details='模型联网不可用或缺少来源证据，最后尝试本地公开搜索。')
    if not found:
        if hasattr(s,'config') and not s.config().get('verification_search_fallback',True):
            raise ResearchUnavailable('API 联网搜索未取得候选，且未开启本地搜索补查；请查看任务详情。')
        s.task_progress('API 未取得候选，最后使用本地搜索引擎与公开学术网页')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            jobs={pool.submit(contextvars.copy_context().run,provider,query):(name,query) for query in queries[:6] for name,provider in [('搜索引擎',search),('arXiv 公开搜索页',academic_search)]}
            for future in concurrent.futures.as_completed(jobs):
                name,query=jobs[future]
                try:found.extend(future.result());available+=1
                except Exception as error:failures.append(name+'：'+str(error)[:160])
    if not available and queries:
        s.log_problem('网页调研','检索来源不可用','所有公开检索来源均不可用',details='\n'.join(failures[:8]))
        raise ResearchUnavailable('所有公开检索来源均不可用，未能完成领域调研；请展开来源详情。')
    urls=[]
    for result in found:
        url=result.get('url','');host=urllib.parse.urlsplit(url).hostname or ''
        if not url or url in seen:continue
        seen.add(url)
        if any(x in host for x in ('dictionary.','dict.','iciba.com','baike.baidu.com')):rejected+=1;continue
        urls.append(url)
    urls.sort(key=lambda url:0 if urllib.parse.urlsplit(url).hostname=='arxiv.org' else 1)
    s.task_progress('并行打开论文网页并核验题名及发表日期')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs={pool.submit(contextvars.copy_context().run,page,url):url for url in urls[:40]}
        for future in concurrent.futures.as_completed(jobs):
            try:
                item=future.result();opened+=1
                if item['scholarly'] and item['title'] and (item['abstract'] or len(item['text'])>300):out.append(item)
                else:rejected+=1
            except Exception as error:failures.append(jobs[future]+'：'+str(error)[:160])
    if urls and not opened:
        s.log_problem('网页调研','论文网页不可用','发现了链接，但所有候选页面读取均失败',details='\n'.join(failures[:8]))
        raise ResearchUnavailable('所有候选论文网页均读取失败，无法判断是否有更新；请查看来源详情。')
    if not out:
        s.log_problem('网页调研','候选核验','本轮未发现可核验的论文页面',details='发现链接 '+str(len(seen))+'；过滤非论文 '+str(rejected)+'；来源诊断 '+str(len(failures))+'\n'+'\n'.join(failures[:6]))
    elif failures:s.log_problem('网页调研','部分公开页面','部分检索或页面读取不可用，其余核验结果已保留',details='\n'.join(failures[:4]))
    out.sort(key=lambda p:p.get('published',''),reverse=True)
    return out[:maximum]

def complete_metadata(s,metadata):
    """Accept API research as AI-generated information, without local web verification."""
    import model_web
    metadata=dict(metadata);proof=[]
    s.task_progress('API 全权联网调研发表信息；按版本继续检索正式发表记录')
    candidates,web_proof=model_web.research(s,metadata)
    relevant,conflicts=model_web.select_research_items(candidates,metadata)
    formal=next((item for item in relevant if model_web._is_formal_publication(item)),None)
    preprint=next((item for item in relevant if model_web._is_preprint(item)),None)
    item=formal or preprint or (relevant[0] if relevant else next(iter(candidates),{}))
    original_venue=str(metadata.get('venue') or '').strip()
    original_url=str(metadata.get('url') or '').strip()
    uploaded_arxiv=bool(metadata.get('arxiv') or 'arxiv.org/' in original_url.lower() or norm(original_venue) in ('arxiv','biorxiv','medrxiv','preprint'))
    uploaded_version='arxiv' if uploaded_arxiv else 'published' if metadata.get('doi') or (original_venue and norm(original_venue) not in ('arxiv','biorxiv','medrxiv','preprint')) else 'unknown'
    online_kind=str((formal or preprint or {}).get('publication_kind') or '').strip().lower()
    for key in ('authors','published','venue','url','year','doi'):
        value=item.get(key)
        if not value:continue
        replacement=(not metadata.get(key) or key=='venue' and norm(metadata.get(key,'')) in ('arxiv','biorxiv','medrxiv','preprint') or key in ('url','doi') and uploaded_arxiv and bool(formal) or key in ('published','venue') and uploaded_arxiv and bool(formal))
        if replacement:
            metadata[key]=value
            proof.append(dict(field=key,value=value,url=item.get('url',''),method='AI 调研生成，可能有误',checked_at=s.now()))
    sources=[]
    for candidate in relevant or candidates:
        sources.extend(candidate.get('sources',[]))
    sources.extend(web_proof.get('sources',[]))
    sources=list({source.get('url'):source for source in sources if isinstance(source,dict) and source.get('url')}.values())
    versions=[]
    for candidate in relevant or candidates:
        nested=candidate.get('versions',[]) if isinstance(candidate.get('versions',[]),list) else []
        candidates_for_versions=nested or [candidate]
        for source_version in candidates_for_versions:
            version=dict(kind=source_version.get('publication_kind') or source_version.get('kind') or 'unknown',title=source_version.get('title',''),authors=source_version.get('authors',''),published=source_version.get('published',''),year=source_version.get('year'),venue=source_version.get('venue',''),doi=source_version.get('doi',''),arxiv=source_version.get('arxiv',''),url=source_version.get('url',''),publication_links=source_version.get('publication_links',[]),sources=source_version.get('sources',[]),summary=source_version.get('summary',''))
            if any(version.get(k) for k in ('title','doi','arxiv','venue','url')):versions.append(version)
    versions=list({(x.get('kind',''),x.get('doi',''),x.get('arxiv',''),x.get('url',''),x.get('venue','')):x for x in versions}.values())
    preprint_version=next((x for x in versions if model_web._is_preprint(x)),None)
    preprint=preprint or preprint_version
    found=bool(formal)
    publication_status='published_confirmed' if found else 'preprint_only' if preprint else 'unconfirmed'
    label='AI 调研：已确认正式发表版本' if found else 'AI 调研：仅找到预印本，未确认正式发表版本' if preprint else 'AI 调研：未确认发表版本'
    diagnostics=list(web_proof.get('diagnostics',[]))
    if conflicts:diagnostics.append(dict(stage='identity',message='发现题名相近但标识符冲突的候选，未自动合并',count=len(conflicts)))
    if not relevant and candidates:diagnostics.append(dict(stage='identity',message='搜索结果未能与上传论文的题名或标识符精确关联'))
    metadata['_online_status']=dict(status='ai_reported' if found else 'ai_not_found',publication_status=publication_status,label=label,disclaimer='AI 调研生成，可能有误',uploaded_version=uploaded_version,pdf_declared_venue=original_venue,online_confirmed_venue=formal.get('venue','') if formal else '',canonical_doi=(formal or {}).get('doi',''),arxiv_id=(preprint or {}).get('arxiv','') or metadata.get('arxiv',''),venue=(formal or preprint or {}).get('venue','') or original_venue,publication_kind=(formal or preprint or {}).get('publication_kind',online_kind or 'unknown'),publication_url=(formal or {}).get('url','') or item.get('url',''),preprint_url=(preprint or {}).get('url','') or (original_url if uploaded_arxiv else ''),preprint=next((x for x in versions if model_web._is_preprint(x)),None),published=next((x for x in versions if model_web._is_formal_publication(x)),None),versions=versions,checked_at=s.now(),sources=sources,summary=(formal or preprint or item).get('summary',''),missing_fields=[k for k in ('published','authors','venue') if not metadata.get(k)],diagnostics=diagnostics,research_mode='api_only',search_rounds=web_proof.get('rounds',[]))
    if not found:metadata['_online_status']['missing_fields']=list(dict.fromkeys(metadata['_online_status']['missing_fields']+['venue']))
    return metadata,proof

def save_online_state(s,pid,status,label,version=None):
    with task_control.scope(None),s.LOCK,s.connect() as c:
        import library_manager
        if library_manager.publication_override(c,pid):return False
        row=c.execute('SELECT created_at,reading_coverage FROM paper_documents WHERE paper_id=?',(pid,)).fetchone()
        if not row or version is not None and row['created_at']!=version:return False
        if not c.execute('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)).fetchone() or c.execute("SELECT 1 FROM paper_research WHERE paper_id=? AND status='reading'",(pid,)).fetchone():return False
        coverage=s.json.loads(row['reading_coverage']);previous=coverage.get('online_verification',{})
        paper=c.execute('SELECT authors,published,venue FROM papers WHERE id=?',(pid,)).fetchone()
        coverage['online_verification']={**previous,'status':status,'label':label,'checked_at':s.now(),'missing_fields':[key for key in ('authors','published','venue') if not paper[key]]}
        c.execute('UPDATE paper_documents SET reading_coverage=? WHERE paper_id=?',(s.json.dumps(coverage,ensure_ascii=False),pid))
    return True

AI_METHOD='AI 调研生成，可能有误'
ARTICLE_METHOD='上传 PDF 原文定位'

def _compact(value):
    return re.sub(r'[^0-9a-z\u4e00-\u9fff]','',str(value or '').lower())

def article_publication(coverage,evidence,paper):
    """Formal publication facts quoted from the uploaded PDF; these outrank API research."""
    import model_web
    saved=coverage.get('pdf_publication') if isinstance(coverage,dict) else None
    if isinstance(saved,dict) and saved.get('venue'):return saved
    quotes={}
    for item in evidence or []:
        if isinstance(item,dict) and item.get('method')==ARTICLE_METHOD and item.get('field') not in quotes:quotes[item.get('field')]=item
    venue=str(paper.get('venue') or '').strip();quote=quotes.get('venue')
    if not venue or not quote or model_web.is_preprint_venue(venue) or _compact(venue) not in _compact(quote.get('quote')):return None
    if re.search(r'(?i)submitted|under review|in review|preprint|投稿|审稿',str(quote.get('quote') or '')):return None
    result=dict(source='article',venue=venue,page=quote.get('page'),quote=str(quote.get('quote') or '')[:500])
    for key in ('doi','published'):
        value=str(paper.get(key) or '').strip();proof=quotes.get(key)
        if value and proof and _compact(value) in _compact(proof.get('quote')) and not (key=='doi' and value.lower().startswith('10.48550/')):result[key]=value
    if result.get('published'):result['year']=int(result['published'][:4])
    return result

def article_status(article,paper):
    return dict(status='pdf_extracted',publication_status='published_confirmed',label='发表信息从上传论文原文中提取',research_mode='pdf',venue=article['venue'],canonical_doi=article.get('doi',''),publication_kind='published',checked_at='',missing_fields=[key for key in ('published','authors','venue') if not paper.get(key)])

def attach_article(paper):
    """Expose article-quoted publication facts, including those of older imports, to the UI."""
    document=paper.get('pdf_document')
    if not document:return paper
    coverage=document.setdefault('reading_coverage',{})
    article=article_publication(coverage,document.get('metadata_evidence',[]),paper)
    if article:coverage['pdf_publication']=article
    return paper

def stored_article(s,pid):
    rows=s.rows('SELECT p.venue,p.doi,p.published,d.metadata_evidence,d.reading_coverage FROM papers p JOIN paper_documents d ON d.paper_id=p.id WHERE p.id=?',(pid,))
    if not rows:return None
    row=rows[0]
    return article_publication(s.json.loads(row['reading_coverage']),s.json.loads(row['metadata_evidence']),row)

def research_again(s,payload):
    """Explicit API re-research; article facts and manual corrections remain protected."""
    pid=str(payload.get('paper_id',''))
    import library_manager
    with s.connect() as c:
        if not c.execute('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)).fetchone():raise ValueError('论文不在个人文献库')
        if library_manager.publication_override(c,pid):raise ValueError('发表信息已手动矫正，手动资料优先；如需重新联网查询，请先清空手动矫正内容')
        if not c.execute('SELECT 1 FROM paper_documents WHERE paper_id=?',(pid,)).fetchone():raise ValueError('该论文没有上传 PDF 阅读记录，无法联网补查')
        member=c.execute('SELECT node_id FROM library WHERE paper_id=? ORDER BY added_at LIMIT 1',(pid,)).fetchone()
    nid=member['node_id'] if member else 'library'
    if any(item.get('status')=='running' and str(item.get('kind','')).startswith('metadata:') and str(item.get('kind','')).endswith(':'+pid) for item in list(s.TASKS.values())):raise ValueError('该论文的联网补查正在进行中')
    save_online_state(s,pid,'pending','AI 联网调研进行中')
    context=s.TASK_CONTEXT.set(None)
    try:return s.enqueue('metadata:'+nid+':'+pid,lambda:enrich_metadata(s,nid,pid,manual=True))
    except Exception:
        save_online_state(s,pid,'unavailable','联网补查任务未能启动；已有资料保留');raise
    finally:s.TASK_CONTEXT.reset(context)

def queue_metadata(s,nid,pid):
    documents=s.rows('SELECT created_at FROM paper_documents WHERE paper_id=?',(pid,));version=documents[0]['created_at'] if documents else None
    if stored_article(s,pid):return dict(skipped=True,reason='article')
    if not s.config().get('online_publication_verification',True):
        save_online_state(s,pid,'disabled','未开启发表信息联网核实；已有资料保留',version)
        return dict(skipped=True,reason='disabled')
    context=s.TASK_CONTEXT.set(None)
    try:return s.enqueue('metadata:'+nid+':'+pid,lambda:enrich_metadata(s,nid,pid))
    except ValueError:
        save_online_state(s,pid,'not_started','本次联网核实未启动：同论文已有任务运行；已有资料保留',version)
        return dict(skipped=True,reason='already_running')
    except Exception as error:
        save_online_state(s,pid,'unavailable','联网核实任务未能启动；已有资料保留',version)
        s.log_problem('联网补查','任务启动失败','阅读与评分已完成，但未能启动独立联网补查',nid,pid,details=str(error))
        return dict(skipped=True)
    finally:s.TASK_CONTEXT.reset(context)

def enrich_metadata(s,nid,pid,manual=False):
    paper=s.rows('SELECT p.title,p.identity,d.created_at FROM papers p LEFT JOIN paper_documents d ON d.paper_id=p.id WHERE p.id=?',(pid,))
    version=paper[0] if paper else None
    try:return _enrich_metadata(s,nid,pid,manual)
    except (Exception,task_control.Cancelled) as error:
        if version:
            with task_control.scope(None),s.LOCK,s.connect() as c:
                current=c.execute('SELECT p.title,p.identity,d.created_at,d.reading_coverage FROM papers p JOIN paper_documents d ON d.paper_id=p.id WHERE p.id=?',(pid,)).fetchone()
                import library_manager
                if current and not library_manager.publication_override(c,pid) and all(current[key]==version[key] for key in ('title','identity','created_at')) and c.execute('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)).fetchone() and not c.execute("SELECT 1 FROM paper_research WHERE paper_id=? AND status='reading'",(pid,)).fetchone():
                    coverage=s.json.loads(current['reading_coverage'])
                    previous=coverage.get('online_verification',{})
                    coverage['online_verification']={**previous,**dict(status='interrupted' if isinstance(error,task_control.Cancelled) else 'unavailable',label='联网核实已中断，发表信息未确认' if isinstance(error,task_control.Cancelled) else '联网核实未完成，发表信息未确认',checked_at=s.now(),missing_fields=previous.get('missing_fields',['venue']) if previous.get('publication_status')=='published_confirmed' else ['venue'],diagnostics=[dict(message=s.credentials.redact(error)[:300])])}
                    c.execute('UPDATE paper_documents SET reading_coverage=? WHERE paper_id=?',(s.json.dumps(coverage,ensure_ascii=False),pid))
        raise

def _enrich_metadata(s,nid,pid,manual=False):
    paper=s.rows('SELECT * FROM papers WHERE id=?',(pid,))
    if not paper or not s.rows('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)):return dict(skipped=True)
    if not manual and not s.config().get('online_publication_verification',True):
        save_online_state(s,pid,'disabled','未开启发表信息联网核实；已有资料保留')
        return dict(skipped=True)
    article=stored_article(s,pid)
    if article and not manual:return dict(skipped=True,reason='上传论文原文已含正式发表信息，未自动联网补查')
    if article:s.task_progress('文章原文中的发表信息优先；本次联网结果只补充其他资料，不覆盖'+'、'.join(k for k in ('venue','doi','published') if article.get(k)))
    original=paper[0];metadata={key:original.get(key) for key in ('title','authors','published','venue','doi','url')}
    import library_manager
    with s.connect() as c:
        if library_manager.publication_override(c,pid):return dict(skipped=True,reason='手动矫正资料优先，未发起新的调研')
    documents=s.rows('SELECT created_at FROM paper_documents WHERE paper_id=?',(pid,));version=documents[0]['created_at'] if documents else None
    metadata['arxiv']=s.local_citations.aid(original.get('identity')) or s.local_citations.aid(original.get('url')) or s.local_citations.aid(original.get('doi'))
    prior=s.rows('SELECT metadata_evidence FROM paper_documents WHERE paper_id=?',(pid,))
    prior_ai={item.get('field') for item in (json.loads(prior[0]['metadata_evidence']) if prior else []) if isinstance(item,dict) and item.get('method')==AI_METHOD}
    for key in ('authors','published','venue'):
        # Earlier API answers are replaceable; present them as unknown to the new research.
        if key in prior_ai and not (article and article.get(key)):metadata[key]=''
    enriched,proof=complete_metadata(s,metadata)
    online=enriched.get('_online_status',dict(status='published' if enriched.get('venue') and any(item.get('field')=='venue' for item in proof) else 'unconfirmed',label='已确认发表平台' if enriched.get('venue') and any(item.get('field')=='venue' for item in proof) else '联网未确认缺失资料',missing_fields=[key for key in ('published','authors','venue') if not enriched.get(key)],checked_at=s.now()))
    with s.LOCK,s.connect() as c:
        current=c.execute('SELECT * FROM papers WHERE id=?',(pid,)).fetchone()
        if not current or current['title']!=original['title'] or current['identity']!=original['identity']:return dict(skipped=True)
        import library_manager
        if library_manager.publication_override(c,pid):return dict(skipped=True,reason='手动矫正资料优先，未覆盖')
        latest=c.execute('SELECT created_at FROM paper_documents WHERE paper_id=?',(pid,)).fetchone()
        if (latest['created_at'] if latest else None)!=version or c.execute("SELECT 1 FROM paper_research WHERE paper_id=? AND status='reading'",(pid,)).fetchone():return dict(skipped=True)
        if not c.execute('SELECT 1 FROM personal_papers WHERE paper_id=?',(pid,)).fetchone():return dict(skipped=True)
        document=c.execute('SELECT metadata_evidence,reading_coverage FROM paper_documents WHERE paper_id=?',(pid,)).fetchone()
        import model_web
        old_evidence=s.json.loads(document['metadata_evidence']) if document else []
        protected={key for key in ('venue','doi','published') if article and article.get(key)}
        ai_fields={item.get('field') for item in old_evidence if isinstance(item,dict) and item.get('method')==AI_METHOD}
        formal_found=online.get('publication_status')=='published_confirmed'
        written=set()
        for key in ('authors','published','venue','url','doi'):
            value=enriched.get(key)
            if not value or key in protected or value==current[key]:continue
            # Newer API research replaces earlier API-owned values, never article/manual values.
            if not current[key] or key in ai_fields or key=='venue' and model_web.is_preprint_venue(current[key]) or key=='url' and formal_found and 'arxiv.org/' in str(current[key]).lower():
                c.execute('UPDATE papers SET '+key+'=? WHERE id=?',(value,pid));written.add(key)
                if key=='published':c.execute('UPDATE papers SET year=? WHERE id=?',(int(value[:4]),pid))
        if article:online['pdf_declared_venue']=article['venue']
        if document:
            evidence=[item for item in old_evidence if not (isinstance(item,dict) and item.get('method')==AI_METHOD and item.get('field') in written)]
            evidence.extend(item for item in proof if item.get('field') in written and item not in evidence)
            c.execute('UPDATE paper_documents SET metadata_evidence=? WHERE paper_id=?',(s.json.dumps(evidence,ensure_ascii=False),pid))
            coverage=s.json.loads(document['reading_coverage']);coverage['online_verification']=online
            if article:coverage['pdf_publication']=article
            c.execute('UPDATE paper_documents SET reading_coverage=? WHERE paper_id=?',(s.json.dumps(coverage,ensure_ascii=False),pid))
    return dict(ok=True,article_protected=sorted(protected),updated_fields=sorted(written),warning='' if online['status'] in ('ai_reported','manual') or article else '联网补查：'+online['label']+'；阅读评分保留')

def recommend(s,nid,force=False):
    s.require_recommendations(nid)
    n=s.node_or_fail(nid);cfg=s.config()
    if not force and n['last_refresh'] and (s.dt.datetime.now(s.UTC)-s.dt.datetime.fromisoformat(n['last_refresh'])).total_seconds()<cfg['refresh_hours']*3600:return dict(skipped=True)
    log=s.uid();s.execute('INSERT INTO refresh_log(id,node_id,started_at,status) VALUES (?,?,?,?)',(log,nid,s.now(),'running'))
    try:
        context=s.recommendation_context(nid)
        saved=s.rows('SELECT p.title,p.abstract,p.authors FROM papers p JOIN library l ON l.paper_id=p.id WHERE l.node_id=?',(nid,))
        parent_ids=[p['id'] for p in context[:-1]]
        parents=s.rows('SELECT p.title,p.abstract,p.authors FROM papers p JOIN library l ON l.paper_id=p.id WHERE l.node_id IN ('+','.join('?' for _ in parent_ids)+') LIMIT 25',tuple(parent_ids)) if parent_ids else []
        s.task_progress('理解子方向在完整研究地图中的技术路线，制定领域调研计划')
        plan=s.ai('推荐联网调研计划',dict(task='先理解子节点在全部父节点背景下的研究问题、技术路线和所属领域，再制定领域调研计划。节点关键词只是线索，不是必须同时命中的条件。覆盖同义表达、相关方法、基础机制、实现技术与适用研究；符合该路径的文章即使不含节点原词也可候选。返回 {"scope":"该子方向的研究范围及父类约束","routes":["值得调研的相关路线"],"queries":["最多6条互补的中英文公开网页查询"]}。每条查询聚焦一个角度，不把所有父类和叶子词强行AND连接，不要求论文出现整条路径。不要凭记忆生成论文或链接。',research_path=context,library=saved[-20:],ancestor_library=parents,since=s.cutoff()))
        scope=dict(description=clean(plan.get('scope')),routes=[clean(x) for x in plan.get('routes',[]) if isinstance(x,str)][:8])
        queries=list(dict.fromkeys(clean(x)[:500] for x in plan.get('queries',[]) if isinstance(x,str) and clean(x)))[:6] or s.recommendation_queries(context,saved)[:3]
        pages=collect(s,queries,30)
        today=s.dt.datetime.now(s.dt.timezone(s.dt.timedelta(hours=8))).date().isoformat()
        since=s.cutoff();all_pages={p['url']:p for p in pages};existing=s.rows('SELECT p.doi,p.url FROM papers p WHERE p.id IN (SELECT paper_id FROM recommendations WHERE node_id=? UNION SELECT paper_id FROM library WHERE node_id=?)',(nid,nid))
        known_urls={p['url'].rstrip('/') for p in existing if p['url']};known_dois={p['doi'].lower() for p in existing if p['doi']}
        def new_pages():
            return [p for p in all_pages.values() if p.get('published') and since<=p['published']<=today and p['url'].rstrip('/') not in known_urls and not (p.get('doi') and p['doi'].lower() in known_dois)]
        pages=new_pages()
        if queries:
            s.task_progress('依据已打开网页补充调研相关方法、同义术语与邻近研究')
            follow=s.ai('推荐领域补充调研',dict(task='根据研究路径和本轮实际打开的网页，寻找本领域相关研究的其他表达和技术分支，拓展检索而不是重复堆叠节点词。返回 {"queries":["最多3条新的公开网页查询"]}。不生成论文、日期或链接。现有证据不足也可以从研究范围另选角度，不要求词面匹配。',research_path=context,research_scope=scope,previous_queries=queries,observed_pages=[dict(title=p['title'],abstract=p.get('abstract','')[:1600],published=p.get('published',''),url=p['url']) for p in list(all_pages.values())[:20]],since=since))
            extra=list(dict.fromkeys(clean(x)[:500] for x in follow.get('queries',[]) if isinstance(x,str) and clean(x) and clean(x)[:500] not in queries))[:3]
            if extra:
                try:additional=collect(s,extra,30)
                except ResearchUnavailable:
                    if not pages:raise
                    additional=[]
                for p in additional:all_pages[p['url']]=p
                queries.extend(extra);pages=new_pages()
        pages.sort(key=lambda p:p['published'],reverse=True)
        rejected_dates=sum(not p.get('published') or not since<=p['published']<=today for p in all_pages.values())
        if rejected_dates:s.log_problem('网页调研','近期日期核验',str(rejected_dates)+' 个页面日期缺失或不在所选范围，未作近期推荐')
        if pages:
            candidates=[dict(id=str(i),title=p['title'],published=p['published'],abstract=p['abstract'],page_excerpt=p['text'][:8000],url=p['url']) for i,p in enumerate(pages[:30])];pages=pages[:30]
            s.task_progress('综合网页证据判断技术路线相关性并撰写推荐概要')
            answer=s.ai('公开论文调研推荐',dict(task='根据公开网页的研究内容判断与子方向技术路线/领域的实质相关性，不进行节点关键词命中或标题词面筛选。全部父节点用于消除歧义和限定研究背景，不要求每篇论文同时覆盖所有父类。相关机制、方法、实现或应用研究均可推荐，理由须说明与当前路线的具体关系。返回 {"recommendations":[{"id":"候选id","summary":"依据网页证据的中文概要","reason":"与当前技术路线的具体关系"}]}。无实质相关研究返回空数组。不发明候选、日期或链接，不声称已阅读未提供的全文。',research_path=context,research_scope=scope,library=saved[-20:],ancestor_library=parents,candidates=candidates,limit=cfg['recommendation_limit']))
        else:answer={'recommendations':[]};candidates=[]
        recommendations=answer.get('recommendations')
        if not isinstance(recommendations,list):raise ValueError('模型未返回有效的领域推荐结果，不能判定为无新论文')
        count=0;seen=set()
        for item in recommendations[:cfg['recommendation_limit']]:
            s.require_recommendations(nid)
            if not isinstance(item,dict) or str(item.get('id')) not in {p['id'] for p in candidates}:continue
            original=pages[int(item['id'])]
            if original['url'] in seen:continue
            summary=clean(item.get('summary'))
            if not summary:continue
            seen.add(original['url']);identity='doi:'+original['doi'].lower() if original['doi'] else 'web:'+s.hashlib.sha256(original['url'].encode()).hexdigest()
            p=s.paper(identity,original['title'],original['authors'],int(original['published'][:4]),original['published'],'',original['doi'],original['url'],original['abstract'],'公开网页调研')
            pid=s.persist(p)
            s.execute('INSERT INTO recommendations(node_id,paper_id,tag,reason,summary,summary_kind,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(node_id,paper_id) DO UPDATE SET reason=excluded.reason,summary=excluded.summary,summary_kind=excluded.summary_kind,created_at=excluded.created_at', (nid,pid,'',clean(item.get('reason'))[:1000],summary[:3000],'公开论文网页证据 · AI概要 · 非个人文献',s.now()));count+=1
        if recommendations and not count:raise ValueError('模型推荐缺少有效候选或网页概要，未将无效回答当作无新论文')
        detail=dict(added=count,candidates=len(pages),queries=queries,research_scope=scope,no_new=not bool(count),warning='' if count else '未检索到更新的论文；本次未发现符合研究方向且日期和链接可核验的新文章，保留已有推荐。')
        s.execute('UPDATE refresh_log SET status=?,finished_at=?,details=? WHERE id=?',('done' if count else 'warning',s.now(),s.json.dumps(detail,ensure_ascii=False),log));s.execute('UPDATE nodes SET last_refresh=? WHERE id=?',(s.now(),nid));s.task_result(detail);return detail
    except Exception as error:
        s.execute('UPDATE refresh_log SET status=?,finished_at=?,details=? WHERE id=?',('error',s.now(),str(error)[:500],log));raise
