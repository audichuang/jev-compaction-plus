# jev-compaction-plus

> **audichuang's fork** of [cth9191/jev-compaction-plus](https://github.com/cth9191/jev-compaction-plus)
> (itself a fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
> neither updated since early October 2026). On top of plus's drawer design it carries:
>
> | Fix | Source |
> |---|---|
> | Resume keeps the compacted history: kept tool-result and assistant rows are rebuilt without their `handle` (upstream #89, #145, #129) | [orangewk](https://github.com/orangewk/fast-jev-compaction) 911ae3f, 5dad087 |
> | The kept calls of one response are rebuilt as one message, so parallel results are not replaced with "Tool result missing" (#137) | orangewk ad91a16, e1a77b5 |
> | Subagent and precompute compactions go to the built-in summary | orangewk 99c5823 |
> | A failed plugin-triggered compaction skips instead of running the Opus summary; drawer `.gitignore` written first, unique folders | [Agreor](https://github.com/Agreor/jev-compaction-plus) #1–#4 |
> | Text cuts never split a surrogate pair; the request body escapes any lone one (#128) | orangewk a4c8fcd (dhruv1220) |
> | Long tool-input fields (Write content, Bash heredocs, Agent prompts) and host-written user text (skill bodies, task notifications, reminders) keep a head and move to the drawer by rule; typed and pasted text is never touched. On 10 real sessions this took the first compaction from 13–61% (5 of 10 falling back to the Opus summary) to 49–76% | this fork |
> | Drawer defaults to `~/.claude/jev-drawer`, outside every project; `keepThreshold` 0.6 from replayed real sessions; toast reports drawer-moved calls as moved results | this fork |
> | Credential-shaped text (keys, tokens, `NAME=value` secrets, private keys) is redacted from every Jev request, previews included; the transcript is unchanged (upstream #98) | [socialadsmentor](https://github.com/socialadsmentor/fast-jev-compaction) `redact.ts` |
> | Only the result question is asked (every call stays with the drawer), small and pinned results are not asked about; the default goal leaves host text out and `/compact <instructions>` reaches Jev; a 30 s deadline on the Jev round | this fork, after upstream #39/#50/#78/#117 |
> | A dropped result Jev scored 0.25 or higher, any dropped error and any dropped `Agent`/`Task` answer keep their start and end (600 chars) above the drawer pointer, where verdicts and conclusions sit; every pointer names the folder's `INDEX.md`. From an audit of 18 real compactions: the model rarely knew what it had lost, and the losses that hurt were conclusions that lived only in a result. See [docs/research/compaction-approaches.md](docs/research/compaction-approaches.md) | this fork |
> | Results under `minDropChars` are never asked about but no longer stay whole: past the protected window, unless an error, they keep a 300-char head and move to the drawer by rule (they were the biggest thing every round kept). An auto compaction below the minimum with the context under 70% full (Claude Code's idle compaction soon after the last round) leaves the conversation as it is instead of running the Opus summary | this fork |
>
> Costs, by design: kept messages are rebuilt, so their thinking blocks, images and attached rows
> (queued mid-turn prompts among them, upstream #133) are lost at compaction. The drawer is never pruned.
> Loaded skill bodies never reach the hook (the host keeps `isMeta` rows out of `session.compact`).
>
> Install: `claude plugin marketplace add audichuang/jev-compaction-plus && claude plugin install jev-compaction-plus@jev-compaction-plus`

**Claude Code compaction in about half a second instead of about 35.**

When a Claude Code session fills up, `/compact` makes Opus stop, re-read the whole
conversation and write a summary. This plugin hands that job to
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's
System One decision model. Jev doesn't write anything. It decides, for every old
tool result, whether you still need it:

- whatever it keeps stays **word for word**;
- whatever it drops moves to a **drawer file** that Claude can read back.

It's a fork of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
with three fixes that made the difference on a very large session (see below).

## Results

One real Opus 5.5 session in Claude Code, grown to **591,489 tokens**: a whole demo
codebase, an 8,000-line log and a test run. We compacted it inside the live
session, then asked 6 questions about details from early in the session (a
trace id, a config value, an exact buggy line, and so on), with no tools allowed.

| | Time to compact | Memory quiz | Tokens left |
|---|---|---|---|
| Built-in `/compact` (Opus writes a summary) | 35.1 s | 6/6 | ~16k |
| fast-jev-compaction (original) | 0.35 s | 5/6 | ~7k |
| **jev-compaction-plus** | **0.43–0.74 s** | **6/6 (3 runs)** | **~26k** |

- **Speed:** about 50-80× faster than the built-in compaction.
- **Usage:** it never calls Opus. Each compaction costs a fraction of a cent of Jev.
- **Memory:** it matched the built-in compaction on the quiz.
  - The original plugin forgot a config value. It had dropped an 833-character file without ever seeing what was inside.
- **Drawer test:** after compacting, we asked for one exact line from an old `pytest -v` run that had been moved out, and said not to re-run anything. Claude noticed the output was gone, opened the drawer file and quoted the line.

These numbers come from one session and one quiz, so treat them as an example, not a benchmark.

## How it works

```
/compact (or Claude Code's own auto-compaction)
      │
      ▼
Jev gets the conversation (texts + tool calls) and, for every old tool result,
a yes/no question that quotes a preview of that result:
"does the assistant still need this output word for word?"
      │
      ├─ yes ............................ result stays, word for word
      ├─ no, but it's tiny (<1,500 chars) result stays (dropping it saves nothing)
      └─ no ............................. result moves to ~/.claude/jev-drawer/<time>/t12-Read.txt;
                                          the session keeps the call plus a one-line label:
                                          [Jev compaction moved this 48213-char output to
                                           …/.jev-drawer/…/t12-Read.txt. Read that file if
                                           you need it again.]
```

- **Always kept:**
  - your messages and Claude's replies, which are never touched;
  - the first message;
  - the newest 6 messages.
- **Fallback:** if Jev fails, or can't cut at least 25%, Claude Code's normal summary runs instead.
- **The drawer:** each compaction gets its own folder, with an `INDEX.md` listing what was moved. The drawer has its own `.gitignore`, so it never ends up in a commit.

### What's different from fast-jev-compaction

1. **Jev sees what it judges.**
   - The original sent Jev a one-line note per result (`Read config/app.env → ok, 833 chars (omitted)`), so Jev decided from the file name.
   - Here, each question quotes the start and end of the result (600 characters by default).
2. **Tiny results always stay.** Results under 1,500 characters are kept, because dropping them saves almost nothing and they're often exactly the value you need later.
3. **Dropped doesn't mean deleted.** Dropped results go to the drawer, and the call stays in the session with a label pointing at the file. A wrong decision costs one file read, not a lost fact.
4. **Bug fix for split replies.**
   - Claude Code stores one Opus reply that makes several tool calls as several pieces sharing one message id.
   - Rewriting the "tool call" piece breaks that link, and Claude Code then reports the sibling results as "Tool result missing due to internal error".
   - This version only rewrites the result piece.
5. **Either key works.** A TypeSafe key goes to TypeSafe's API. An OpenRouter key (`sk-or-…`) goes to OpenRouter's decisions API (`typesafe/jev-1.13`) automatically.

## Install

You need:

- **Claude Code with function hooks:** version 2.1.274 or newer (tested on 2.1.282). Function hooks are early access, so turn them on with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- **A Jev key:** either a TypeSafe key or an OpenRouter key.

Put both in `~/.claude/settings.json`, so every session (terminal, desktop app, IDE) sees them:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "TYPESAFE_API_KEY": "<your TypeSafe or OpenRouter key>"
  }
}
```

Then install the plugin:

```sh
claude plugin marketplace add cth9191/jev-compaction-plus
claude plugin install jev-compaction-plus@jev-compaction-plus
```

Or run it straight from a clone (this is how it was tested):

```sh
git clone https://github.com/cth9191/jev-compaction-plus
cd your-project
claude --plugin-dir /path/to/jev-compaction-plus
```

Use `/compact` as usual. A toast like `kept 412/431 messages, no summary (…)` means Jev did it. A toast starting `fallback to built-in summary` means it handed over to the normal summary.

## Settings

Set these in the plugin's options (`.claude-plugin/plugin.json` → `userConfig`):

| Option | Default | What it does |
|---|---:|---|
| `keepThreshold` | `0.6` | Jev's minimum "still needed" probability to keep a result. **Lower is more cautious.** |
| `previewChars` | `600` | How much of each result Jev sees (start + end). |
| `minDropChars` | `1500` | Results shorter than this are never sent to Jev; past the protected window they keep a head and move to the drawer by rule (errors stay whole). |
| `drawerDir` | `~/.claude/jev-drawer` | Where dropped results go; `~/` is the home folder, a relative path is resolved against the project. Empty = delete them like the original. |
| `preserveRecentMessages` | `6` | Newest messages never touched. |
| `compactAtPercent` | `60` | After an answer, compact once the context passes this percentage (the host refuses it while a turn still runs; it backs off 5 points after a skip). Claude Code's own and idle compactions also run through the plugin. |
| `minReductionRatio` | `0.25` | Below this cut, use the built-in summary instead; an auto compaction with the context under 70% full is skipped instead. |
| `maxStateTokens` | `14000` | Budget for the conversation view sent with every Jev request. |
| `maxRequestTokens` | `30000` | Budget per Jev request (Jev's limit is 32k). |
| `model` | `jev-latest` | Jev model. With an OpenRouter key this becomes `typesafe/jev-1.13`. |
| `baseUrl` | (auto) | Override the endpoint. |
| `apiKey` | (env) | Instead of `TYPESAFE_API_KEY`. |

## Limitations

- **It only holds while the session is open.**
  - In testing, closing and resuming a compacted session brought back the full original history.
  - Claude Code's built-in compaction survives a resume, so that's the one place the built-in wins.
- **It leaves more behind than a summary does:** ~26k vs ~16k tokens in the test above. That's still a 96% cut, but you'll reach the next compaction a little sooner.
- **It only removes tool results.** In a mostly-chat session there's little to cut, and it falls back to the built-in summary.
- **Privacy:** your conversation text, tool inputs and result previews are sent to TypeSafe or OpenRouter, depending on your key. The built-in compaction stays with Anthropic.
- **The drawer is never cleaned up automatically.** Delete `~/.claude/jev-drawer/` whenever you like. After that, any labels still in the session point at nothing, so Claude just re-reads or re-runs.
- **Early-access hooks:** function hooks are early access in Claude Code, and the API may change.

## Development

```sh
npm install
npm test            # 36 tests (vitest)
npm run typecheck
```

- `src/` is the library: state building, Jev questions, decisions and the drawer.
- `hooks/fast-jev.ts` adapts it to Claude Code's `session.compact` hook.
- `src/` can also be used on its own as a library (`compact(messages, asker, options)`).

## Credits

This is built on [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) by tamara tran (MIT): the state fitting, batching and hook design are theirs. The changes listed above are ours. MIT licensed, see [LICENSE](LICENSE).
