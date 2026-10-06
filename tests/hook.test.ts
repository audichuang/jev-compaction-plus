import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  register,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

function fake$(options: Record<string, unknown> = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const writes: string[] = [];
  const logs: string[] = [];
  let compactCalls = 0;
  let percentUsed = 0;
  let fetcher: any = async () => ({ status: 500, ok: false, text: 'error' });
  let writeFails = false;
  const $: any = {
    userConfig: { apiKey: 'k', drawerDir: 'drawer', minDropChars: 0, preserveRecentMessages: 1 },
    http: { fetch: (...args: any[]) => fetcher(...args) },
    fs: { exists: async () => false, write: async (path: string) => { if (writeFails) throw Error('write failed'); writes.push(path); } },
    ui: { log: (s: string) => logs.push(s), toast: () => {} },
    session: { cwd: async () => '/tmp', usage: async () => ({ context: { percent: percentUsed } }), compact: async () => { compactCalls++; return { skip: 'skip' }; } },
  };
  register((name: string, handler: any) => { handlers[name] = handler; }, { apiKey: 'k', drawerDir: 'drawer', minDropChars: 0, preserveRecentMessages: 1, ...options } as any);
  return { $, handlers, writes, logs, get compactCalls() { return compactCalls; }, set percent(p: number) { percentUsed = p; }, set fetch(f: any) { fetcher = f; }, set writeFails(v: boolean) { writeFails = v; } };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    // fast-jev-compaction's original behavior: no drawer, no small-result rule
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x', minDropChars: 0, drawerDir: '' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', minDropChars: 0, drawerDir: '' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('registered hooks', () => {
  const event = (trigger: string) => ({ messages: transcript(), trigger });
  const okFetch = jevFetch(() => 0);
  const invoke = (h: ReturnType<typeof fake$>, name: string, e: any, next = (x: any) => ({ next: x })) => h.handlers[name](h.$, e, next);

  it('skips plugin failures and falls back for manual failures', async () => {
    const h = fake$();
    expect(await invoke(h, 'session.compact', event('plugin'))).toEqual({ skip: 'Jev request failed (500): error' });
    expect(await invoke(h, 'session.compact', event('manual'))).toHaveProperty('next');
  });

  it('skips plugin compaction when drawer writing fails', async () => {
    const h = fake$(); h.fetch = okFetch; h.writeFails = true;
    expect(await invoke(h, 'session.compact', event('plugin'))).toMatchObject({ skip: 'write failed' });
  });

  it('does not compact subagents or overlapping turns', async () => {
    const h = fake$(); h.percent = 70;
    await invoke(h, 'turn.complete', { agentId: 'child' });
    let release!: () => void;
    h.$.session.usage = () => new Promise((resolve: any) => { release = () => resolve({ context: { percent: 70 } }); });
    const first = invoke(h, 'turn.complete', {});
    await Promise.resolve();
    const second = invoke(h, 'turn.complete', {});
    release();
    await Promise.all([first, second]);
    expect(h.compactCalls).toBe(1);
  });

  it('backs off five percentage points after a skip', async () => {
    const h = fake$();
    for (const p of [61, 63, 66]) { h.percent = p; await invoke(h, 'turn.complete', {}); }
    expect(h.compactCalls).toBe(2);
  });

  it('compacts below five percent when the threshold is set that low', async () => {
    const h = fake$({ compactAtPercent: 1 });
    h.percent = 2;
    await invoke(h, 'turn.complete', {});
    expect(h.compactCalls).toBe(1);
  });

  it('preserves an existing drawer gitignore', async () => {
    const h = fake$(); h.fetch = okFetch;
    h.$.fs.exists = async (path: string) => path.endsWith('/.gitignore');
    await invoke(h, 'session.compact', event('manual'));
    expect(h.writes.some((path: string) => path.endsWith('/.gitignore'))).toBe(false);
  });
});
