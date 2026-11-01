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
import { goalFromMessages, previewOf } from '../src/state.js';

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

/** Drops the message explaining the drawer, so positions match the input. */
function withoutLegend<T extends Message>(messages: readonly T[]): T[] {
  return messages.filter((m) => !m.text.startsWith('[Jev compaction:'));
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
    expect(out.messages[1]!.text).toMatch(/^\[Jev compaction: earlier content was moved to \/proj\/\.jev-drawer\/.+INDEX\.md/);
    const body = withoutLegend(out.messages);
    expect(body[1]).toBe(input[1]);
    expect(body[2]!.toolResults![0]!.text).toBe(`[Jev moved ${bigLog.length} chars to ${paths[1]}]`);
    expect(body).toHaveLength(input.length);

    const session = withoutLegend(toSessionMessages(input, out.messages));
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
    const body = withoutLegend(out.messages);
    const moved = body[1]!.toolUses[0]!.input as Record<string, string>;
    expect(moved['file_path']).toBe('out.txt');
    expect(moved['content']).toMatch(new RegExp(`^${'x'.repeat(300)}\\n\\[Jev moved 5000 chars to /d/.+-Write-content\\.txt\\]$`));
    expect(out.drawer.some((file) => file.path.endsWith('-Write-content.txt') && file.text === content)).toBe(true);
    expect(body[3]!.toolUses[0]!.input).toEqual({ file_path: 'pinned.txt', content });
    expect(body[2]).toBe(input[2]);
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
    const body = withoutLegend(out.messages);
    expect(body[1]!.text).toMatch(/^Base directory for this skill[\s\S]*\[Jev moved \d+ chars to \/d\/.+-host-text\.txt\]$/);
    expect(body[2]!.text).toMatch(/-host-text\.txt\]$/);
    expect(body[3]).toBe(input[3]);
    expect(body[5]).toBe(input[5]);
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
    const body = withoutLegend(out.messages);
    const head = body[2]!.toolResults![0]!.text;
    expect(head).toMatch(new RegExp(`^${'m'.repeat(300)}\\n\\[Jev moved 1000 chars to /d/.+-Bash\\.txt\\]$`));
    expect(out.drawer.some((file) => file.text.endsWith(mid) && file.path.endsWith('t1-Bash.txt'))).toBe(true);
    expect(body[1]).toBe(input[1]);
    expect(body[4]).toBe(input[4]);
    expect(body[6]).toBe(input[6]);
    expect(body[8]).toBe(input[8]);
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
    const text = (i: number) => withoutLegend(out.messages)[i]!.toolResults![0]!.text;
    for (const i of [2, 6, 8]) {
      expect(text(i)).toMatch(/^step 0\n/);
      expect(text(i)).toContain('RESULT: 3 FAIL');
      expect(text(i)).toMatch(/\.txt\]$/);
    }
    expect(text(4)).toMatch(/^\[Jev moved \d+ chars to /);
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

describe('this fork: old calls fold to a ledger', () => {
  const many = (n: number): SessionMessage[] => [
    message('user', 'Audit.', { handle: 'h-0' }),
    ...Array.from({ length: n }, (_, i) => [
      call(`c${i}`, 'Read', { file_path: `src/f${i}.ts` }, `body ${i}`),
      result(`c${i}`, `body ${i}`),
    ]).flat(),
    message('assistant', 'Done.', { handle: 'h-z' }),
    message('user', 'thanks', { handle: 'h-y' }),
  ];

  it('drops old calls with their results, keeps the newest, and lists the dropped in one legend', async () => {
    const asked: string[] = [];
    const asker: JevAsker = {
      async ask(_state, questions) {
        asked.push(...Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 1 }])) };
      },
    };
    const out = await compact(many(5), asker, { keepRecentCalls: 2, preserveRecentMessages: 2, drawerDir: '/d' });
    expect(out.stats.callsFolded).toBe(3);
    expect(asked).toEqual([]);
    const legend = out.messages[1]!.text;
    expect(legend).toContain('3 older calls');
    expect(legend).toContain('t1 Read src/f0.ts');
    expect(legend).not.toContain('src/f3.ts');
    const ids = out.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    expect(ids).toEqual(['c3', 'c4']);
    expect(out.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id))).toEqual(['c3', 'c4']);
    expect(out.drawer.find((f) => f.path.endsWith('t1-Read.txt'))!.text).toContain('body 0');
    expect(out.drawer.find((f) => f.path.endsWith('INDEX.md'))!.text).toContain('t1-Read.txt');
  });

  it('never folds errors, subagent answers, the user\'s answers, or pinned calls', async () => {
    const input: SessionMessage[] = [
      message('user', 'Go.', { handle: 'h-0' }),
      call('e', 'Bash', { command: 'false' }, 'boom'), result('e', 'boom', true),
      call('a', 'Agent', { prompt: 'p' }, 'answer'), result('a', 'answer'),
      call('q', 'AskUserQuestion', { questions: [] }, 'blue'), result('q', 'blue'),
      call('r', 'Read', { file_path: 'x' }, 'body'), result('r', 'body'),
      call('p', 'Read', { file_path: 'y' }, 'body'), result('p', 'body'),
    ];
    const out = await compact(input, jev(() => 1), { keepRecentCalls: 1, preserveRecentMessages: 2, drawerDir: '/d' });
    expect(out.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id))).toEqual(['e', 'a', 'q', 'p']);
  });

  it('keeps the assistant text around a folded call', async () => {
    const input: SessionMessage[] = [
      message('user', 'Go.', { handle: 'h-0' }),
      message('assistant', 'The cause is the cache.', { toolUses: [{ tool_use_id: 'r', tool: 'Read', input: { file_path: 'x' }, text: 'b' }] }),
      result('r', 'b'),
      message('assistant', 'Done.'),
      message('user', 'ok'),
    ];
    const out = await compact(input, jev(() => 1), { keepRecentCalls: 0.5 as number, preserveRecentMessages: 1, drawerDir: '/d' });
    // 0.5 floors to 0, which turns folding off.
    expect(out.stats.callsFolded).toBe(0);
    const folded = await compact(input, jev(() => 1), { keepRecentCalls: 1, preserveRecentMessages: 1, drawerDir: '/d' });
    expect(folded.stats.callsFolded).toBe(0);
    const twoCalls = [...input.slice(0, 3), call('s', 'Read', { file_path: 'y' }, 'c'), result('s', 'c'), ...input.slice(3)];
    const out2 = await compact(twoCalls, jev(() => 1), { keepRecentCalls: 1, preserveRecentMessages: 1, drawerDir: '/d' });
    expect(out2.stats.callsFolded).toBe(1);
    expect(out2.messages.some((m) => m.text === 'The cause is the cache.')).toBe(true);
    expect(out2.messages.some((m) => m.toolUses.some((u) => u.tool_use_id === 'r'))).toBe(false);
  });

  it('does not fold without a drawer, and leaves earlier legends in order on the next round', async () => {
    const none = await compact(many(5), jev(() => 1), { keepRecentCalls: 2, preserveRecentMessages: 2, drawerDir: '' });
    expect(none.stats.callsFolded).toBe(0);
    const first = await compact(many(5), jev(() => 1), { keepRecentCalls: 2, preserveRecentMessages: 2, drawerDir: '/d' });
    const second = await compact(
      [...first.messages, call('n1', 'Read', { file_path: 'n1' }, 'b'), result('n1', 'b'), call('n2', 'Read', { file_path: 'n2' }, 'b'), result('n2', 'b'), message('user', 'next')],
      jev(() => 1),
      { keepRecentCalls: 2, preserveRecentMessages: 2, drawerDir: '/d' },
    );
    const legends = second.messages.filter((m) => m.text.startsWith('[Jev compaction:'));
    expect(legends).toHaveLength(2);
    expect(second.messages[1]).toBe(legends[0]);
    expect(second.messages[2]).toBe(legends[1]);
    expect(legends[0]!.text).toContain('src/f0.ts');
    expect(goalFromMessages(second.messages)).not.toContain('[Jev compaction:');
  });

  it('keeps tool pairing across a folded parallel response', async () => {
    const input: SessionMessage[] = [
      message('user', 'Go.', { handle: 'h-0' }),
      call('a', 'Read', { file_path: 'a' }, 'b'),
      call('b', 'Read', { file_path: 'b' }, 'b'),
      result('a', 'b'),
      result('b', 'b'),
      call('c', 'Read', { file_path: 'c' }, 'b'),
      result('c', 'b'),
      message('user', 'ok', { handle: 'h-y' }),
    ];
    const out = await compact(input, jev(() => 1), { keepRecentCalls: 2, preserveRecentMessages: 1, drawerDir: '/d' });
    const session = toSessionMessages(input, out.messages, 1);
    const used = session.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    const answered = session.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(used).toEqual(['b', 'c']);
    expect(answered).toEqual(['b', 'c']);
  });
});

describe('this fork: old user messages drop their handle', () => {
  it('keeps a handle only on recent messages and those that may hold an image', () => {
    const input: SessionMessage[] = [
      message('user', 'first', { handle: 'h-0' }),
      message('assistant', 'a'),
      message('user', 'look at [Image #1]', { handle: 'h-2' }),
      message('assistant', 'b'),
      message('user', '', { handle: 'h-4' }),
      message('assistant', 'c'),
      message('user', 'recent', { handle: 'h-6' }),
    ];
    const session = toSessionMessages(input, input, 1);
    expect(session[0]).not.toBe(input[0]);
    expect(session[0]!.handle).toBeUndefined();
    expect(session[0]!.text).toBe('first');
    expect(session[2]).toBe(input[2]);
    expect(session[4]).toBe(input[4]);
    expect(session[6]).toBe(input[6]);
  });
});

describe('this fork: host text keeps the higher floor', () => {
  it('leaves a command message under minDropChars whole: typed args can sit behind the prefix', async () => {
    const typed = `<command-name>/x</command-name><command-args>${'please '.repeat(100)}</command-args>`;
    const input: SessionMessage[] = [
      message('user', 'Start.', { handle: 'h-0' }),
      message('user', typed, { handle: 'h-1' }),
      message('assistant', 'ok', { handle: 'h-2' }),
      message('user', 'next', { handle: 'h-3' }),
    ];
    const out = await compact(input, jev(() => 0), { preserveRecentMessages: 1, drawerDir: '/d' });
    expect(out.messages[1]).toBe(input[1]);
    expect(out.stats.noticesMoved).toBe(0);
  });
});
