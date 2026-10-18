import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { redactDeep } from '../src/redact.js';
import { goalFromMessages } from '../src/state.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  minReductionRatio: number;
  model: string;
  /** Alternate Jev endpoint. Unset: TypeSafe's own API, or OpenRouter's when the key is an OpenRouter key. */
  baseUrl?: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'previewChars',
    'minDropChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  const drawerDir = options['drawerDir'];
  if (typeof drawerDir === 'string') config.drawerDir = drawerDir;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_MODEL = 'typesafe/jev-1.13';

/**
 * Where to send Jev calls: an explicit `baseUrl` wins; otherwise an OpenRouter
 * key (`sk-or-...`) goes to OpenRouter's decisions API, anything else to TypeSafe.
 */
export function resolveEndpoint(
  config: Pick<HookConfig, 'baseUrl' | 'model'>,
  apiKey: string,
): { baseUrl?: string; model: string } {
  if (config.baseUrl) return { baseUrl: config.baseUrl, model: config.model };
  if (apiKey.startsWith('sk-or-')) {
    return {
      baseUrl: OPENROUTER_URL,
      model: config.model === DEFAULT_MODEL ? OPENROUTER_MODEL : config.model,
    };
  }
  return { model: config.model };
}

/** Where the plugin keeps its drawer unless told otherwise: outside every project, so synced folders never get dumps. */
export const HOOK_DRAWER_DIR = '~/.claude/jev-drawer';

/**
 * A drawer folder as an absolute path, so labels hold one: `~/` resolves against
 * the home folder, any other relative folder against the session's directory.
 */
export function drawerPath(dir: string, cwd: string, home = ''): string {
  if (home && /^~[\\/]/.test(dir)) return `${home.replace(/[\\/]+$/, '')}/${dir.slice(2)}`;
  if (!dir || /^([A-Za-z]:[\\/]|[\\/])/.test(dir)) return dir;
  return `${cwd.replace(/[\\/]+$/, '')}/${dir}`;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string, baseUrl?: string): JevAsker {
  return {
    async ask(state, questions) {
      // Credential-shaped text in history, inputs and result previews never leaves the
      // machine (upstream #98, socialadsmentor's redact.ts); the transcript is unchanged.
      const request = buildJevRequest(
        { apiKey, model, baseUrl },
        redactDeep(state, [apiKey]).value,
        redactDeep(questions, [apiKey]).value,
      );
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * The API response each input message belongs to, as the index of its first
 * assistant message; -1 for a user message. The host hands one content block
 * per message and runs fast tools while the response still streams, so a
 * response is a run of assistant messages that tool-result messages break
 * only while one of its calls is still unanswered (a new response cannot
 * start before every call has its result). A call whose result is nowhere in
 * the input is not waited for. A response whose calls were all answered
 * before its next call is split there; each part keeps its results right
 * after it, so the host still pairs every call.
 * (Ported from orangewk/fast-jev-compaction ad91a16, e1a77b5.)
 */
function responseStarts(input: readonly Message[]): number[] {
  const answered = new Set(
    input.flatMap((message) => (message.toolResults ?? []).map((result) => result.tool_use_id)),
  );
  let start = -1;
  let afterResults = false;
  const unanswered = new Set<string>();
  return input.map((message, index) => {
    if (message.role === 'user') {
      if (!message.toolResults?.length) start = -1;
      for (const result of message.toolResults ?? []) unanswered.delete(result.tool_use_id);
      afterResults = true;
      return -1;
    }
    if (start < 0 || (afterResults && unanswered.size === 0)) {
      start = index;
      unanswered.clear();
    }
    afterResults = false;
    for (const tool of message.toolUses) {
      if (answered.has(tool.tool_use_id)) unanswered.add(tool.tool_use_id);
    }
    return start;
  });
}

/**
 * The input index each output message came from, or -1 for one the library
 * added or a user message it rewrote. The library keeps the order and never
 * removes an assistant message with text, so a rebuilt message is found by
 * its first tool use or, with none left, as the next assistant with text.
 */
function sourceIndices(input: readonly Message[], output: readonly Message[]): number[] {
  const at = new Map<Message, number>(input.map((message, index) => [message, index]));
  const byCall = new Map<string, number>();
  input.forEach((message, index) => {
    for (const tool of message.toolUses) byCall.set(`use:${tool.tool_use_id}`, index);
    for (const result of message.toolResults ?? []) byCall.set(`result:${result.tool_use_id}`, index);
  });
  let next = 0;
  return output.map((message) => {
    let index = at.get(message);
    if (index === undefined) {
      const use = message.toolUses[0];
      const result = message.toolResults?.[0];
      if (use) index = byCall.get(`use:${use.tool_use_id}`);
      else if (result) index = byCall.get(`result:${result.tool_use_id}`);
      else if (message.role === 'assistant') {
        index = input.findIndex(
          (other, i) =>
            i >= next &&
            other.role === 'assistant' &&
            other.text.trim().length > 0 &&
            message.text.startsWith(other.text),
        );
      }
    }
    if (index === undefined || index < 0) return -1;
    next = index + 1;
    return index;
  });
}

/**
 * Maps the library's output back onto session messages. A user message that
 * came back unchanged and carries no tool results is the engine's own object,
 * handle included; every other message is rebuilt without a handle, so the
 * engine builds it from the content (tool uses and tool results inside stay the
 * engine's own objects where unchanged). The assistant messages kept from one
 * response are rebuilt as one, at the place of the first, so its calls stay
 * one message with their results after it.
 * (Ported from orangewk/fast-jev-compaction 911ae3f, 5dad087, ad91a16.)
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  // ponytail: the host writes a rebuilt message as one line with a fresh message.id,
  // so the calls of one response rebuilt one by one become separate API messages, and
  // the host's pairing check replaces the results of all but the last with "missing"
  // (upstream #137). Rebuilding the response as one message keeps them paired.
  const starts = responseStarts(input);
  const response = sourceIndices(input, output).map((index, at) =>
    output[at]!.role === 'assistant' && index >= 0 ? starts[index]! : -1,
  );
  const members = new Map<number, Message[]>();
  output.forEach((message, at) => {
    if (response[at]! >= 0) members.set(response[at]!, [...(members.get(response[at]!) ?? []), message]);
  });
  const out: SessionMessage[] = [];
  output.forEach((message, at) => {
    const own = messages.get(message);
    // A kept tool-result message keeps its sourceToolAssistantUUID, the uuid its call
    // had before this compaction, and the host writes that as its parentUuid; a resume
    // reads from the boundary on and loses everything before the result (upstream #89,
    // #145). Rebuilt, it chains to the message before it; its attachments and non-text
    // blocks are lost.
    if (own && own.role === 'user' && !own.toolResults?.length) {
      out.push(own);
      return;
    }
    // ponytail: on resume the host merges every transcript line sharing an assistant
    // message.id, across compact boundaries too, so a kept handle multiplies the
    // message (upstream #129). Rebuilding mints a fresh id; thinking blocks are lost.
    // Return the handle again once the host stops merging across boundaries.
    const group = members.get(response[at]!) ?? [message];
    if (group[0] !== message) return;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: group.map((member) => member.text).filter((text) => text.length > 0).join('\n\n'),
      toolUses: group.flatMap((member) =>
        member.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
      ),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    out.push(rebuilt);
  });
  return out;
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const endpoint = resolveEndpoint(config, config.apiKey);
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, endpoint.model, endpoint.baseUrl),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results moved to drawer` : '',
    stats.smallMoved > 0 ? `${stats.smallMoved} short results cut to a head` : '',
    stats.inputsMoved > 0 ? `${stats.inputsMoved} long inputs moved to drawer` : '',
    stats.noticesMoved > 0 ? `${stats.noticesMoved} host notices moved to drawer` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  // A failing notice must not turn a finished compaction into a fallback (upstream #36).
  try {
    $.ui.log(text);
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    /* the outcome stands without its notice */
  }
}

/** How long a compaction waits for Jev before falling back: the host's fetch has no timeout (upstream #117). */
const JEV_DEADLINE_MS = 30_000;

/** Below this context fill an auto compaction is the idle one, not a full window. */
const ROOMY_PERCENT = 70;

/**
 * The context's fill: the higher of the model window's and the compaction window's
 * (which may be smaller and is what auto-compaction fires on); 100 when unknown, so
 * the safe fallback still runs.
 */
async function contextPercent($: {
  session: {
    usage: (args: { breakdown: 'summary' }) => Promise<{ context: { percent?: number; breakdown?: { percentage: number } } }>;
  };
}): Promise<number> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' });
    return Math.max(context.percent ?? 100, context.breakdown?.percentage ?? 100);
  } catch {
    return 100;
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);

  on('session.compact', async ($, event, next) => {
    // A subagent's or fork's own transcript goes to the built-in summary: a resumed
    // subagent compacted here 400s on duplicate server_tool_use ids (upstream #89).
    if (event.agentId) return next(event);
    if (event.trigger === 'precompute') return { skip: 'jev-compaction-plus: no precompute' };
    try {
      const config = {
        ...configured,
        // `/compact <instructions>` reaches Jev as part of the goal (upstream #39, #50).
        ...(event.instructions
          ? { goal: `${configured.goal || goalFromMessages(event.messages)}\nCompaction instructions: ${event.instructions}` }
          : {}),
        apiKey: await getApiKey($, configured),
        drawerDir: drawerPath(
          configured.drawerDir ?? HOOK_DRAWER_DIR,
          await $.session.cwd(),
          (await $.env.get('HOME')) ?? '',
        ),
      };
      const { result, messages } = await Promise.race([
        compactSession(event.messages, config, async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        }),
        $.clock.sleep(JEV_DEADLINE_MS, { signal: next.signal }).then((): never => {
          throw new Error(`Jev did not answer within ${JEV_DEADLINE_MS / 1000} s`);
        }),
      ]);
      try {
        for (const line of decisionLogLines(result)) $.ui.log(line);
      } catch {
        /* diagnostics only */
      }
      const ratio = reductionRatio(result);
      if (ratio >= config.minReductionRatio) {
        // jev-compaction-plus: write the drawer first; if that fails, nothing is dropped
        // ponytail: no split for >4 MiB results; tool output caps keep them far below
        for (const file of result.drawer) {
          if (file.path.endsWith('/.gitignore') && await $.fs.exists(file.path)) continue;
          await $.fs.write(file.path, file.text);
        }
      }
      if (ratio < config.minReductionRatio) {
        // The idle auto-compaction fires soon after the last round, when little is new:
        // with room left, leaving the conversation as it is beats the built-in summary.
        const skip = event.trigger === 'plugin' || (event.trigger === 'auto' && (await contextPercent($)) < ROOMY_PERCENT);
        notify(
          $,
          `${skip ? 'skipped, conversation unchanged' : 'fallback to built-in summary'} (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return skip ? { skip: `below ${percent(config.minReductionRatio)} minimum` } : next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `${event.trigger === 'plugin' ? 'skipped, conversation unchanged' : 'fallback to built-in summary'} (${error instanceof Error ? error.message : String(error)})`,
      );
      return event.trigger === 'plugin' ? { skip: error instanceof Error ? error.message : String(error) } : next(event);
    }
  });
};

export { resolveOptions };
