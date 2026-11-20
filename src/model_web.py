"""Responses hosted search: tool traces and cited sources, never self-reported access."""
import threading
import time
import urllib.parse
import ipaddress
import re
import safe_web
import model_probe

_cache={}
_lock=threading.Lock()

def evidence(data):
    calls=[];sources={};opened=[]
    for item in data.get('output',[]):
        if item.get('type')=='web_search_call' and item.get('status') in (None,'completed'):
            action=item.get('action') or {};calls.append(action.get('type','search'))
            if action.get('type')=='open_page' and action.get('url'):opened.append(action['url'])
            for source in action.get('sources',[]):
                if isinstance(source,dict) and source.get('url'):sources[source['url']]=dict(url=source['url'],title=source.get('title',''))
        for content in item.get('content',[]):
            for annotation in content.get('annotations',[]):
                if annotation.get('type')=='url_citation' and annotation.get('url'):sources[annotation['url']]=dict(url=annotation['url'],title=annotation.get('title',''))
    valid=[]
    for source in sources.values():
        try:
            _,host=safe_web.parse_url(source['url'])
            try:literal=ipaddress.ip_address(host)
            except ValueError:literal=None
            if literal and not safe_web.is_public(host):continue
        except (ValueError,TypeError):continue
        valid.append(source)
    return dict(verified=bool(calls and valid),calls=calls,sources=valid,opened_urls=opened)

def remember(s,connection,result):
    with _lock:_cache[model_probe.identity(s,connection)]=(time.monotonic()+3600,result)

def cached(s,connection):
    with _lock:entry=_cache.get(model_probe.identity(s,connection))
    return entry[1] if entry and entry[0]>time.monotonic() else None

def search(s,purpose,payload,connection=None,force=False,require_proof=True):
    connection=connection or s.connection_input()
    known=cached(s,connection)
    if not force and known and known['status']=='unsupported':raise RuntimeError(known['message'])
    tool=known.get('tool','web_search') if known else 'web_search'
    try:answer=s.ai(purpose,{**payload,'__web_search':tool},connection)
    except Exception as error:
        message=s.credentials.redact(error)
        # Only a definitive schema rejection justifies a compatibility attempt.
        unsupported=any(x in message.lower() for x in ('not support','unsupported','unknown tool','invalid tool','不支持'))
        if tool=='web_search' and unsupported:
            tool='web_search_preview'
            try:answer=s.ai(purpose+' · 兼容搜索工具',{**payload,'__web_search':tool},connection)
            except Exception as second:
                result=dict(status='unsupported',tool=tool,message='API 联网工具不可用：'+s.credentials.redact(second)[:240]);remember(s,connection,result);raise RuntimeError(result['message']) from None
        else:raise
    proof=answer.get('__web_evidence',{}) if isinstance(answer,dict) else {}
    if require_proof and not proof.get('verified'):
        result=dict(status='unconfirmed',tool=tool,message='接口未提供实际搜索工具调用及来源证据，未确认 API 联网能力')
        remember(s,connection,result);raise RuntimeError(result['message'])
    if proof.get('verified'):remember(s,connection,dict(status='supported',tool=tool,message='已确认 API 联网搜索：实际工具调用及来源已返回'))
    if '__web_text' in answer and not payload.get('__probe_only'):
        text=answer['__web_text'].strip()
        if not text:
            response_id=answer.get('__response_id')
            if not response_id:raise RuntimeError('API 执行了搜索但没有返回最终答案或可续接响应ID，任务未完成')
            s.task_progress('API 搜索已执行但仅返回工具结果，续接同一响应索取最终答案')
            try:answer=s.ai(purpose+' · 搜索后最终答案',dict(task='请使用此前已完成搜索的内容给出最终答案，不重新搜索；按照目标结构返回JSON，无法确定留空，不编造。',target=payload.get('task',''),__previous_response_id=response_id),connection)
            except Exception as error:
                # Some OpenAI-compatible gateways do not retain prior responses.
                # Run one self-contained search instead of depending on that state.
                s.task_progress('网关无法续接上一条搜索响应：'+s.credentials.redact(error)[:160]+'；改为独立重新搜索一次')
                retry=dict(payload);retry['final_answer_requirement']='搜索后必须在同一个响应中直接输出最终 JSON，不要只返回工具调用。'
                answer=s.ai(purpose+' · 独立重新搜索',{**retry,'__web_search':tool},connection)
                proof=answer.get('__web_evidence',{}) if isinstance(answer,dict) else {}
                if '__web_text' in answer:
                    text=answer['__web_text'].strip()
                    if not text:raise RuntimeError('API 重新搜索后仍未返回最终答案，任务未完成') from None
                    answer=s.ai(purpose+' · 来源结果结构化',dict(task='只整理本次已完成的联网结果，不再检索，不凭记忆补充。遵循下面目标结构输出严格 JSON。只保留材料中明确的事实与实际来源URL；未知留空。',target=payload.get('task',''),search_result=text,sources=proof.get('sources',[])),connection)
        else:
            s.task_progress('联网已取得带来源内容，独立整理结构化题录，不重复搜索')
            answer=s.ai(purpose+' · 来源结果结构化',dict(task='只整理本次已完成的联网结果，不再检索，不凭记忆补充。遵循下面目标结构输出严格 JSON。只保留材料中明确的事实与实际来源URL；未知留空。',target=payload.get('task',''),search_result=text,sources=proof.get('sources',[])),connection)
        answer['__web_evidence']=proof
    return answer,proof

def probe(s,connection):
    try:
        _,proof=search(s,'模型联网能力测试',dict(task='实际调用联网搜索工具，查找 Python 官方文档页面，打开页面并返回严格 JSON：{"title":"网页标题","url":"实际来源链接"}。不要仅凭记忆回答，保留工具调用与来源引用。',__probe_only=True),connection,force=True)
        return dict(status='supported',supported=True,message='支持：已返回实际搜索调用和来源证据',sources=proof['sources'][:3])
    except Exception as error:
        message=s.credentials.redact(error)[:300]
        s.log_problem('模型联网','能力测试',message)
        return dict(status='unconfirmed',supported=False,message=message)

def _clean_identifier(value,prefix=''):
    value=str(value or '').strip()
    if not value:return ''
    if prefix=='doi':
        value=re.sub(r'^(?:https?://)?(?:dx\.)?doi\.org/','',value,flags=re.I)
        value=re.sub(r'^doi:\s*','',value,flags=re.I)
        value=value.rstrip('.,;)').lower()
        arxiv=re.fullmatch(r'10\.48550/arxiv\.(\d{4}\.\d{4,5})(?:v\d+)?',value,re.I)
        return 'arxiv:'+arxiv.group(1).lower() if arxiv else value
    if prefix=='arxiv':
        value=re.sub(r'^(?:https?://)?(?:www\.)?arxiv\.org/(?:abs|pdf|html)/','',value,flags=re.I)
        value=re.sub(r'^arxiv:\s*','',value,flags=re.I)
        value=re.sub(r'(?i)^10\.48550/arxiv\.','',value)
        return re.sub(r'v\d+(?:\.pdf)?$','',value.rstrip('/'),flags=re.I).lower()
    return value

PREPRINT_KINDS=('preprint','arxiv','working paper')
PREPRINT_VENUES=('arxiv','biorxiv','medrxiv','preprint','corr','arxiv preprint')

def is_preprint_venue(value):
    value=re.sub(r'\s+',' ',str(value or '').strip().lower())
    return value in PREPRINT_VENUES or value.startswith('arxiv')

def _formal_doi(item):
    doi=_clean_identifier(item.get('doi'),'doi')
    return doi if doi and not doi.startswith('arxiv:') else ''

def _is_formal_publication(item):
    """A non-arXiv DOI or a non-preprint venue is formal, even when an arXiv copy is also linked."""
    if not isinstance(item,dict):return False
    kind=str(item.get('publication_kind') or item.get('kind') or '').strip().lower()
    venue=str(item.get('venue') or '').strip()
    return bool(_formal_doi(item)) or bool(venue and not is_preprint_venue(venue) and kind not in PREPRINT_KINDS)

def _is_preprint(item):
    if not isinstance(item,dict) or _is_formal_publication(item):return False
    kind=str(item.get('publication_kind') or item.get('kind') or '').strip().lower()
    return kind in PREPRINT_KINDS or is_preprint_venue(item.get('venue')) or 'arxiv.org/' in str(item.get('url') or '').lower() or bool(_clean_identifier(item.get('arxiv'),'arxiv'))

def _split_versions(item):
    """Separate a mixed API record into formal and arXiv versions."""
    formal=_is_formal_publication(item)
    arxiv=_clean_identifier(item.get('arxiv'),'arxiv')
    url=str(item.get('url') or '').strip()
    if not formal or not (arxiv or 'arxiv.org/' in url.lower()):return [item]
    arxiv=arxiv or _clean_identifier(url,'arxiv')
    links=[x for x in item.get('publication_links',[]) if isinstance(x,str) and 'arxiv.org/' not in x.lower()]
    doi=_formal_doi(item)
    formal_url=url if url and 'arxiv.org/' not in url.lower() else links[0] if links else 'https://doi.org/'+doi if doi else ''
    published=dict(item,url=formal_url,arxiv='',publication_links=links)
    preprint=dict(item,kind='preprint',publication_kind='preprint',venue='arXiv',doi='',url=url if 'arxiv.org/' in url.lower() else 'https://arxiv.org/abs/'+arxiv,arxiv=arxiv,publication_links=[],published='',year=None)
    return [published,preprint]

def _candidate_key(item):
    doi=_clean_identifier(item.get('doi'),'doi')
    arxiv=_clean_identifier(item.get('arxiv'),'arxiv')
    if doi.startswith('arxiv:'):arxiv=arxiv or doi.removeprefix('arxiv:');doi=''
    if doi:return 'doi:'+doi
    if arxiv:return 'arxiv:'+arxiv
    title=re.sub(r'[^a-z0-9\u4e00-\u9fff]','',str(item.get('title') or '').lower())
    return 'title:'+title if title else 'url:'+str(item.get('url') or '').rstrip('/').lower()

def _normalize_research_items(answer):
    raw=answer.get('papers',[]) if isinstance(answer,dict) else []
    if not isinstance(raw,list):raise ValueError('API 返回的 papers 应为列表')
    out=[]
    for item in raw:
        if not isinstance(item,dict):continue
        cleaned={key:str(item.get(key) or '').strip() for key in ('title','authors','published','venue','url','summary')}
        cleaned['publication_kind']=str(item.get('publication_kind') or item.get('kind') or '').strip()
        cleaned['doi']=_clean_identifier(item.get('doi'),'doi')
        cleaned['arxiv']=_clean_identifier(item.get('arxiv'),'arxiv')
        if cleaned['doi'].startswith('arxiv:'):
            cleaned['arxiv']=cleaned['arxiv'] or cleaned['doi'].removeprefix('arxiv:')
            cleaned['doi']=''
        cleaned['year']=item.get('year') if type(item.get('year')) is int else None
        sources=item.get('sources',[])
        cleaned['sources']=[dict(title=str(x.get('title') or ''),url=str(x.get('url') or '')) for x in sources if isinstance(x,dict) and str(x.get('url') or '').strip()] if isinstance(sources,list) else []
        cleaned['publication_links']=[str(x).strip() for x in item.get('publication_links',[]) if isinstance(x,str) and str(x).strip()] if isinstance(item.get('publication_links',[]),list) else []
        cleaned['versions']=[dict(x) for x in item.get('versions',[]) if isinstance(x,dict)] if isinstance(item.get('versions',[]),list) else []
        if not cleaned['versions'] and any(cleaned.get(k) for k in ('doi','arxiv','venue','url')):
            cleaned['versions']=[dict(kind=cleaned['publication_kind'] or 'unknown',title=cleaned['title'],authors=cleaned['authors'],doi=cleaned['doi'],arxiv=cleaned['arxiv'],venue=cleaned['venue'],url=cleaned['url'],published=cleaned['published'],year=cleaned['year'],sources=cleaned['sources'],summary=cleaned['summary'])]
        cleaned['versions']=[part for version in cleaned['versions'] for part in _split_versions(version)]
        if _is_formal_publication(cleaned) and 'arxiv.org/' in cleaned['url'].lower():
            cleaned['url']=next((x.get('url','') for x in cleaned['versions'] if _is_formal_publication(x) and x.get('url')),'')
        out.append(cleaned)
    return out

def _title_key(item):
    return re.sub(r'[^a-z0-9\u4e00-\u9fff]','',str(item.get('title') or '').lower())

def _same_work(left,right):
    if not _title_key(left) or _title_key(left)!=_title_key(right):return False
    if left.get('year') and right.get('year') and abs(left['year']-right['year'])>1:return False
    ld=_clean_identifier(left.get('doi'),'doi');rd=_clean_identifier(right.get('doi'),'doi')
    if ld and rd and not ld.startswith('arxiv:') and not rd.startswith('arxiv:') and ld!=rd:return False
    la=_clean_identifier(left.get('arxiv'),'arxiv') or (ld.removeprefix('arxiv:') if ld.startswith('arxiv:') else '')
    ra=_clean_identifier(right.get('arxiv'),'arxiv') or (rd.removeprefix('arxiv:') if rd.startswith('arxiv:') else '')
    if la and ra and la!=ra:return False
    # Exact title plus compatible year and identifiers is sufficient for version grouping;
    # author variants often differ only because publishers abbreviate given names.
    return True

def _merge_research_items(items):
    merged={}
    for item in items:
        key=_candidate_key(item)
        if not key:continue
        existing_key=next((candidate_key for candidate_key,old in merged.items() if candidate_key==key or _same_work(old,item)),None)
        if existing_key is None:
            merged[key]=dict(item)
            continue
        old=merged[existing_key]
        if _is_formal_publication(item) and not _is_formal_publication(old):
            previous=dict(old)
            versions=old.get('versions',[])+item.get('versions',[])
            sources=old.get('sources',[])+item.get('sources',[])
            links=old.get('publication_links',[])+item.get('publication_links',[])
            old.update(item)
            for field in ('title','authors','published','year','venue','doi','arxiv','url','summary','publication_kind'):
                if not old.get(field) and previous.get(field):old[field]=previous[field]
            old['versions']=versions
            old['sources']=sources
            old['publication_links']=links
        for field in ('title','authors','published','year','venue','doi','arxiv','url','summary','publication_kind'):
            if not old.get(field) and item.get(field):old[field]=item[field]
        old['sources']=list({(x.get('url',''),x.get('title','')):x for x in old.get('sources',[])+item.get('sources',[])}.values())
        old['publication_links']=list(dict.fromkeys(old.get('publication_links',[])+item.get('publication_links',[])))
        old['versions']=list({(x.get('kind',''),x.get('doi',''),x.get('arxiv',''),x.get('url','')):x for x in old.get('versions',[])+item.get('versions',[])}.values())
    return list(merged.values())

def select_research_items(items,metadata):
    """Associate API candidates with the uploaded work before applying their claims."""
    title=re.sub(r'[^a-z0-9\u4e00-\u9fff]','',str(metadata.get('title') or '').lower())
    target_doi=_clean_identifier(metadata.get('doi'),'doi')
    target_arxiv=_clean_identifier(metadata.get('arxiv'),'arxiv')
    if target_doi.startswith('arxiv:'):
        target_arxiv=target_arxiv or target_doi.removeprefix('arxiv:');target_doi=''
    matched=[];conflicts=[]
    for item in items:
        doi=_clean_identifier(item.get('doi'),'doi')
        arxiv=_clean_identifier(item.get('arxiv'),'arxiv')
        if doi.startswith('arxiv:'):arxiv=arxiv or doi.removeprefix('arxiv:');doi=''
        id_match=bool(target_doi and doi==target_doi or target_arxiv and arxiv==target_arxiv)
        title_match=bool(title and _title_key(item)==title)
        if title_match and target_doi and doi and doi!=target_doi:
            if not id_match:conflicts.append(item);continue
        # arXiv IDs are occasionally copied incorrectly in uploaded metadata.
        # An exact title match may correct that identifier; keep it for version
        # reconciliation instead of discarding the actual publication record.
        if id_match or title_match:matched.append(item)
    # Prefer a formal version among records linked to the same title/identifier.
    matched.sort(key=lambda x:(not _is_formal_publication(x),not bool(target_arxiv and x.get('arxiv')==target_arxiv),not bool(target_doi and x.get('doi')==target_doi)))
    # A model may normalize punctuation or translate a title while still returning
    # a source-backed candidate.  Without an uploaded DOI/arXiv identifier, keep
    # such candidates for the API-owned conclusion instead of silently discarding
    # them; identifier conflicts remain excluded above.
    if not matched and not conflicts and not (target_doi or target_arxiv):
        return list(items),conflicts
    return matched,conflicts

def research(s,metadata):
    """API-owned publication research with a mandatory follow-up when only a preprint is found."""
    paper={k:metadata.get(k,'') for k in ('title','doi','arxiv','url','authors','year','venue')}
    answer,proof=search(s,'论文发表信息联网搜索',dict(task='全权负责此论文的联网调研。先根据准确题名、作者、DOI及已有链接实际联网搜索。必须同时判断：1）上传材料对应的预印本版本；2）是否存在正式期刊、会议或出版社版本。已有 arXiv 绝不能作为终点；如果只找到 arXiv，返回该预印本并明确需要继续查正式版本。不要凭记忆编造，所有返回链接必须来自本次搜索结果。返回 {"papers":[{"title":"题名","authors":"作者","published":"YYYY-MM-DD或空","year":2017,"venue":"期刊／会议名称或空","doi":"DOI或空","arxiv":"arXiv ID或空","publication_kind":"journal/conference/preprint/unknown","url":"论文原文或发表页面链接","publication_links":["正式发表链接"],"sources":[{"title":"来源名称","url":"来源链接"}],"summary":"调研结论和不确定之处"}]}，未查到返回空 papers。',paper=paper,today=s.now()[:10]),require_proof=False)
    rounds=[dict(name='初始题名与标识符搜索',proof=proof)]
    items=_normalize_research_items(answer)
    first_relevant,_=select_research_items(items,paper)
    if not any(_is_formal_publication(item) for item in first_relevant):
        s.task_progress('初次仅找到预印本或未确认发表平台；继续联网搜索正式版本')
        try:
            follow,follow_proof=search(s,'论文正式发表版本定向搜索',dict(task='这是同一篇论文的第二轮真实联网搜索，不要只整理上一次结果。根据准确题名、作者、arXiv ID、DOI和已有候选来源，专门查找正式发表版本：期刊页面、会议论文集、出版社页面、DOI 页面或机构库中明确的 published version。若候选是 arXiv，必须继续搜索其 journal reference、conference version、DOI 和正式出版页面。比较题目、作者、年份后再判断是否同一篇论文；不确定时留空并说明原因。所有链接必须来自本轮实际搜索。返回与上一轮相同的 JSON 结构；没有正式版本仍保留空 papers 或明确返回 publication_kind=preprint。',paper=paper,initial_candidates=[dict(title=x.get('title'),authors=x.get('authors'),venue=x.get('venue'),doi=x.get('doi'),arxiv=x.get('arxiv'),url=x.get('url')) for x in items[:8]],today=s.now()[:10]),connection=None,force=True,require_proof=False)
            rounds.append(dict(name='正式发表版本定向搜索',proof=follow_proof))
            items.extend(_normalize_research_items(follow))
        except Exception as error:
            rounds.append(dict(name='正式发表版本定向搜索',proof={},error=s.credentials.redact(error)[:300]))
    out=_merge_research_items(items)
    all_sources=[]
    for round_info in rounds:
        all_sources.extend(round_info['proof'].get('sources',[]) if isinstance(round_info.get('proof'),dict) else [])
    proof=dict(verified=any(bool(x.get('proof',{}).get('verified')) for x in rounds),calls=[call for x in rounds for call in (x.get('proof') or {}).get('calls',[])],sources=list({x.get('url'):x for x in all_sources if x.get('url')}.values()),opened_urls=list(dict.fromkeys(url for x in rounds for url in (x.get('proof') or {}).get('opened_urls',[]))),rounds=[dict(name=x['name'],source_count=len((x.get('proof') or {}).get('sources',[])),error=x.get('error','')) for x in rounds],diagnostics=[dict(stage=x['name'],message=x['error']) for x in rounds if x.get('error')])
    return out,proof

def discover(s,queries):
    answer,proof=search(s,'推荐论文 API 联网调研',dict(task='按给定研究角度实际联网调研较新论文；返回 {"papers":[{"title":"准确题名","url":"本次工具实际来源URL"}]}。不凭记忆补造链接；相关机制和路线均可，不要求全部关键词同时命中。',queries=queries,today=s.now()[:10]))
    urls={x['url'] for x in proof['sources']}
    return [dict(url=p['url'],title=p.get('title','')) for p in answer.get('papers',[]) if isinstance(p,dict) and p.get('url') in urls]
