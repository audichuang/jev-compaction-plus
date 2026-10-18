# 別人怎麼處理「不確定要不要留」的 context：compaction 做法調查

調查日期：2026-10-18。只引用一手來源：官方文件、GitHub 原始碼（固定到 commit）、論文、第一方工程部落格。
標記說明：
- **[原始碼/文件]**：直接讀原文或原始碼確認過。
- **[轉述]**：經由網頁抓取工具讀到的內容，數字有對過，但字句可能不是一字不差。
- **[推論]**：本文自己的判斷，沒有來源直接支持。
- **UNVERIFIED**：找不到一手來源。

本 repo 的現況（引用 `src/compact.ts`、`hooks/fast-jev.ts`）：
- 每個舊 tool result 問 Jev 一題 `noul`，問的是「這份輸出要不要原封留著」。
- ≥ 0.6 原封保留；< 0.6 全文搬進 drawer 檔，只留一行指標（`src/compact.ts` L299-315）。
- 不問 Jev、照規則處理的三類，都留 300 字開頭、其餘進 drawer：
  - 小結果（500–1500 字）
  - 長的 tool 輸入欄位
  - 系統寫入的 user 文字
- 沒有摘要，沒有中間層。
- Jev 一輪有 30 秒期限（`hooks/fast-jev.ts` L432 `JEV_DEADLINE_MS = 30_000`）。
- 有預覽時 keepResult 的中位數約 0.45（`src/compact.ts` L19-22）。也就是說，0.2–0.6 這一帶涵蓋了很大一部分候選。

---

## 1. Claude Code 內建 compaction

### 1.1 摘要做什麼、保留什麼

**摘要怎麼產生** [文件]
- Claude Code 另外送一個請求，內容是同一個 system prompt、同一組 tools、同一段歷史，最後加一則「請摘要」的 user 訊息。https://code.claude.com/docs/en/prompt-caching 〈Compacting the conversation〉
- 官方對摘要內容的唯一描述（https://code.claude.com/docs/en/context-window 〈What survives compaction〉的 timeline）：「The summary keeps: your requests and intent, key technical concepts, files examined or modified with important code snippets, errors and how they were fixed, pending tasks, and current work. It replaces the verbatim conversation: full tool outputs and intermediate reasoning are gone.」
- 摘要 prompt 的逐字全文沒有公開：UNVERIFIED。

**會自動回來的東西**（同頁表格）[文件]
- 專案根目錄的 CLAUDE.md、auto memory、plan：從磁碟重新注入。
- 最近讀過或改過的檔案：「re-reads up to five, most recently modified first」。
  - 超過 5,000 token 的檔案只回一個路徑參照（顯示為 `Referenced file`），不帶內容。這本身就是一種「指標代替內容」。
- 叫用過的 skill 內文：重新注入，每個上限 5,000 token，總共上限 25,000 token。

**順序是先清 tool 輸出，再摘要** [文件]
https://code.claude.com/docs/en/how-claude-code-works 〈When context fills up〉：「It clears older tool outputs first, then summarizes the conversation if needed.」

**自訂摘要重點** [文件]
- 用 `/compact <instructions>`，或在 CLAUDE.md 加一段「Compact Instructions」。
- 來源：https://code.claude.com/docs/en/how-claude-code-works 、https://code.claude.com/docs/en/commands

**Hooks** [文件]（https://code.claude.com/docs/en/hooks）
- PreCompact / PostCompact 的 matcher 是 `manual` / `auto`。`auto` 包含「Auto-compact when the conversation reaches the auto-compact window, and idle compaction」。
- PreCompact 可以擋下 compaction：exit code 2，或回傳 `{"decision":"block"}`。CHANGELOG v2.1.105 加入。
- PostCompact 拿得到 `compact_summary`。CHANGELOG v2.1.76 加入。

### 1.2 閒置 compaction：實際是約 54 分鐘、200K token，不是 45 分鐘、20K

官方記載 [原始碼/文件]：
- CHANGELOG（https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md）：
  - v2.1.299：「Added idle compaction in the terminal: a 200K+ token conversation left idle for about 54 minutes is compacted before its one-hour prompt cache expires」
  - 同版：「Added `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` to change idle compaction's 200K-token minimum; `"idleCompaction": false` in settings.json turns it off. Both need v2.1.290 or later」
  - v2.1.302：`/config` 多了一列 `Idle compaction`。
- https://code.claude.com/docs/en/settings-reference 〈idleCompaction〉列出的條件，要全部成立才會觸發：
  - 互動式終端機 session
  - 1 小時 prompt cache TTL
  - 能抓到 feature flag
  - context 達到門檻（預設 200,000）
  - 距上次請求約 54 分鐘，而且電腦當時是醒著的
- `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` 低於 100000 的值會被拉到 100000。https://code.claude.com/docs/en/env-vars

**和本 repo 的落差** [推論]
`AGENTS.md`「不可退回的設計」第 5 點，以及 README 都寫「閒置約 45 分鐘、超過約 20K」。官方數字是約 54 分鐘、預設 200K（最低 100K）。

另外有一個容易搞混的機制：閒置 75 分鐘以上回來時，會提示你 `/clear`。那只是提示，不是 compaction（CHANGELOG v2.1.84）。

### 1.3 能設定什麼、設在哪裡 [文件]

**環境變數**
- 可以放在 shell，也可以放在 settings.json 的 `env` 區塊。後者「take effect no matter how `claude` was launched」。https://code.claude.com/docs/en/env-vars

| 名稱 | 種類 / 位置 | 作用（官方原文重點） |
|---|---|---|
| `autoCompactEnabled` | settings.json（任一層），`/config` 的 Auto-compact | `false` 關掉自動壓縮，idle compaction 也一起關；`/compact` 照樣可用 |
| `autoCompactWindow` / `modelSettings` | settings.json；`/autocompact`、`--autocompact` | 自動壓縮視窗，100000–1000000 或 `"auto"`（v2.1.288+） |
| `idleCompaction` | settings.json，`/config` | 預設 `true`（v2.1.290+） |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | env | 1–100，代表視窗的百分之幾觸發；**只能調低**：「values above the default percentage are ignored」；只在「compact before the model's context limit」的 session 生效；主對話和 subagent 都適用 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | env | 視窗 token 數，只接受純整數；優先於 flag 和 setting |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | env | idle 門檻，預設 200000，最低 100000 |
| `DISABLE_AUTO_COMPACT` | env | `1` 關掉自動壓縮和 idle；覆蓋 `autoCompactEnabled` |
| `DISABLE_COMPACT` | env | `1` 連 `/compact` 也關 |

- 設定鍵的說明見 https://code.claude.com/docs/en/settings-reference 。
- 原生 1M 的模型預設在約 967K 時壓縮。https://code.claude.com/docs/en/model-config 〈Default auto-compact thresholds〉
- 對本 plugin 的意義 [推論]：`compactAtPercent`（60）由 plugin 自己在 turn.complete 觸發，和上表彼此獨立。如果想讓「原生」auto-compact 也提早觸發，只能用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 往下調。

---

## 2. Anthropic API 與工程文章

### Context editing [文件]
來源：https://platform.claude.com/docs/en/build-with-claude/context-editing

- **`clear_tool_uses_20250919`**
  - 從最舊的 tool result 開始清，「replaces each cleared result with placeholder text indicating to Claude that it was removed」。佔位文字的確切字串沒有公開（UNVERIFIED）。
  - 參數：
    - `trigger`：預設 100,000 input tokens，也可以用 `tool_uses` 計。
    - `keep`：預設保留 3 個 tool use。
    - `clear_at_least`：清不到這麼多就不清，用來判斷值不值得打破 cache。
    - `exclude_tools`：永遠不清的 tool。
    - `clear_tool_inputs`：預設 `false`，也就是保留呼叫本身。
- **`clear_thinking_20251015`**：清舊的 thinking。
- **和 memory tool 一起用**：快到門檻時，Claude 會收到警告，提醒它先把重要資訊存起來。

### Memory tool [文件]
- `memory_20250818`，在 client 端執行，檔案放 `/memories`。https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

### Server-side compaction [文件]
- `compact_20260112`：`trigger` 預設 150,000，最少 50,000；可用 `instructions` 換掉預設 prompt。
- 產生一個 `compaction` block，之前的內容全部丟掉。
- 來源：https://platform.claude.com/docs/en/build-with-claude/compaction

### 量測 [轉述]
https://claude.com/blog/context-management （2025-09-29）：
- 在 agentic search 內部評測上，「memory + context editing」比 baseline 提升 39%，只用 context editing 提升 29%。
- 100 輪的 web search 評測裡，token 用量少 84%。

### 〈Effective context engineering for AI agents〉 [轉述]
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents 〈Context engineering for long-horizon tasks〉：
- 「One of the safest lightest touch forms of compaction is tool result clearing」
- 調 compaction prompt 的建議是先求 recall、再求 precision：「Start by maximizing recall … then iterate to improve precision」。
- 其他手法：structured note-taking（NOTES.md、to-do），以及 sub-agent 回傳 1,000–2,000 token 的濃縮結果。

### 〈How we built our multi-agent research system〉 [轉述]
https://www.anthropic.com/engineering/multi-agent-research-system
- subagent 把工作存到外部系統，只回傳輕量的參照（reference），避免「game of telephone」。

---

## 3. 其他 agent / 框架

本節的原始碼引用寫成 `repo@sha path Lx-y`，完整網址為 `https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<x>-L<y>`。使用的 commit：

| repo | commit |
|---|---|
| openai/codex | `8c076942cb70fba8e5c4732c23f1faabc4aed484`（`codex-rs/` 底下） |
| google-gemini/gemini-cli | `ed96faedfd5571f055c44f2c9509d62321d1138d` |
| OpenHands/OpenHands | `cce2080ae0a93638cacc2c81342350b15458222f`（V0 condenser 最後還在的 commit） |
| OpenHands/software-agent-sdk | `3f26a05` |
| cline/cline | `9ee618111d58630fea30b27439216448225458e0`（舊版）；`a42df8c`（SDK） |
| RooCodeInc/Roo-Code | `b867ec9` |
| Aider-AI/aider | `5dc9490` |
| langchain-ai/deepagents | `0ce837bf69ff0efb10c2fa100039cc0c78a74a11`（`libs/deepagents/deepagents/middleware/`） |
| JetBrains-Research/the-complexity-trap | `bf15b5fb7d279679035a007ac9a81084d6b9a89a` |
| SWE-agent/SWE-agent | `main`（讀取日 2026-10-18） |

例如：https://github.com/google-gemini/gemini-cli/blob/ed96faedfd5571f055c44f2c9509d62321d1138d/packages/core/src/context/contextCompressionService.ts#L425-L500

### 3.1 OpenAI Codex CLI [原始碼]（`openai/codex@8c07694`）

**觸發**
- `model_auto_compact_token_limit`（`codex-rs/core/src/config/mod.rs` L654-655）。
- 實際生效值取「設定值」和「視窗 90%」兩者中的小者（`codex-rs/protocol/src/openai_models.rs` L529-540）。

**本地 compaction**
- prompt 在 `prompts/templates/compact/prompt.md` L1-9：「CONTEXT CHECKPOINT COMPACTION … handoff summary for another LLM」。
- 原封保留的只有真正的 user 訊息，從新到舊取，上限 20,000 token（`compact.rs` L64, L715-819）。
- 跨過預算的那一則會被截斷，並標記 `mark_retained_sources_incomplete()`（L788-801）。這是 Codex 唯一的「中間層」：截斷後明確標示不完整。
- tool 輸出全部進摘要，不存檔，沒有指標。

**遠端 compaction（OpenAI / Azure）**
- 回傳一個加密的 `Compaction` item（`protocol/src/models.rs` L1295-1304）。
- 旁邊另外保留：
  - user 訊息
  - ≤ 10K token 的 agent 訊息
  - 「retained」tool 輸出（「retained whole or dropped」）
- 上述全部合計上限 64K（`compact_remote_v2.rs` L87-88, L480-578）。
- 舊的 `/responses/compact` endpoint 已在 #44273（commit 1ac689c）移除。

**分數**：沒有。完全依類型、預算、新舊決定。

### 3.2 OpenHands [原始碼]

**舊版 condenser**（`OpenHands/OpenHands@cce2080`，`openhands/memory/condenser/impl/`）
- `ObservationMaskingCondenser`：`attention_window=5`，比 window 舊的 observation 換成 `<MASKED>`。呼叫本身留著，沒有指標。
- `BrowserOutputCondenser`：換成 `Visited URL … Content omitted`。
- `AmortizedForgettingCondenser`：超過 `max_size=100` 就砍到一半，只留頭尾，不摘要。
- `LLMSummarizingCondenser`：留頭 `keep_first`、留尾 `max_size//2`，中間連同前一次的摘要一起重新摘要。
- `StructuredSummaryCondenser`：用 function calling 填固定欄位，例如 `files_modified`、`failing_tests`、`error_messages`。
- **`LLMAttentionCondenser`**（L23-116）：本調查中**唯一由模型替每個項目打重要度、決定去留**的 condenser。
  - prompt 要 LLM「sort the identifiers in order of how important … for the next step」。
  - 保留前 `max_size//2` 名，其餘直接遺忘。
  - LLM 回傳的 ID 不夠時，用「最新的」補。
  - 沒有中間層，也不摘要。
- 這些 V0 condenser 在 2026-04-24 的 7498353 從 main 移除。

**新版 SDK**（`OpenHands/software-agent-sdk@3f26a05`）
- 只剩 `LLMSummarizing`、`NoOp`、`Pipeline`。
- 預設 `max_size=240`、`keep_first=2`。

**量測** [轉述]
https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents （2025-04-09）：
- 每輪 API 成本最多降 2 倍。
- 在 SWE-bench Verified 子集上解題率 54%，baseline 53%。

### 3.3 Gemini CLI [原始碼]（`google-gemini/gemini-cli@ed96fae`）——分層最細的一家

1. **Chat compression**（`packages/core/src/context/chatCompressionService.ts`）
   - 觸發：`DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5`（L45）。
   - 保留最後約 30%（`COMPRESSION_PRESERVE_THRESHOLD = 0.3`）。
   - 摘要前先跑一個預算處理：tool 回應從新到舊數，前 50,000 token 原封保留；更舊的**存到 `tool-outputs/` 檔案**，留 head/tail 預覽加檔案路徑（L351-464）。
   - 摘要是 `<state_snapshot>` XML，包含 `<artifact_trail>`、`<file_system_state>` 等欄位。
   - 摘要寫完後再跑一輪「probe」自我檢查（L616-645）。
2. **Tool Output Masking**（`packages/core/src/context/toolOutputMaskingService.ts`）：每輪都跑。
   - 最新的 50,000 token tool 輸出受保護，可清掉的量 ≥ 30,000 才動手。
   - 被遮的輸出寫進檔案，context 裡留：
     - shell：頭尾各 10 行
     - 其他：頭尾各 250 字
   - 接著是 `Output too large. Full output available at: <path>`（L365）。
   - `activate_skill`、`ask_user` 永遠不遮。
3. **實驗性 `contextManagement`**（預設關）
   - `toolDistillationService.ts`：超過 20,000 token 的輸出，由次要 LLM 抽出 10 行內的關鍵事實（錯誤訊息、路徑、結果），加上檔案路徑。
   - **`contextCompressionService.ts`**：flash-lite 把每個讀過的檔案分到 **FULL / PARTIAL（行範圍）/ SUMMARY / EXCLUDED** 四層（L440 起）。
     - 失敗時一律當 FULL：「Default all to FULL so any failure is safe」（L429）。
     - 每層都附一句可以找回原文的提示，例如「Full file available via read_file」。
     - 這是本調查中唯一明確的「保留／部分／摘要／丟棄」分層。不過它是由 LLM 選類別，沒有用機率門檻；而且沒找到正式路徑呼叫它（UNVERIFIED）。

### 3.4 Cline / Roo Code [原始碼]

**Cline 舊版**（`cline/cline@9ee6181`，`src/core/context/context-management/ContextManager.ts`）
1. 先去重：同一個檔案較舊的讀取結果，換成「This file read has been removed … Refer to the latest file read」。
2. 只有省不到 30% 才硬截斷：保留第一對訊息，砍掉一半或 3/4（L299-335, L626-658）。
3. `/smol` 的摘要 prompt 要求一節「Required Files」。摘要完由 `SummarizeTaskHandler.ts` 從磁碟重讀這些檔案，上限 8 個、100K 字。

**Roo Code**（`RooCodeInc/Roo-Code@b867ec9`）
- 摘要後舊訊息只是加上 `condenseParent` 標記，可以 rewind。但 model 看不到指標。
- 摘要之外另外保留兩類：
  - `<command>` 工作流程區塊
  - 讀過檔案的 tree-sitter 簽名（「folded file context」，上限 50,000 字）

### 3.5 Aider [原始碼]（`Aider-AI/aider@5dc9490`）
- `aider/history.py` L27-96：只摘要舊的 user/assistant 對話，保留不到一半預算的尾巴。
- prompt（`aider/prompts.py` L46-59）要求「less detail about older parts and more detail about the most recent」。
- 漸層只靠 prompt 裡的這句話表達。

### 3.6 Cursor [轉述]
https://cursor.com/blog/dynamic-context-discovery （2026-01-06）：
- 長的 tool 輸出「write the output to a file and give the agent the ability to read it」。
- 摘要時把聊天歷史當成檔案，讓 agent 事後能搜回細節。
- 舊文件頁已轉址，相關描述 UNVERIFIED。

### 3.7 Manus
https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus [原始碼/文件]：
- 「Our compression strategies are always designed to be restorable」：網頁內容可以丟，只要 URL 留著；文件內容可以丟，只要路徑留著。
- 「Keep the Wrong Stuff In」：錯誤要留在 context 裡。

後續講者投影片（LangChain × Manus webinar，2025-10）與 https://rlancemartin.github.io/2025/10/15/manus/ [轉述]：
- 每個 tool call 有「full」和「compact」兩種表示，compact 版存的是指向全文的參照。
- 舊的 tool result 先換成 compact，新的保持完整。
- compaction 效益遞減之後才做 schema 化摘要。
- 投影片上的 stub 文字範例：「Retrieve from /home/ubuntu/foo.txt if needed」。

### 3.8 Factory.ai [轉述／數字有對過]
- https://factory.com/news/compressing-context ：
  - 增量式「anchored」摘要，每次更新錨定在某一則訊息上，不整份重寫。
  - 摘要必須保留 session intent、artifact trail，以及「Breadcrumbs, or references for reconstructing context for truncated artifacts」。
- https://factory.com/news/evaluating-compression （2025-12-16）：
  - 用 probe 評測（以 GPT-5.2 當 judge，滿分 5）比較三家：

    | 方法 | Overall | Artifact |
    |---|---|---|
    | Factory | 3.70 | 2.45 |
    | Anthropic | 3.44 | 2.33 |
    | OpenAI | 3.35 | 2.19 |

  - 三家在 artifact 追蹤上都最弱，結論是「probably requires specialized handling beyond summarization: a separate artifact index」。
  - 「The right optimization target is not tokens per request. It is tokens per task」。

### 3.9 LangChain deepagents [原始碼]（`langchain-ai/deepagents@0ce837b`）
- `FilesystemMiddleware`
  - 單一 tool 結果超過 `tool_token_limit_before_evict = 20000`（`filesystem.py` L1897）就搬到 `/large_tool_results/`。
  - 留下的 stub 寫明路徑，並建議分段讀（`_message_eviction.py` L31-40），後面附頭尾各 5 行預覽（L115）。
- `summarization.py`
  - 0.85 觸發，保留 0.10。
  - 完整歷史存到 `/conversation_history/{session_id}.md`。
  - 摘要訊息開頭寫「The full conversation history has been saved to {file_path}」（L825-833）。
- 官方部落格 https://www.langchain.com/blog/context-management-for-deepagents [轉述] 描述的順序：
  1. 先卸載大結果
  2. 再卸載舊的寫入參數
  3. 都沒得卸載了才摘要
- 部落格說預覽是前 10 行，原始碼是頭尾各 5 行，兩者不一致。

### 3.10 JetBrains「The Complexity Trap」 [原始碼/論文]
https://arxiv.org/abs/2508.21433 ；程式碼 https://github.com/JetBrains-Research/the-complexity-trap

**設定**
- SWE-agent 跑 SWE-bench Verified，共 5 種模型設定。
- observation masking 保留最近 M=10 輪：「M = 10 yields optimal performance」（App. D.1）。
- 佔位字串（SWE-agent `sweagent/agent/history_processors.py` L172）：`Old environment output: ({n} lines omitted)`。

**結果（Table 1）**
- masking 在 5 個設定中有 4 個比 raw 便宜約一半。
- 解題率和 LLM 摘要互有勝負。例如 Qwen3-Coder 480B：
  - masking：54.8%，$0.61
  - 摘要：53.8%，$0.64
  - raw：53.4%，$1.29

**軌跡拉長（§4.4）**
- 用 LLM 摘要時軌跡變長：Gemini 2.5 Flash 平均 52 輪，masking 是 44 輪。
- 論文的解釋：摘要「mask failure signals that would otherwise prompt earlier termination」。

**其他**
- 摘要本身的生成成本最多佔總成本 7.2%（Table 2）。
- Hybrid（先 masking，摘要當最後手段）只在 50 題子集上量過：比 raw 解題率 +2.6 個百分點；成本比 masking 低 7%、比摘要低 11%。

### 3.11 論文 [論文]

| 論文 | 機制 | 有沒有用分數決定分層 |
|---|---|---|
| SWE-Pruner, arXiv 2601.16746 | 0.6B 小模型替每行打分，分數 > τ 才留 | 有分數，但只分「留／丟」兩種 |
| LLMLingua, arXiv 2310.05736 | token 重要度剪枝 | 有分數，但當 agent baseline 時表現差 |
| AgentFold, arXiv 2510.24699 | 模型自己選兩種摺疊粒度 | 有分層，由模型選，沒有分數 |
| ACON, arXiv 2510.00615 | LLM 壓縮器，依長度觸發 | 無 |
| MemGPT, arXiv 2310.08560 | main context / archival 分層，靠 function call 換頁 | 有分層，由 agent 管理 |

各篇數字：
- SWE-Pruner（Table 1）：Sonnet 4.5 解題率 70.6 → 72.0%，token 少 23.1%。
- ACON 裡幾個簡單的 baseline（FIFO、LLMLingua、Prompting），步數反而增加（24–33 步，對照組 16 步）。
- MemGPT（Table 2，DMR）：GPT-4 從 32.1% 到 92.5%。

---

## 4. 問題 4：有沒有人用分數分層，或把不確定的項目交給 LLM/agent？

**結論：沒有人用信心分數做「保留／摘要／搬檔／丟棄」四層。**

接近的做法：
- **Gemini CLI 實驗性的 `contextCompressionService`**
  - 由 LLM 為每個讀過的檔案選 FULL / PARTIAL / SUMMARY / EXCLUDED，每層都附回讀指標，失敗時當 FULL。
  - 預設關閉，沒有公開量測。
- **OpenHands `LLMAttentionCondenser`**
  - 由 LLM 排重要度，前一半留、其餘丟。沒有中間層，沒有量測。
- **SWE-Pruner**
  - 小模型打分加門檻，只分兩層。在 SWE-bench Verified 上省 23–38% token，解題率略升。
- **Gemini CLI 的 `toolDistillationService`**
  - 對超大輸出（> 20K token）另外叫一個 LLM 抽關鍵事實，同時保留檔案路徑。
  - 依「大小」決定，不是依「信心」。也沒有量測。
- **TypeSafe 自己的文件**（就是 Jev 的廠商）
  - https://docs.typesafe.ai/primitives/noul ：「Values in the middle can go to a person rather than either code path.」
  - https://docs.typesafe.ai/patterns/confidence-routing.md 示範三段式：低於 0.6 交給人；0.6–0.85 要求確認；更高才自動執行。
  - 也就是說，廠商建議的是「中間值走第三條路」，不是硬切成兩邊。

**其他系統的中間層，靠的是位置、大小、類型，不是分數：**
- 新的保留全文，舊的留預覽加指標：Gemini、deepagents、Manus、Codex 的 retained 項目。
- 摘要只當最後手段：JetBrains hybrid、Manus、deepagents。

**量測上的結論**
- 最直接的對照是 JetBrains：便宜的 masking 至少和 LLM 摘要一樣好。
- 摘要多花約 7% 成本，還會讓軌跡拉長 13–15%。
- 「把不確定的交給 LLM 摘要」沒有證據顯示比「留預覽 + 指標」更好。

---

## 5. 問題 5：「你丟了這些，放在這裡」的提示，比靜默刪除有用嗎？

**沒有找到直接的對照實驗**（同樣條件下，有指標 vs 靜默刪除）。間接證據：

- **MemGPT**：只有摘要 vs 摘要加可換頁取回的全文，DMR 32.1% → 92.5%。測的是「能不能取回」，不是指標文字本身。
- **SWE-agent 論文**（arXiv 2405.15793，Table 3）：較舊的觀察壓成一行 stub，比保留全歷史高 3 個百分點（18.0 vs 15.0）。但沒有「完全刪除」這一組。
- **ACM**（arXiv 2607.23809）：訓練後會用 query 工具才有效（0.635 → 0.727）。未訓練的強模型幾乎不呼叫取回工具。所以指標有沒有用，取決於模型會不會去讀。
- **Factory**：artifact 追蹤是三家最弱的一項，原因是遺失路徑。它建議另外維護一份 artifact index。
- **業界實作幾乎都留指標**：Anthropic context editing 的佔位文字、SWE-agent 的「lines omitted」、Gemini 和 deepagents 的路徑加預覽、Manus 的「Retrieve from … if needed」。
- **本 repo 自己的證據**：README L57 的 drawer 測試，Claude 自己打開 drawer 引用了被搬走的那一行。只有一次（n=1），屬於軼事。
- **反面訊號**：JetBrains 發現內容豐富的摘要會掩蓋失敗訊號；Manus 主張保留錯誤。
  [推論] 指標應該精簡、只講事實（工具、輸入、大小、路徑、是否錯誤），不要加詮釋。

---

## 6. 給本 plugin 0.2–0.6 低信心帶的建議

先講限制：
- **Jev 不能寫摘要。** TypeSafe 官方：「While Jev gives up string generation, it's optimized for structured outputs」（https://typesafe.ai/blog/introducing-system-one-models-and-jev ）。它只回傳 `noul`、`choice`、`score` 的機率（https://docs.typesafe.ai ）。
- 任何「摘要」選項都要接第二個模型，例如 Haiku 等級。這是設計上的改變，不只是調參數：目前的 hook 只有在退回時才會用到 Opus。
- Jev 單次延遲 70–500 ms（TypeSafe 部落格）；hook 期限 30 秒。

另外，本 repo 的 `src/types.ts` L163-206 已經宣告了 `choice`（有 `probabilities`、`confidence`）和 `score`，只是 `src/compact.ts` 沒用到。
- 官方：同一個請求裡的問題「evaluated in parallel and in isolation」，多加問題幾乎不增加延遲（https://docs.typesafe.ai ）。
- `score` 最多 10 級，`choice` 最多 255 個選項（https://docs.typesafe.ai/primitives/score 、/choice）。

建議依「效益 ÷ 成本」排序：

### 6.1 中間帶改留「頭尾預覽 + 指標」，不再只留一行指標（強烈建議）

**做法**
- `keepResult` 在 [0.25, 0.6)：留頭尾預覽（例如頭 300 字加尾 300 字，或頭尾各 10 行）加上 drawer 路徑。
- 低於 0.25：維持現在的一行指標。

**依據**
- Gemini masking（頭尾各 250 字或 10 行）、deepagents（頭尾各 5 行）、Manus 的 compact 表示、Codex 的「截斷並標示不完整」。
- 所有主流做法的中間層都是「預覽 + 可取回」。
- 輸出的尾巴常有結果和錯誤（測試摘要、exit code），所以留尾比只留頭有用 [推論]。

**成本**：零延遲，不需要新模型。每項多約 150 token。

**實作注意**：
- `drawerFor` 看到文字裡有 `[Jev compaction moved` 就不再搬（`src/compact.ts` L323）。新的預覽 stub 必須保留這個標記，否則第二輪會把預覽本身再搬一次。
- 現在的 `truncatedResultText`（L155-161）和 drawer stub 都只留頭，要加尾巴得改這兩處。

**風險**：壓縮率下降。必須用 `scripts/replay.mts` 確認每個 session 的 reduction 仍 ≥ 25%、`unpaired` = 0；分界點（0.25）也要從 replay 的分布調。

### 6.2 在 context 裡放一則「本次搬走了什麼」的索引訊息（建議）

**做法**
- 現在 `INDEX.md` 只寫在磁碟（`src/compact.ts` L298, L359），model 看不到。
- 改成在最後一個保護區之前插入一則精簡的 user 訊息，列出每個被搬項目的 `tool + 輸入前 80 字 + 路徑 + 是否錯誤`。或者至少給 `INDEX.md` 的路徑。

**依據**
- Factory 的「separate artifact index」建議，以及 artifact 分數最低的結果。
- deepagents 和 Cursor 把完整歷史存檔，並在摘要開頭給路徑。

**成本**：一則訊息，每項約 30 token；零延遲。

**風險**：
- 項目多時要設上限，例如只列中間帶的項目，或只給路徑。
- 這則訊息要被 `isHostText` 一類的規則認得，下一輪才不會被當成使用者文字永遠保留 [推論]。
- 新插入的訊息沒有 handle，牽涉到 `AGENTS.md` 的「不可退回的設計」：`toSessionMessages`（`hooks/fast-jev.ts` L259）如果重建錯，曾經造成 resume 丟歷史（#89/#145）和 assistant 訊息重複（#129）。上線前必須通過 `AGENTS.md` 的 `--resume` 重複檢查。比較保守的替代做法是不插新訊息，只在每個 stub 結尾附上 `INDEX.md` 的路徑。

### 6.3 用 Jev `choice` 或 `score` 一題取代 `noul`，讓 Jev 直接選層（值得做實驗）

**做法**
- `choice`：criteria 設為 `keep_verbatim` / `preview_and_drawer` / `drawer_only`。
- 或用 `score` 三級。
- 用回傳的 `confidence` 做 TypeSafe 文件說的 confidence-gated routing：信心低時往保守的一層靠，例如 `preview_and_drawer`。這和 Gemini 「失敗就當 FULL」的保守預設一致。

**成本**：題數不變，延遲幾乎不變。

**風險**：
- 現有的 0.6 門檻是用 `noul` 校準的，換題型要重新跑 replay。
- 兩份 TypeSafe 文件說法不一。部落格說「All answers are accompanied with calibrated probabilities and confidence scores」；`noul` 文件頁則沒有提到校準，而且 `noul` 沒有 `confidence` 欄位（https://docs.typesafe.ai/primitives/noul ）。
- 可以先保留 `noul`，用 6.1 的固定分界上線，再拿 `choice` 做 A/B。

### 6.4 加上「年齡」維度（低成本、可選）

**做法**：中間帶裡，離現在超過 N 輪（例如 JetBrains 的 M=10）的項目降成只留指標；較新的保留預覽。

**依據**：JetBrains 的 masking 窗口；Gemini 從新到舊保護 50K 的預算。

**和現況的關係**：`preserveRecentMessages`（6）已經是一個硬性的年齡窗口，這裡只是把窗口延伸到中間帶。

### 6.5 錯誤結果至少留頭尾（建議，小改動）

**現況**：小結果的規則已經讓錯誤原封保留（`src/compact.ts` L323）；但大的錯誤輸出走 Jev 路徑，一樣可能變成只留一行指標。

**做法**：建議 `isError` 至少走 6.1 的預覽。

**依據**：Manus「Keep the Wrong Stuff In」；JetBrains 發現隱藏失敗訊號會拉長軌跡。

### 6.6 不建議預設開啟：每個中間帶結果叫 LLM 寫短摘要，或整批交給 sub-agent 摘要

**理由**
- Jev 寫不了，必須接第二個模型。
- 中間帶佔候選的很大一部分，因為中位數約 0.45。延遲會從約 0.5 秒變成數秒到數十秒，要在 30 秒期限內並行處理數十個請求。
- 這也違背本 plugin 存在的理由：README 的實測是內建摘要 35.1 秒，本 plugin 0.43–0.74 秒。
- 證據面：
  - JetBrains 顯示摘要沒有比 masking 好，還會拉長軌跡、多花約 7% 成本。
  - Gemini 只在超過 20K token、而且是實驗模式時才做 LLM 抽取。
- 「交給 agent 摘要」其實就是現在的退回路徑（內建 Opus 摘要），結構上已經等同 JetBrains 的 hybrid：先 masking，摘要當最後手段。

**真要做的話**：只針對「中間帶 + 超大（例如 > 20K token）」的項目，在 hook 之外非同步產生摘要，寫進 drawer 檔的開頭。不要放在 compaction 的關鍵路徑上。

### 驗證方式（每一項都適用）
依 `AGENTS.md`：
- `scripts/replay.mts` 重播真實 session：reduction ≥ 25%、`unpaired` = 0；`ROUNDS=3` 看多輪。
- 再加上 README 那種「drawer 找回測試」，但要多做幾次，不能只看 n=1。

### 順帶發現（不在問題範圍內）
`AGENTS.md` 和 README 對 idle compaction 的描述（約 45 分鐘、約 20K）和官方（約 54 分鐘、預設 200K、最低 100K，見 §1.2）不一致，建議更正。這段判斷的是「70% 以下就 skip」的情境，數字改了，邏輯不受影響。
