import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  drawerPath,
  OPENROUTER_MODEL,
  OPENROUTER_URL,
  resolveEndpoint,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { collectToolCalls, compact, questionsFor, type JevAsker, type Message } from '../src/index.js';
import { previewOf } from '../src/state.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }], handle: `h-${id}` });
}
function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const bigLog = Array.from({ length: 400 }, (_, i) => `line ${i} INFO ok`).join('\n');
const env = 'APP_NAME=inventory\nWAREHOUSE_SHARD_COUNT=13\n';

function transcript(): SessionMessage[] {
  return [
    message('user', 'Audit the service.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'logs/app.log' }, bigLog),
    result('tool-1', bigLog),
    call('tool-2', 'Read', { file_path: 'config/app.env' }, env),
    result('tool-2', env),
    message('assistant', 'Done reading.', { handle: 'h-5' }),
    message('user', 'thanks', { handle: 'h-6' }),
  ];
}

function jev(answer: (name: string) => number): JevAsker {
  return {
    async ask(_state, questions) {
      return {
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: answer(k) }])),
      } as never;
    },
  };
}

function okFetch(urls: string[], bodies: string[]) {
  return async (url: string, init?: { body?: string }) => {
    urls.push(url);
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 1 }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('jev-compaction-plus: Jev sees what it judges', () => {
  it('quotes the start and end of each result in its question', () => {
    const [logCall, envCall] = collectToolCalls(transcript(), 0, 120);
    expect(previewOf(env, 120)).toBe(env);
    expect(envCall!.resultPreview).toContain('WAREHOUSE_SHARD_COUNT=13');
    expect(logCall!.resultPreview).toContain('line 0 INFO ok');
    expect(logCall!.resultPreview).toContain('line 399 INFO ok');
    expect(logCall!.resultPreview).toMatch(/chars omitted/);
    expect(questionsFor(envCall!)['result_t2']!.instructions).toContain('WAREHOUSE_SHARD_COUNT=13');
  });
});

describe('jev-compaction-plus: small results stay', () => {
  it('keeps results under minDropChars whatever Jev says', async () => {
    const out = await compact(transcript(), jev(() => 0), { preserveRecentMessages: 1 });
    expect(out.decisions.map((d) => [d.id, d.action, d.reason])).toEqual([
      // Jev said drop the call, but the drawer keeps it: reported as a moved result.
      ['t1', 'drop_result', 'result_dropped'],
      ['t2', 'keep', 'small'],
    ]);
  });
});

describe('jev-compaction-plus: dropped results move to a drawer', () => {
  it('writes the full output to a file, labels it, and keeps the call', async () => {
    const input = transcript();
    const out = await compact(input, jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/proj/.jev-drawer' });
    const paths = out.drawer.map((f) => f.path);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe('/proj/.jev-drawer/.gitignore');
    expect(paths[1]).toMatch(/^\/proj\/\.jev-drawer\/[^/]+\/t1-Read\.txt$/);
    expect(paths[2]).toMatch(/\/INDEX\.md$/);
    expect(out.drawer[0]!.text).toBe('*\n');
    expect(out.drawer[1]!.text).toContain('line 399 INFO ok');
    expect(out.drawer[1]!.text.startsWith('Read {"file_path":"logs/app.log"}')).toBe(true);

    // The assistant's tool_use message stays the engine's own: rebuilding it orphans sibling calls.
    expect(out.messages[1]).toBe(input[1]);
    const label = out.messages[2]!.toolResults![0]!.text;
    expect(label).toBe(
      `[Jev compaction moved this ${bigLog.length}-char output to ${paths[1]}. Read that file if you need it again; INDEX.md beside it lists everything moved.]`,
    );
    expect(out.messages).toHaveLength(input.length);

    const session = toSessionMessages(input, out.messages);
    // Rebuilt without handles so a resume neither multiplies nor orphans them (upstream #89, #129);
    // the tool_use inside is still the engine's own object.
    expect(session[1]!.handle).toBeUndefined();
    expect(session[1]!.toolUses[0]).toBe(input[1]!.toolUses[0]);
    expect(session[2]!.handle).toBeUndefined();
  });

  it('uses a unique drawer folder when compactions share a timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    try {
      const first = await compact(transcript(), jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/proj/.jev-drawer' });
      const second = await compact(transcript(), jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/proj/.jev-drawer' });
      const firstFolder = first.drawer[1]!.path.split('/').slice(0, -1).join('/');
      const secondFolder = second.drawer[1]!.path.split('/').slice(0, -1).join('/');
      expect(firstFolder).not.toBe(secondFolder);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('writes nothing when nothing is dropped, and deletes like the original when drawerDir is empty', async () => {
    expect((await compact(transcript(), jev(() => 1), { preserveRecentMessages: 1 })).drawer).toEqual([]);
    const legacy = await compact(transcript(), jev(() => 0), { preserveRecentMessages: 1, drawerDir: '' });
    expect(legacy.drawer).toEqual([]);
    expect(legacy.messages).toHaveLength(transcript().length - 2);
  });
});

describe('jev-compaction-plus: hook helpers', () => {
  it('picks the endpoint from the key', () => {
    const cfg = resolveHookConfig({});
    expect(resolveEndpoint(cfg, 'ts-key')).toEqual({ model: 'jev-latest' });
    expect(resolveEndpoint(cfg, 'sk-or-v1-x')).toEqual({ baseUrl: OPENROUTER_URL, model: OPENROUTER_MODEL });
    expect(resolveEndpoint({ ...cfg, model: 'typesafe/jev-2' }, 'sk-or-v1-x').model).toBe('typesafe/jev-2');
    expect(resolveEndpoint({ ...cfg, baseUrl: 'https://x' }, 'sk-or-v1-x')).toEqual({
      baseUrl: 'https://x',
      model: 'jev-latest',
    });
  });

  it('resolves a relative drawer folder against the session directory', () => {
    expect(drawerPath('.jev-drawer', 'C:\\proj\\')).toBe('C:\\proj/.jev-drawer');
    expect(drawerPath('.jev-drawer', '/home/me/proj')).toBe('/home/me/proj/.jev-drawer');
    expect(drawerPath('D:\\drawers', '/x')).toBe('D:\\drawers');
    expect(drawerPath('/tmp/d', '/x')).toBe('/tmp/d');
    expect(drawerPath('', '/x')).toBe('');
    expect(drawerPath('~/.claude/jev-drawer', '/x', '/Users/me/')).toBe('/Users/me/.claude/jev-drawer');
  });

  it('sends OpenRouter keys to OpenRouter end to end', async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'sk-or-v1-x' };
    await compactSession(transcript(), config, okFetch(urls, bodies));
    expect(urls).toEqual([OPENROUTER_URL]);
    expect(JSON.parse(bodies[0]!).model).toBe(OPENROUTER_MODEL);
  });
});

describe('this fork: long input fields move to the drawer', () => {
  it('keeps a head of a long Write content, moves the rest, and leaves short fields and pinned calls alone', async () => {
    const content = 'x'.repeat(5000);
    const input: SessionMessage[] = [
      message('user', 'Write the file.', { handle: 'h-0' }),
      call('w1', 'Write', { file_path: 'out.txt', content }, 'File created'),
      result('w1', 'File created'),
      call('w2', 'Write', { file_path: 'pinned.txt', content }, 'File created'),
      result('w2', 'File created'),
    ];
    const out = await compact(input, jev(() => 0.9), { preserveRecentMessages: 2, drawerDir: '/d' });
    const moved = out.messages[1]!.toolUses[0]!.input as Record<string, string>;
    expect(moved['file_path']).toBe('out.txt');
    expect(moved['content']).toMatch(new RegExp(`^${'x'.repeat(300)}\\n\\[Jev compaction moved the rest of this 5000-char content to /d/.+-Write-content\\.txt\\.`));
    expect(out.drawer.some((file) => file.path.endsWith('-Write-content.txt') && file.text === content)).toBe(true);
    expect(out.messages[3]!.toolUses[0]!.input).toEqual({ file_path: 'pinned.txt', content });
    expect(out.messages[2]).toBe(input[2]);
    expect(out.stats.charsAfter).toBeLessThan(out.stats.charsBefore - 4000);
    expect(out.stats.inputsMoved).toBe(1);
  });
});

describe('this fork: host-written user text moves to the drawer', () => {
  it('moves old skill bodies and task notifications, never typed or pasted text', async () => {
    const skill = `Base directory for this skill: /s\n${'rule\n'.repeat(800)}`;
    const notice = `<task-notification>${'out\n'.repeat(800)}</task-notification>`;
    const typed = 'please '.repeat(800);
    const input: SessionMessage[] = [
      message('user', 'Start.', { handle: 'h-0' }),
      message('user', skill, { handle: 'h-1' }),
      message('user', notice, { handle: 'h-2' }),
      message('user', typed, { handle: 'h-3' }),
      message('assistant', 'ok', { handle: 'h-4' }),
      message('user', notice, { handle: 'h-5' }),
    ];
    const out = await compact(input, jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/d' });
    expect(out.messages[1]!.text).toMatch(/^Base directory for this skill[\s\S]*\[Jev compaction moved the rest of this \d+-char host notice to \/d\/.+-host-text\.txt\./);
    expect(out.messages[2]!.text).toMatch(/host notice/);
    expect(out.messages[3]).toBe(input[3]);
    expect(out.messages[5]).toBe(input[5]);
    expect(out.drawer.filter((file) => file.path.endsWith('-host-text.txt')).map((file) => file.text)).toEqual([skill, notice]);
    expect(out.stats.noticesMoved).toBe(2);
  });
});

describe('this fork: short results keep a head', () => {
  it('cuts unpinned short results by rule, leaves errors, tiny and pinned ones, and never re-moves a head', async () => {
    const mid = 'm'.repeat(1000);
    const input: SessionMessage[] = [
      message('user', 'Check.', { handle: 'h-0' }),
      call('s1', 'Bash', { command: 'ls' }, mid),
      result('s1', mid),
      call('s2', 'Bash', { command: 'false' }, mid),
      result('s2', mid, true),
      call('s3', 'Bash', { command: 'pwd' }, '/tmp'),
      result('s3', '/tmp'),
      call('s4', 'Bash', { command: 'ls' }, mid),
      result('s4', mid),
    ];
    const out = await compact(input, jev(() => 1), { preserveRecentMessages: 2, drawerDir: '/d' });
    const head = out.messages[2]!.toolResults![0]!.text;
    expect(head).toMatch(new RegExp(`^${'m'.repeat(300)}\\n\\[Jev compaction moved the rest of this 1000-char output to /d/.+-Bash\\.txt\\.`));
    expect(out.drawer.some((file) => file.text.endsWith(mid) && file.path.endsWith('t1-Bash.txt'))).toBe(true);
    expect(out.messages[1]).toBe(input[1]);
    expect(out.messages[4]).toBe(input[4]);
    expect(out.messages[6]).toBe(input[6]);
    expect(out.messages[8]).toBe(input[8]);
    expect(out.stats.smallMoved).toBe(1);
    expect(summarize(out)).toContain('1 short results cut to a head');

    const again = await compact(out.messages, jev(() => 1), { preserveRecentMessages: 2, drawerDir: '/d' });
    expect(again.stats.smallMoved).toBe(0);
  });
});

describe('this fork: coin flips, errors and subagent answers keep a preview', () => {
  it('keeps start and end above the pointer-only band, for errors and Agent results whatever the score', async () => {
    const log = Array.from({ length: 400 }, (_, i) => `step ${i}`).join('\n') + '\nRESULT: 3 FAIL';
    const input: SessionMessage[] = [
      message('user', 'Run.', { handle: 'h-0' }),
      call('a', 'Bash', { command: 'x' }, log), result('a', log),
      call('b', 'Bash', { command: 'y' }, log), result('b', log),
      call('c', 'Bash', { command: 'z' }, log), result('c', log, true),
      call('d', 'Agent', { prompt: 'p' }, log), result('d', log),
      message('assistant', 'done', { handle: 'h-9' }),
    ];
    const scores: Record<string, number> = { result_t1: 0.4, result_t2: 0.1, result_t3: 0.1, result_t4: 0.1 };
    const out = await compact(input, jev((k) => scores[k] ?? 1), { preserveRecentMessages: 1, drawerDir: '/d' });
    const text = (i: number) => out.messages[i]!.toolResults![0]!.text;
    for (const i of [2, 6, 8]) {
      expect(text(i)).toMatch(/^step 0\n/);
      expect(text(i)).toContain('RESULT: 3 FAIL');
      expect(text(i)).toMatch(/INDEX\.md beside it lists everything moved\.\]$/);
    }
    expect(text(4)).toMatch(/^\[Jev compaction moved this \d+-char output/);
    const again = await compact(out.messages, jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/d' });
    expect(again.stats.resultsDropped + again.stats.smallMoved).toBe(0);
  });
});

describe('this fork: drawer mode asks less', () => {
  it('asks only the result question, and never about small results', async () => {
    const asked: string[] = [];
    const asker: JevAsker = {
      async ask(_state, questions) {
        asked.push(...Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0 }])) };
      },
    };
    await compact(transcript(), asker, { preserveRecentMessages: 1, drawerDir: '/d' });
    expect(asked).toEqual(['result_t1']);
  });
});
