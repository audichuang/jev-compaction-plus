"""Token cost per category of a captured request, by count_tokens on the request with that category blanked. Prints numbers only."""
import json,sys,copy,re,urllib.request
sys.path.insert(0,sys.argv[0].rsplit('/',1)[0])
from classify import tag,POINTER
port,path=sys.argv[1],sys.argv[2]
d=json.load(open(path))
base={k:d[k] for k in('model','messages','system','tools') if k in d}
def count(b):
    r=urllib.request.Request(f'http://127.0.0.1:{port}/__count',data=json.dumps(b).encode(),headers={'content-type':'application/json'})
    try: return json.load(urllib.request.urlopen(r,timeout=120))['input_tokens']
    except urllib.error.HTTPError as e: return 'ERR '+e.read().decode()[:160]
def blank(cat):
    b=copy.deepcopy(base)
    if cat=='tools': b['tools']=b['tools'][:1]
    if cat=='system': b['system']='x'
    for m in b['messages']:
        ct=m['content']
        if isinstance(ct,str): ct=m['content']=[{'type':'text','text':ct}]
        for x in ct:
            t=x.get('type')
            if t=='text':
                key='assistant' if m['role']=='assistant' else m['role']+':'+tag(x['text'])
                if cat==key or (cat=='role:system' and m['role']=='system') or (cat=='hook' and m['role']!='assistant' and tag(x['text']).startswith('hook')): x['text']='x'
            elif t=='tool_use' and cat=='tool_use': x['input']={}
            elif t=='tool_result':
                s=x.get('content')
                st=s if isinstance(s,str) else ''.join(y.get('text','') for y in s or [] if isinstance(y,dict))
                if cat=='result' or (cat=='result:pointer' and POINTER.search(st)):
                    x['content']=POINTER.sub('x',st) if cat=='result:pointer' else 'x'
    return b
full=count(base);print('full',full)
if not isinstance(full,int): sys.exit()
cats=set()
for m in base['messages']:
    ct=m['content']
    for x in ([{'type':'text','text':ct}] if isinstance(ct,str) else ct):
        if x.get('type')=='text': cats.add('assistant' if m['role']=='assistant' else m['role']+':'+tag(x['text']))
for c in ['tools','system','tool_use','result','result:pointer','role:system']+sorted(cats):
    v=count(blank(c));print(f'  {c:30} {full-v if isinstance(v,int) else v}')
