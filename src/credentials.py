"""Current-Windows-user DPAPI storage. Never stores plaintext or reads env keys."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import re
import threading

_known = set()
_lock = threading.Lock()

def remember(value):
    if value:
        with _lock:
            _known.add(value)
    return value

def redact(value):
    text = str(value)
    with _lock:
        for secret in _known:
            text = text.replace(secret, '[已隐藏]')
    return re.sub(r'(?i)(bearer\s+)[^\s"<>]+', r'\1[已隐藏]', text)

def validate(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 8192 or any(ord(c) < 32 for c in value):
        raise ValueError('请输入有效的 API Key')
    return remember(value.strip())

def _crypt(data, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('本机加密密钥保存需要 Windows 数据保护服务')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    args = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = args
    fn.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise RuntimeError('Windows 无法解密密钥，请在当前账户重新输入' if decrypt else 'Windows 无法加密密钥，未保存')
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)

def path(folder):
    return Path(folder) / 'model-credential.dpapi'

def configured(folder):
    return path(folder).is_file()

def load(folder):
    file = path(folder)
    if not file.exists():
        return ''
    return remember(_crypt(file.read_bytes(), True).decode('utf-8'))

def store(folder, value):
    encrypted = _crypt(validate(value).encode('utf-8'))
    file = path(folder)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix('.tmp')
    try:
        temporary.write_bytes(encrypted)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)

def clear(folder):
    path(folder).unlink(missing_ok=True)
