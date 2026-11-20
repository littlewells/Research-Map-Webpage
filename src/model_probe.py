"""Text connection and verified low-reasoning extraction capability; no PDF requests."""
import hashlib
import threading
import time

_extraction_cache={}
_lock=threading.Lock()

def identity(s,connection):
    supplied,key=connection;cfg={**s.config(),**supplied}
    return hashlib.sha256(('\0'.join((str(s.DATA.resolve()),cfg['base_url'],cfg['model'],cfg.get('network_mode','auto'),key))).encode()).digest()

def capability(s):
    return dict(supported=False,status='disabled',message='PDF 固定本地解析，不测试或使用模型原生 PDF 能力')

def extraction_options(s,connection):
    with _lock:saved=_extraction_cache.get(identity(s,connection))
    return {'reasoning':{'effort':'none'}} if saved and saved[0]>time.monotonic() and saved[1] else {}

def probe_extraction(s,connection):
    try:
        answer=s.ai('快速提取模式测试',dict(task='仅复制给定字段，不分析。返回 {"title":"Research Map Check","year":2026}。',__reasoning_probe=True),connection)
        verified=answer.get('title')=='Research Map Check' and answer.get('year')==2026 and answer.get('__reasoning_tokens')==0
        message='已验证非思考提取；综合评分保留默认推理' if verified else '未确认非思考模式；保留接口默认方式，本地提取优化仍生效'
    except Exception as error:
        verified=False;message='接口未确认非思考模式，保留默认方式：'+s.credentials.redact(error)[:180]
    with _lock:_extraction_cache[identity(s,connection)]=(time.monotonic()+21600,verified)
    return dict(verified=verified,message=message)

def test_connection(s,connection,probe_fast=True):
    text=s.ai('连接测试',dict(task='只返回 {"ok":true}'),connection)
    if text.get('ok') is not True:raise RuntimeError('模型返回内容未通过文字连接校验')
    result=dict(text=dict(ok=True,message='文字连接成功'),reading_mode='本地解析及交叉验证后，将文字交给 API 阅读')
    if probe_fast:result['extraction']=probe_extraction(s,connection)
    import model_web
    result['web']=model_web.probe(s,connection)
    if not result['web']['supported']:result['warning']='文字连接成功，API 联网能力未确认；请查看联网测试详情'
    return result
