"""Cooperative cancellation and cancellable I/O waits scoped to one task."""
import contextvars
import threading
import time
from contextlib import contextmanager

class Cancelled(BaseException):
    pass

CURRENT=contextvars.ContextVar('task_cancellation',default=None)

class Token:
    def __init__(self,parent=None):
        self.event=threading.Event()
        self.cleared=False
        self.parent=parent
    def cancel(self):self.event.set()

def check():
    token=CURRENT.get()
    while token:
        if token.event.is_set():raise Cancelled('任务已手动中断')
        token=token.parent

@contextmanager
def scope(token):
    previous=CURRENT.set(token)
    try:yield
    finally:CURRENT.reset(previous)

def wait(seconds):
    token=CURRENT.get()
    if token:
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            check();token.event.wait(min(.1,max(0,end-time.monotonic())))
        check()
    else:threading.Event().wait(seconds)

def io_call(work):
    """Stop the task's wait promptly; discard a late external response."""
    token=CURRENT.get()
    if token is None:return work()
    check();done=threading.Event();result=[];context=contextvars.copy_context()
    def run():
        try:result.append((True,context.run(work)))
        except BaseException as error:result.append((False,error))
        finally:done.set()
    threading.Thread(target=run,daemon=True).start()
    while not done.wait(.1):check()
    check()
    if not result[0][0]:raise result[0][1]
    return result[0][1]
