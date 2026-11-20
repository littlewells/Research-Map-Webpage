"""Public-only web transport with pinned IPs and proxy-compatible DNS fallback."""
import http.client
import ipaddress
import json
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request
import task_control

_cache={}
_lock=threading.Lock()
_fake_ranges=(ipaddress.ip_network('198.18.0.0/15'),ipaddress.ip_network('2001:2::/48'))

def is_public(value):
    address=ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast

def parse_url(url):
    parsed=urllib.parse.urlsplit(url)
    host=parsed.hostname or ''
    if parsed.scheme not in ('http','https') or not host or parsed.username or parsed.password:
        raise ValueError('只允许公开论文网页地址')
    if parsed.port not in (None,80,443):raise ValueError('不允许非标准网页端口')
    host=host.rstrip('.').encode('idna').decode('ascii').lower()
    if host=='localhost' or host.endswith(('.localhost','.local','.internal')) or '.' not in host:
        raise ValueError('拒绝本机、内网或特殊网络地址')
    return parsed,host

def resolve_doh(host):
    # This endpoint is fixed, TLS-verified and uses the configured system HTTP proxy.
    url='https://dns.google/resolve?'+urllib.parse.urlencode({'name':host,'type':'A'})
    request=urllib.request.Request(url,headers={'Accept':'application/dns-json','User-Agent':'ResearchMap/2.0'})
    with urllib.request.urlopen(request,timeout=15) as response:
        raw=response.read(65537)
        if len(raw)>65536:raise ValueError('DNS 响应过大')
    data=json.loads(raw)
    if data.get('Status')!=0:raise ValueError('公共 DNS 未解析到论文站点')
    addresses=list(dict.fromkeys(x['data'] for x in data.get('Answer',[]) if x.get('type') in (1,28)))
    if not addresses or not all(is_public(ip) for ip in addresses):
        raise ValueError('公共 DNS 未返回安全公网地址')
    return addresses

def public_addresses(host):
    try:
        literal=ipaddress.ip_address(host)
    except ValueError:
        literal=None
    if literal is not None:
        if not is_public(host):raise ValueError('拒绝本机、内网或特殊网络地址')
        return [host]
    try:addresses=sorted({item[4][0] for item in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)})
    except socket.gaierror:addresses=[]
    if addresses and all(is_public(ip) for ip in addresses):return addresses
    # Only known fake-IP ranges may use fallback. Private DNS answers stay blocked.
    if addresses and any(not is_public(ip) and not any(ipaddress.ip_address(ip) in network for network in _fake_ranges) for ip in addresses):
        raise ValueError('拒绝本机、内网或特殊网络地址')
    with _lock:saved=_cache.get(host)
    if saved and saved[0]>time.monotonic():return list(saved[1])
    try:verified=resolve_doh(host)
    except Exception as error:raise ValueError('无法取得已验证的公网 DNS 地址，请检查代理或网络：'+str(error)[:180]) from None
    with _lock:_cache[host]=(time.monotonic()+60,tuple(verified))
    return verified

def validate(url):
    _,host=parse_url(url)
    public_addresses(host)
    return url

def connect(parsed,host,address):
    port=parsed.port or (443 if parsed.scheme=='https' else 80)
    proxy=urllib.request.getproxies().get(parsed.scheme)
    if proxy:
        proxy=urllib.parse.urlsplit(proxy if '://' in proxy else 'http://'+proxy)
        if proxy.scheme!='http' or not proxy.hostname or proxy.username or proxy.password:
            raise ValueError('网页调研仅支持无认证的系统 HTTP 代理')
        tunnel=http.client.HTTPConnection(proxy.hostname,proxy.port or 80,timeout=20)
        tunnel.set_tunnel(address,port)
        try:tunnel.connect();sock=tunnel.sock;tunnel.sock=None
        except Exception:tunnel.close();raise
    else:sock=socket.create_connection((address,port),timeout=20)
    try:
        if parsed.scheme=='https':
            sock=ssl.create_default_context().wrap_socket(sock,server_hostname=host)
        connection=http.client.HTTPConnection(host,port,timeout=20)
        connection.sock=sock
        return connection
    except Exception:sock.close();raise

def fetch(url,limit=1500000):
    return task_control.io_call(lambda:_fetch(url,limit))

def _fetch(url,limit=1500000):
    visited=set()
    for _ in range(6):
        task_control.check()
        if url in visited:raise ValueError('论文网页重定向循环')
        visited.add(url)
        parsed,host=parse_url(url);addresses=public_addresses(host)
        connection=None;response=None;last=None
        for address in addresses:
            try:
                connection=connect(parsed,host,address)
                path=urllib.parse.urlunsplit(('', '',parsed.path or '/',parsed.query,''))
                connection.request('GET',path,headers={'Host':host,'User-Agent':'ResearchMap/2.0 (public scholarly reader)','Accept':'text/html,application/xhtml+xml,application/xml,text/xml','Accept-Encoding':'identity'})
                response=connection.getresponse();break
            except (OSError,http.client.HTTPException) as error:
                if connection:connection.close()
                last=error
        if response is None:raise RuntimeError('论文网页连接失败：'+str(last)[:180])
        try:
            if response.status in (301,302,303,307,308):
                target=response.getheader('Location')
                if not target:raise ValueError('重定向没有目标地址')
                target=urllib.parse.urljoin(url,target)
                if parsed.scheme=='https' and urllib.parse.urlsplit(target).scheme!='https':
                    raise ValueError('拒绝 HTTPS 降级重定向')
                url=target;continue
            if response.status!=200:raise RuntimeError('论文网页 HTTP '+str(response.status))
            kind=response.getheader('Content-Type','').lower()
            if not any(x in kind for x in ('html','xml','text/')):raise ValueError('此地址不是可读取的论文网页')
            raw=response.read(limit+1)
            if len(raw)>limit:raise ValueError('网页超过读取上限，未截断冒充完整内容')
            charset='utf-8'
            for part in kind.split(';')[1:]:
                if part.strip().startswith('charset='):charset=part.split('=',1)[1].strip(' "\'')
            try:return raw.decode(charset,errors='replace'),url
            except LookupError:return raw.decode('utf-8',errors='replace'),url
        finally:connection.close()
    raise ValueError('论文网页重定向次数过多')
