"""Reviewed official standard token prices; never infer an unrecognized model's price."""
import copy
import re

VERIFIED='2026-11-09'
LATEST='2026-11-13'
OPENAI='https://developers.openai.com/api/docs/pricing'
GOOGLE='https://ai.google.dev/gemini-api/docs/pricing'
DEEPSEEK='https://api-docs.deepseek.com/quick_start/pricing/'
CATALOG={
    'gpt-6-astra':(10,1,50,OPENAI),
    'gpt-6.1-sol':(2,.1,10,OPENAI),
    'gpt-6.1-terra':(1,.05,5,OPENAI),
    'gpt-6-luna':(.1,.01,.5,OPENAI),
    'gemini-3.8-flash':(.75,.075,3.75,GOOGLE),
    'deepseek-flash':(.3,.006,1.2,DEEPSEEK),
    'deepseek-v4-pro':(1.32,.044,3.96,DEEPSEEK),
    'glm-5.3':(8,2,28,'https://docs.bigmodel.cn/cn/guide/start/pricing'),
    'glm-5.3-flash':(.8,.23,2.8,'https://docs.bigmodel.cn/cn/guide/start/pricing'),
    'glm-5.3-flashx':(2,.57,7,'https://docs.bigmodel.cn/cn/guide/start/pricing'),
    'minimax-m3':(2.1,.42,8.4,'https://platform.minimaxi.com/docs/guides/pricing-paygo'),
    'doubao-seed-2.1-turbo':(3,.6,15,'https://www.volcengine.com/docs/82379/1544106'),
}

def canonical(model):
    value=str(model).lower()
    if re.fullmatch(r'deepseek-(?:v4(?:\.1)?-flash|flash)(?:-vision-exp|-ga-\d{6}|-\d{4})?',value):return 'deepseek-flash'
    if re.fullmatch(r'deepseek-v4-pro(?:-ga-\d{6}|-\d{4})?',value):return 'deepseek-v4-pro'
    if re.fullmatch(r'glm-5(?:[.-])3-flash(?:-\d{6})?',value):return 'glm-5.3-flash'
    if value=='gemini-3.8-flash-high':return 'gemini-3.8-flash'
    if value=='doubao-seed-2-1-turbo':return 'doubao-seed-2.1-turbo'
    return value

def reference(model,when=None):
    official=canonical(model);item=CATALOG.get(official)
    if not item:return dict(model=model,verified=False,note='没有可核实的该型号官方参考价，费用未知')
    price=dict(model=model,official_model=official,input=item[0],cached=item[1],output=item[2],source=item[3],verified=True,verified_at=LATEST,policy='official-standard-2026-11-13',currency='CNY' if official.startswith(('glm-','minimax-','doubao-')) else 'USD',note='按最新官方 Standard Token 单价估算；非供应商实际账单，不含联网工具等单独收费')
    if official=='gemini-3.8-flash':
        price['schedule']=[dict(**{'from':'2027-01-01'},input=1.5,cached=.15,output=7.5)]
    if official.startswith('deepseek-'):price['note']='最新官方峰时单价参考上限；非高峰半价，网关实际扣费以账单为准'
    if official.startswith('gpt-6'):price['max_input_tokens']=272000
    if official=='minimax-m3':price['tiers']=[dict(above=512000,input=4.2,cached=.84,output=16.8)]
    if when and when[:10]<VERIFIED:price['verified']=False
    return price

def at(price,when):
    result=copy.deepcopy(price)
    for step in sorted(price.get('schedule',[]),key=lambda x:x['from']):
        if when[:10]>=step['from']:result.update({k:step[k] for k in ('input','cached','output')});result['applied_from']=step['from']
    return result

def estimate(usage,price,model):
    if not price.get('verified') or price.get('model')!=model:return None
    # A web form or imported setting cannot promote arbitrary numbers to official prices.
    reviewed=reference(model)
    if not reviewed['verified'] or price.get('source')!=reviewed['source'] or price.get('policy')!=reviewed['policy']:return None
    reviewed=at(reviewed,price.get('applied_from',VERIFIED))
    if any(price.get(k)!=reviewed.get(k) for k in ('input','cached','output')):return None
    i=usage.get('input_tokens');o=usage.get('output_tokens');cache=usage.get('input_tokens_details') or {}
    cached=cache.get('cached_tokens',0) or 0
    if any(type(x) is not int or x<0 for x in (i,o,cached)) or cached>i:return None
    if i>price.get('max_input_tokens',10**12):return None
    effective=dict(price)
    for tier in price.get('tiers',[]):
        if i>tier['above']:effective.update({k:tier[k] for k in ('input','cached','output')})
    return ((i-cached)*effective['input']+cached*effective['cached']+o*effective['output'])/1_000_000
