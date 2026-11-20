"""Run the Windows service in the console; retire recorded detached legacy instances."""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import signal
import socket
import sys
import urllib.error
import urllib.request

CODE_ROOT=Path(__file__).resolve().parent
ROOT=CODE_ROOT.parent
DATA=ROOT/'data'
CACHE=ROOT/'cache'
CACHE.mkdir(parents=True,exist_ok=True)
STATE=CACHE/'portable-process.json'
LEGACY_STATE=DATA/'portable-process.json'
sys.pycache_prefix=str(CACHE/'bytecode')

def runtime(port,timeout=.4):
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open('http://127.0.0.1:'+str(port)+'/api/runtime',timeout=timeout) as response:
            return json.load(response)
    except (OSError,ValueError):return None

def same_folder(info):
    return bool(info and info.get('application')=='research-map' and Path(info.get('root','')).resolve()==ROOT.resolve() and Path(info.get('data',str(DATA))).resolve()==DATA.resolve())

def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.4):return True
    except OSError:return False

def terminate_process(pid):
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype=wintypes.BOOL
    kernel.TerminateProcess.argtypes=[wintypes.HANDLE,wintypes.UINT]
    kernel.TerminateProcess.restype=wintypes.BOOL
    kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.WaitForSingleObject.restype=wintypes.DWORD
    kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL
    handle=kernel.OpenProcess(0x1000|0x0001|0x00100000,False,pid)
    if not handle:raise RuntimeError('Cannot inspect the recorded service process.')
    try:
        size=wintypes.DWORD(32768);buffer=ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle,0,buffer,ctypes.byref(size)):raise RuntimeError('Cannot verify service executable.')
        if Path(buffer.value).resolve()!=Path(sys.executable).resolve():raise RuntimeError('Executable mismatch; nothing stopped.')
        if not kernel.TerminateProcess(handle,0):raise RuntimeError('Could not stop service.')
        if kernel.WaitForSingleObject(handle,5000)!=0:raise RuntimeError('Service process did not exit; stop not confirmed.')
    finally:kernel.CloseHandle(handle)

def stop():
    state=None
    for record in (STATE,LEGACY_STATE):
        if record.exists():
            try:
                state=json.loads(record.read_text(encoding='utf-8'))
                break
            except (OSError,ValueError):pass
    ports=list(range(8765,8785))
    if state and type(state.get('port')) is int and 1<=state['port']<=65535:ports=list(dict.fromkeys([state['port']]+ports))
    targets=[]
    for port in ports:
        info=runtime(port)
        if not info and port_open(port):info=runtime(port,timeout=3)
        if not info:
            if state and port==state.get('port') and port_open(port):raise RuntimeError('Recorded port is still listening but service identity cannot be verified; stop not confirmed. Retry after current requests finish.')
            continue
        if not same_folder(info):
            if state and port==state.get('port'):raise RuntimeError('Service identity changed; nothing stopped.')
            continue
        pid=info.get('pid') or (state.get('pid') if state and state.get('port')==port else None)
        if type(pid) is not int or pid<=0:raise RuntimeError('Cannot verify service PID. Keep this window open and check the running service.')
        targets.append((port,pid))
    # Verify every matching service is idle before stopping any of them.
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for port,pid in targets:
        with opener.open('http://127.0.0.1:'+str(port)+'/api/state',timeout=3) as response:current=json.load(response)
        if current.get('tasks'):raise RuntimeError('Tasks are still running; finish or interrupt them in Task Center before stopping.')
    for port,pid in targets:
        info=runtime(port,timeout=3)
        if not same_folder(info) or info.get('pid',pid)!=pid:raise RuntimeError('Service changed before stopping; stop not confirmed.')
        terminate_process(pid)
    for port,pid in targets:
        if runtime(port,timeout=1) or port_open(port):raise RuntimeError('Port '+str(port)+' still responds; stop not confirmed. Process record retained.')
    STATE.unlink(missing_ok=True);LEGACY_STATE.unlink(missing_ok=True)
    print('Research Map stopped; service ports are closed.' if targets else 'No running Research Map service found in this folder.')
    print('An already-open webpage may still show loaded content; refreshing or saving now requires starting the service again.')

def launch(no_open=False,no_refresh=False):
    import server
    # Older portable versions owned a detached process and left a process record.
    for record in (STATE,LEGACY_STATE):
        try:
            state=json.loads(record.read_text(encoding='utf-8'))
        except (OSError,ValueError):
            continue
        port=state.get('port') if isinstance(state,dict) else None
        if type(port) is not int or not 1<=port<=65535:continue
        info=runtime(port)
        if same_folder(info) and info.get('pid')==state.get('pid') and info.get('code_fingerprint')!=server.LOADED_CODE_FINGERPRINT:
            stop()
            break
    if hasattr(signal,'SIGBREAK'):signal.signal(signal.SIGBREAK,signal.default_int_handler)
    args=['--auto-port']
    if not no_open:args.append('--open')
    if no_refresh:args.append('--no-refresh')
    server.main(args)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--no-open',action='store_true');parser.add_argument('--no-refresh',action='store_true');args=parser.parse_args()
    try:
        launch(args.no_open,args.no_refresh)
    except Exception as error:
        print('Research Map: '+str(error),file=sys.stderr);raise SystemExit(1)
