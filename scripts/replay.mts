/**
 * Replays the first compaction round of real Claude Code transcripts through
 * compact() + toSessionMessages() with the live Jev, and checks what the host
 * would send next: every tool_use answered in the user turn right after it.
 * Prints the keepResult distribution, the calibration input for keepThreshold.
 *
 *   TYPESAFE_API_KEY=... [KEEP=0.5] npx tsx scripts/replay.mts <session.jsonl>...
 *
 * Sends the transcript to Jev, as the plugin itself does on /compact.
 */
import { readFileSync } from 'node:fs';
import { JevClient } from '../src/client.js';
import { compact, reductionRatio } from '../src/compact.js';
import type { Message, ToolResult, ToolUse } from '../src/types.js';
import { toSessionMessages } from '../hooks/fast-jev.ts';

type Row = Record<string, unknown>;

/** Rows before the first compaction boundary: the input of the first round. */
function firstRound(file: string): Row[] {
  const out: Row[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let row: Row;
    try {
      row = JSON.parse(raw) as Row;
    } catch {
      continue;
    }
    if (row['subtype'] === 'compact_boundary') break;
    out.push(row);
  }
  return out;
}

/** The engine hands the hook one message per content block (after orangewk's replay-transcript.mts). */
function toMessages(rows: Row[]): Message[] {
  const messages: Message[] = [];
  for (const row of rows) {
    const type = row['type'];
    if ((type !== 'user' && type !== 'assistant') || row['isSidechain']) continue;
    const content = (row['message'] as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') {
      messages.push({ role: type, text: content, toolUses: [] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Row[]) {
      if (block['type'] === 'text') {
        messages.push({ role: type, text: String(block['text'] ?? ''), toolUses: [] });
      } else if (block['type'] === 'tool_use') {
        const use: ToolUse = {
          tool_use_id: String(block['id']),
          tool: String(block['name']),
          input: (block['input'] ?? {}) as Record<string, unknown>,
        };
        messages.push({ role: 'assistant', text: '', toolUses: [use] });
      } else if (block['type'] === 'tool_result') {
        const raw = block['content'];
        const text =
          typeof raw === 'string' ? raw : ((raw ?? []) as Row[]).map((x) => String(x['text'] ?? '')).join('\n');
        const result: ToolResult = { tool_use_id: String(block['tool_use_id']), text, isError: block['is_error'] === true };
        messages.push({ role: 'user', text: '', toolUses: [], toolResults: [result] });
      }
    }
  }
  return messages;
}

/** Calls the next request would leave unanswered: results must sit in the user turn right after their call. */
function unpaired(messages: readonly Message[]): string[] {
  const bad: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.toolUses.length === 0) return;
    const answered = new Set<string>();
    for (let next = index + 1; next < messages.length && messages[next]!.role === 'user'; next++) {
      for (const result of messages[next]!.toolResults ?? []) answered.add(result.tool_use_id);
    }
    const last = index === messages.length - 1;
    for (const tool of message.toolUses) if (!answered.has(tool.tool_use_id) && !last) bad.push(tool.tool_use_id);
  });
  return bad;
}

function quantiles(values: number[]): string {
  if (values.length === 0) return '—';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(2);
  return `p10 ${at(0.1)} p50 ${at(0.5)} p90 ${at(0.9)} max ${at(0.999)}`;
}

const asker = new JevClient();
for (const file of process.argv.slice(2)) {
  const messages = toMessages(firstRound(file));
  const name = file.split('/').pop()!.slice(0, 8);
  if (messages.length === 0) {
    console.log(`${name} | no messages`);
    continue;
  }
  try {
    const before = unpaired(messages).length;
    const result = await compact(messages, asker, { drawerDir: '/tmp/replay-drawer', keepThreshold: Number(process.env['KEEP'] ?? 0.5) });
    const out = toSessionMessages(messages, result.messages);
    const { stats } = result;
    const scored = result.decisions.filter((d) => d.reason !== 'pinned' && d.reason !== 'small');
    console.log(
      [
        name,
        `msgs ${stats.messagesBefore}→${out.length}`,
        `chars ${stats.charsBefore}`,
        `calls ${stats.calls} (kept ${stats.kept}, small ${result.decisions.filter((d) => d.reason === 'small').length}, drawer ${stats.resultsDropped}, pinned ${stats.pinned})`,
        `reduction ${(100 * reductionRatio(result)).toFixed(0)}%${reductionRatio(result) < 0.25 ? ' FALLBACK' : ''}`,
        `keepResult ${quantiles(scored.map((d) => d.keepResult))}`,
        `stage ${stats.stateStage} ×${stats.requests}`,
        `unpaired ${before}→${unpaired(out).length}`,
      ].join(' | '),
    );
  } catch (error) {
    console.log(`${name} | throws: ${(error as Error).message.slice(0, 160)}`);
  }
}
