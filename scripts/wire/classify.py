"""Classifies a captured API request body. Prints sizes and tags only."""
import json, sys, re, collections as c

TAGS = [('skill_relevance', 'hook:skill_relevance'), ('codegraph_context', 'hook:codegraph'), ('hindsight', 'hook:hindsight'), ('PONYTAIL', 'hook:ponytail'),
        ('prismantis', 'hook:prismantis'), ('CLAUDE.md', 'instructions'), ('skills are available', 'skill_listing'), ('Base directory for this skill', 'skill_body'),
        ('deferred tools', 'deferred'), ('task-notification', 'task_notification'), ('[Jev compaction moved', 'stubbed_text')]
POINTER = re.compile(r'\[Jev compaction moved[^\]]*\]')


def tag(t):
    h = t[:800]
    for a, b in TAGS:
        if a in h:
            return b
    return 'reminder:other' if t.lstrip().startswith('<system-reminder') else 'plain'


def classify(path):
    d = json.load(open(path))
    k = c.Counter()
    k['system'] = len(json.dumps(d.get('system', ''), ensure_ascii=False))
    k['tools'] = len(json.dumps(d.get('tools', ''), ensure_ascii=False))
    n = c.Counter()
    for m in d['messages']:
        n[m['role']] += 1
        ct = m['content']
        for x in ([{'type': 'text', 'text': ct}] if isinstance(ct, str) else ct):
            t = x.get('type')
            if t == 'text':
                tx = x.get('text', '')
                k['assistant:text' if m['role'] == 'assistant' else m['role'] + ':' + tag(tx)] += len(tx)
            elif t == 'tool_use':
                k['tool_use'] += len(json.dumps(x.get('input'), ensure_ascii=False)) + len(x.get('name', ''))
                n['call'] += 1
            elif t == 'tool_result':
                s = json.dumps(x.get('content'), ensure_ascii=False)
                p = sum(len(y) for y in POINTER.findall(s))
                if p:
                    k['result:pointer'] += p
                    k['result:stub_head'] += len(s) - p
                    n['stub'] += 1
                else:
                    k['result:verbatim'] += len(s)
            elif t == 'thinking':
                k['thinking'] += len(x.get('thinking', '')) + len(x.get('signature', ''))
                n['thinking'] += 1
            else:
                k[str(t)] += len(json.dumps(x))
    return k, n, d.get('model')


if __name__ == '__main__':
    k, n, model = classify(sys.argv[1])
    usage = {}
    try:
        u = json.load(open(sys.argv[1].replace('.req.', '.res.')))
        usage = {a: int(b) for a, b in re.findall(r'"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens)":(\d+)', u.get('head') or '')}
    except (OSError, ValueError):
        pass
    tok = sum(usage.get(x, 0) or 0 for x in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
    A = sum(k.values())
    print(model, 'tokens', tok, 'chars', A, 'chars/token', round(A / tok, 2) if tok else None, dict(n))
    for key, v in k.most_common():
        print(f'  {key:26} {v / 1000:8.1f}k {100 * v / A:5.1f}%')
