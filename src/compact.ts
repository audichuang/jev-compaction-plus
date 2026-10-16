import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState, isHostText, isPinned, sliceSurrogateSafe } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  // With previews Jev's keepResult sits around 0.45 (median over 10 real sessions), so
  // 0.6 keeps its top picks and drawers the coin flips: a wrong drop costs one file
  // read, a low threshold falls back to the built-in summary (scripts/replay.mts).
  keepThreshold: 0.6,
  preserveRecentMessages: 6,
  maxStateTokens: 14_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  previewChars: 600,
  minDropChars: 1500,
  drawerDir: '.jev-drawer',
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    previewChars: Math.max(0, Math.floor(finite(options.previewChars, DEFAULT_OPTIONS.previewChars))),
    minDropChars: Math.max(0, finite(options.minDropChars, DEFAULT_OPTIONS.minDropChars)),
    drawerDir: options.drawerDir ?? DEFAULT_OPTIONS.drawerDir,
  };
}

/**
 * The `noul` questions asked about one call: keep the call, keep its result. With
 * the drawer every call stays, so only the result question is asked.
 */
export function questionsFor(call: ToolCall, resultOnly = false): JevQuestions {
  return {
    ...(resultOnly ? {} : callQuestion(call)),
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant may still need its contents. Preview of the output:\n"""\n${call.resultPreview}\n"""`,
    },
  };
}

function callQuestion(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
  resultOnly = false,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call, resultOnly)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'> & Partial<Pick<ToolCall, 'resultChars'>>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> & Partial<Pick<ResolvedCompactOptions, 'minDropChars'>>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if ((call.resultChars ?? Infinity) < (options.minDropChars ?? 0)) {
    return { ...base, action: 'keep', reason: 'small' };
  }
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  resultOnly: boolean,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map((call) => questionsFor(call, resultOnly)));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => {
      const keepResult = noulAnswer(answers, `result_${call.id}`);
      return [call.id, { keepCall: resultOnly ? keepResult : noulAnswer(answers, `call_${call.id}`), keepResult }];
    }),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${sliceSurrogateSafe(text, 0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  stubs: ReadonlyMap<string, string> = new Map(),
  inputStubs: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  textStubs: ReadonlyMap<Message, string> = new Map(),
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') {
      actions.set(call.tool_use_id, stubs.has(call.tool_use_id) ? 'drop_result' : decision.action);
    }
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const text = textStubs.get(message);
    if (text !== undefined) {
      kept.push({ role: message.role, text, toolUses: message.toolUses });
      continue;
    }
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id) || inputStubs.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        const input = inputStubs.get(tool.tool_use_id);
        if (input) tool = { ...tool, input };
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        // Drawer mode: leave the assistant's tool_use untouched (rebuilding it loses the
        // engine's message id and orphans sibling calls); only the tool_result changes.
        if (stubs.has(tool.tool_use_id)) return tool;
        const text =
          stubs.get(tool.tool_use_id) ??
          truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars);
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text =
          stubs.get(result.tool_use_id) ??
          truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/**
 * jev-compaction-plus: every result Jev drops is written to a drawer file and
 * replaced by a one-line label, so a wrong call can be undone with one Read.
 */
export function drawerFor(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  drawerDir: string,
  stamp: number,
  limits: { minDropChars: number; headChars: number; preserveRecentMessages: number } = {
    minDropChars: Infinity,
    headChars: 0,
    preserveRecentMessages: 0,
  },
): {
  stubs: Map<string, string>;
  inputStubs: Map<string, Record<string, unknown>>;
  textStubs: Map<Message, string>;
  drawer: { path: string; text: string }[];
} {
  const stubs = new Map<string, string>();
  const inputStubs = new Map<string, Record<string, unknown>>();
  const textStubs = new Map<Message, string>();
  const drawer: { path: string; text: string }[] = [];
  if (!drawerDir) return { stubs, inputStubs, textStubs, drawer };
  const minChars = Math.max(limits.minDropChars, limits.headChars + 200);
  const moved = (chars: number, what: string, path: string) =>
    `[Jev compaction moved the rest of this ${chars}-char ${what} to ${path}. Read that file if you need it again.]`;
  const texts = new Map<string, string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) texts.set(result.tool_use_id, result.text);
    for (const tool of message.toolUses) if (tool.text !== undefined && !texts.has(tool.tool_use_id)) texts.set(tool.tool_use_id, tool.text);
  }
  const byId = new Map(calls.map((call) => [call.id, call]));
  const folder = `${drawerDir.replace(/[\\/]+$/, '')}/${new Date(stamp).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const index: string[] = ['# Results moved here by Jev compaction', ''];
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call || decision.action === 'keep') continue;
    const path = `${folder}/${call.id}-${call.tool.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
    let input = '';
    try {
      input = JSON.stringify(call.input);
    } catch {
      input = '[unserializable input]';
    }
    drawer.push({ path, text: `${call.tool} ${input}\n\n${texts.get(call.tool_use_id) ?? ''}` });
    stubs.set(
      call.tool_use_id,
      `[Jev compaction moved this ${call.resultChars}-char output to ${path}. Read that file if you need it again.]`,
    );
    index.push(`- ${path}: ${call.tool} ${sliceSurrogateSafe(input, 0, 200)}`);
  }
  // Long string fields of a call's own input (Write content, Bash heredocs, Agent
  // prompts) are a third of a real session and never a Jev candidate: by rule, like
  // minDropChars, they keep a head and move the rest to the drawer.
  for (const call of calls) {
    if (call.pinned) continue;
    let changed: Record<string, unknown> | undefined;
    for (const [field, value] of Object.entries(call.input)) {
      if (typeof value !== 'string' || value.length < minChars) continue;
      const path = `${folder}/${call.id}-${call.tool.replace(/[^A-Za-z0-9_-]/g, '_')}-${field.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
      drawer.push({ path, text: value });
      changed ??= { ...call.input };
      changed[field] = `${sliceSurrogateSafe(value, 0, limits.headChars)}\n${moved(value.length, field, path)}`;
      index.push(`- ${path}: ${call.tool} input field ${field}`);
    }
    if (changed) inputStubs.set(call.tool_use_id, changed);
  }
  // Host-written user text (skill bodies, task notifications, reminders) is most of the
  // user role in a real session and re-derivable; outside the pinned messages it keeps a
  // head and moves to the drawer. Typed and pasted text is never touched.
  messages.forEach((message, at) => {
    if (message.role !== 'user' || message.toolResults?.length || message.text.length < minChars) return;
    if (isPinned(at, messages.length, limits.preserveRecentMessages) || !isHostText(message.text)) return;
    const path = `${folder}/m${at}-host-text.txt`;
    drawer.push({ path, text: message.text });
    textStubs.set(message, `${sliceSurrogateSafe(message.text, 0, limits.headChars)}\n${moved(message.text.length, 'host notice', path)}`);
    index.push(`- ${path}: host notice ${sliceSurrogateSafe(message.text.trimStart(), 0, 80)}`);
  });
  if (drawer.length > 0) {
    // The drawer ignores itself, so it never ends up in a commit.
    drawer.unshift({ path: `${drawerDir.replace(/[\\/]+$/, '')}/.gitignore`, text: '*\n' });
    drawer.push({ path: `${folder}/INDEX.md`, text: index.join('\n') + '\n' });
  }
  return { stubs, inputStubs, textStubs, drawer };
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages, resolved.previewChars);
  // Pinned calls and small results stay whatever Jev says, so they are not asked about.
  const candidates = calls.filter((call) => !call.pinned && call.resultChars >= resolved.minDropChars);
  const resultOnly = resolved.drawerDir.length > 0;
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved, resultOnly);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch, resultOnly)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decided = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const { stubs, inputStubs, textStubs, drawer } = drawerFor(messages, calls, decided, resolved.drawerDir, started, {
    minDropChars: resolved.minDropChars,
    headChars: resolved.truncateHeadChars,
    preserveRecentMessages: resolved.preserveRecentMessages,
  });
  // A call whose result went to the drawer keeps its tool_use, so report it as a moved
  // result: the toast and decision log say what the session actually lost.
  const toolUseIds = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  const decisions = decided.map((decision): CallDecision =>
    decision.action === 'drop_call' && stubs.has(toolUseIds.get(decision.id) ?? '')
      ? { ...decision, action: 'drop_result', reason: 'result_dropped' }
      : decision,
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
    stubs,
    inputStubs,
    textStubs,
  );
  return {
    messages: kept,
    decisions,
    drawer,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      inputsMoved: inputStubs.size,
      noticesMoved: textStubs.size,
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
