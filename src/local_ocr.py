"""Offline Chinese/English OCR; images and recognized full text stay in memory."""
import threading
from pathlib import Path

_lock=threading.Lock()
_engine=None

def read_page(page,regions=None,include_boxes=False):
    global _engine
    import numpy as np
    import pymupdf,rapidocr
    from rapidocr import RapidOCR
    models=Path(rapidocr.__file__).parent/'models'
    paths=dict(Det=models/'PP-OCRv6_det_small.onnx',Rec=models/'PP-OCRv6_rec_small.onnx',Cls=models/'ch_ppocr_mobile_v2.0_cls_mobile.onnx')
    if not all(p.is_file() for p in paths.values()):raise RuntimeError('离线 OCR 模型不完整；不在阅读期间联网下载')
    with _lock:
        if _engine is None:
            params={kind+'.model_path':str(path) for kind,path in paths.items()}
            params.update({'Global.log_level':'error','EngineConfig.onnxruntime.intra_op_num_threads':2,'EngineConfig.onnxruntime.inter_op_num_threads':1})
            _engine=RapidOCR(params=params)
        scale=3
        pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),alpha=False,colorspace=pymupdf.csRGB)
        image=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,3)
        result=_engine(image)
        pix=None;image=None
    if not result.txts or result.scores is None:raise RuntimeError('OCR 未识别出正文')
    if any(float(score)<.8 for score in result.scores):raise RuntimeError('OCR 存在低置信度文字，需要视觉复核')
    items=[]
    lines=[]
    for box,text in zip(result.boxes,result.txts):
        cx=float(box[:,0].mean())/scale;cy=float(box[:,1].mean())/scale
        rank=next((i for i,r in enumerate(regions or []) if r[0]<=cx<=r[2] and r[1]<=cy<=r[3]),len(regions or []))
        items.append(((rank,cy,cx),str(text)))
        lines.append(dict(text=str(text),bbox=(float(box[:,0].min())/scale,float(box[:,1].min())/scale,float(box[:,0].max())/scale,float(box[:,1].max())/scale),order=(rank,cy,cx)))
    text='\n'.join(text for _,text in sorted(items))
    return dict(text=text,lines=sorted(lines,key=lambda x:x['order'])) if include_boxes else text
