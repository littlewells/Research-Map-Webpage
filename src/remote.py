"""Bounded retry, host pacing and shared cooldown for external services."""
import datetime as dt
import email.utils
import json
import hashlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import credentials
import contextvars
from contextlib import contextmanager
import socket
import ssl
import task_control

NETWORK_MODE=contextvars.ContextVar('model_network_mode',default='system')
NETWORK_MODES=('auto','system','direct')
DEFAULT_MODEL_NETWORK='auto'

@contextmanager
def network(mode):
    if mode not in NETWORK_MODES:raise ValueError('网络方式无效')
    token=NETWORK_MODE.set(mode)
    try:yield
    finally:NETWORK_MODE.reset(token)

def connection_error(error):
    reason=getattr(error,'reason',error)
    if isinstance(reason,ssl.SSLCertVerificationError):
        return 'TLS 证书验证失败，请检查域名、证书链及单位根证书；未关闭证书校验'
    if isinstance(reason,ssl.SSLError):
        return 'TLS 握手失败（'+getattr(reason,'reason',type(reason).__name__)+'）；请核对 https/端口及 VPN、内网 DNS、代理路由，尚未进入密钥或模型校验'
    if isinstance(reason,socket.gaierror):return 'DNS 解析失败，请检查域名、VPN 或内网 DNS'
    if isinstance(reason,(TimeoutError,socket.timeout)):return '连接或响应超时；请检查网络路由及服务状态，本次 POST 未自动重发'
    if isinstance(reason,ConnectionRefusedError):return '目标拒绝连接，请检查地址、端口和服务是否启动'
    return '连接失败（'+credentials.redact(str(reason))[:180]+'）'

class RemoteError(RuntimeError):
    def __init__(self,message,*,code=None):
        super().__init__(message)
        self.code=code

class RouteError(RemoteError):
    pass

_guard = threading.Lock()
_hosts = {}
_cache = {}
_routes = {}

def auto_fetch(url,body,headers,timeout,raw):
    probe_url=url.rsplit('/',1)[0]+'/models' if body is not None else url
    key=(probe_url,hashlib.sha256((headers or {}).get('Authorization','').encode()).digest())
    with _guard:
        cached=_routes.get(key)
    route=cached[0] if cached and cached[1]>time.monotonic() else None
    if not route or body is None:
        order=(route,'direct' if route=='system' else 'system') if route else ('system','direct')
        errors=[];unlisted=None
        for mode in order:
            try:
                with network(mode):result=fetch(probe_url,headers=headers,timeout=timeout if body is None else min(timeout,4),raw=raw if body is None else False,_probe=True)
            except (RouteError,json.JSONDecodeError) as error:
                errors.append(f'{mode}：{error}')
                continue
            except RemoteError as error:
                if error.code in (404,405) and body is not None:
                    if unlisted is None:unlisted=mode
                elif error.code not in (407,502,503,504):raise
                errors.append(f'{mode}：{error}')
                continue
            route=mode
            with _guard:
                if len(_routes)>=128:_routes.pop(next(iter(_routes)))
                _routes[key]=(route,time.monotonic()+60)
            if body is None:return result
            break
        else:
            if unlisted is None:raise RouteError('自动选路失败：'+'；'.join(errors))
            # Some gateways implement Responses but omit Models.
            route=unlisted
    try:
        with network(route):return fetch(url,body,headers,timeout,raw)
    except RouteError:
        with _guard:
            if _routes.get(key, (None,))[0]==route:_routes.pop(key,None)
        raise
def host_state(host):
    with _guard:
        return _hosts.setdefault(host, {'lock': threading.Lock(), 'next': 0., 'cooldown': 0.})

def retry_seconds(value):
    try:
        return max(0., float(value))
    except (TypeError, ValueError):
        try:
            return max(0., (email.utils.parsedate_to_datetime(value) - dt.datetime.now(dt.timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None

def interval(host):
    if host.endswith('semanticscholar.org'): return 1.1
    if host.endswith('arxiv.org'): return 3.1
    if host.endswith('bing.com'): return 2.0
    return .25

def fetch(url, body=None, headers=None, timeout=25, raw=False, *, _probe=False):
    task_control.check()
    if NETWORK_MODE.get()=='auto':return auto_fetch(url,body,headers,timeout,raw)
    host = urllib.parse.urlsplit(url).hostname or '远程服务'
    h = {'User-Agent': 'ResearchMap/1.0 (local literature manager)', 'Accept': 'application/json'}
    h.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    if data is not None: h['Content-Type'] = 'application/json'
    cache_key = hashlib.sha256((url + NETWORK_MODE.get() + str(raw) + json.dumps(h,sort_keys=True)).encode()).digest() if body is None and not _probe else None
    # Protect bookkeeping only. A slow response must not hold another request's lock.
    from contextlib import nullcontext
    with nullcontext():
        if cache_key:
            with _guard:
                saved = _cache.get(cache_key)
            if saved and saved[0] > time.monotonic():
                return saved[1] if raw else json.loads(saved[1])
        for attempt in range(3):
            task_control.check()
            try:
                request = urllib.request.Request(url, data=data, headers=h)
                open_request=urllib.request.urlopen if NETWORK_MODE.get()=='system' else urllib.request.build_opener(urllib.request.ProxyHandler({})).open
                def receive():
                    with open_request(request, timeout=timeout) as response:
                        return response.read(5000000) if raw else json.load(response)
                result=task_control.io_call(receive)
                if cache_key:
                    with _guard:
                        if len(_cache) >= 128:
                            _cache.pop(next(iter(_cache)))
                        _cache[cache_key] = (time.monotonic()+300,result if raw else json.dumps(result))
                return result
            except urllib.error.HTTPError as error:
                code = error.code
                delay = retry_seconds(error.headers.get('Retry-After')) if error.headers else None
                try:
                    payload = json.loads(error.read(8192))
                    detail = payload.get('error', payload) if isinstance(payload, dict) else {}
                    kind = str(detail.get('code', '') if isinstance(detail, dict) else '')
                    message=credentials.redact(str(detail.get('message','')) if isinstance(detail,dict) else str(detail))[:220]
                except (ValueError, OSError):
                    kind = ''
                    message=''
                quota = any(word in kind.lower() for word in ('insufficient_quota', 'billing', 'quota_exceeded'))
                # Retry only explicit rejection / transient GET responses. Never replay a timed-out model POST.
                transient = code == 429 or (body is None and code in (502, 503, 504))
                delay = delay if delay is not None else 2 ** (attempt + 1)
                if transient and not _probe and not quota and attempt < 2 and delay <= 8:
                    task_control.wait(max(delay,interval(host)))
                    continue
                if code == 429:
                    reason = '配额或余额不足，请检查供应商账户' if quota else '请求过于频繁或共享额度受限，本次请求已结束，其他任务不阻塞'
                    raise RemoteError(f'{host} HTTP 429：{reason}；建议约 {int(max(delay,60))} 秒后重试',code=code) from None
                if code in (401, 403):
                    raise RemoteError(f'{host} HTTP {code}：密钥无效或无访问权限，请检查模型连接',code=code) from None
                raise RemoteError(f'{host} HTTP {code}：'+(message or '远程服务未能完成请求'),code=code) from None
            except (urllib.error.URLError, TimeoutError) as error:
                raise RouteError(f'{host} '+connection_error(error)+'；网络方式：'+NETWORK_MODE.get()) from None
            except (ssl.SSLError,ConnectionError) as error:
                raise RouteError(f'{host} '+connection_error(error)+'；网络方式：'+NETWORK_MODE.get()) from None
