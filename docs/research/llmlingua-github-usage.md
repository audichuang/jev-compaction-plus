# LLMLingua 與 token 級壓縮在 GitHub 上的實際用法

調查日期：2026-11-01。方法：`gh search code/repos/issues`，再用 `gh api` 讀原始檔。連結指向 `HEAD`（AutoGen 指向 `0.2` 分支），沒有固定 commit，之後可能變動。stars 與最後 commit 日期來自同一天的 GraphQL 查詢。

標記說明：
- **[原始碼]**：讀過原始檔。
- **[README]**：專案自己寫的數字，沒有重跑，也沒有驗原始數據。
- **[推論]**：本文的判斷，沒有來源直接支持。

閱讀深度不一。「僅呼叫點」表示只 grep 了參數和註解，沒有讀完整檔案。沒有重跑任何 benchmark。

---

## 結論

1. **「LLMLingua 壓 coding agent 的 tool output」且量過結果的，只找到一個資料點**：leanctx 一份 9 則訊息、約 2.1K token 的內部 transcript（[README](https://github.com/jia-gao/leanctx/blob/HEAD/README.md)）。它只驗 token 數和「程式碼、錯誤逐字保留」，沒有驗任務結果。
2. **最直接的反面實測來自 Tamp**：LLMLingua-2 在預設 rate 0.7 下把真實指令輸出弄壞，路徑變成 `/Users/x./tamp..`，版本號變成 `"version""0.. 17"`。Tamp 因此對含路徑、URL、JSON 分隔符、hex id、semver 的區塊一律跳過。在它自己的 fixtures 上，這個防護擋下 92% 的 text block。它的原話是 LLMLingua 對 coding agent 的貢獻「very little」（[README](https://github.com/sliday/tamp/blob/HEAD/README.md)）。
3. **曾整合 LLMLingua 的最大專案已經移除它**：Headroom（★78480）在 2026-03-26 刪掉整個整合，換成自訓的 ModernBERT 模型 Kompress（[commit 3290a3d](https://github.com/headroomlabs-ai/headroom/commit/3290a3d582cffb8f4e97de7d64c8b3f58fa0b55b)）。commit 訊息寫「better compression quality」，但沒有附數字。
4. **LLMLingua 比較可信的量測都在散文和 RAG 上，而且是付出準確率換來的**：leanctx 在 LongBench v2（N=503）上省 18.7%，整體準確率掉 1.8 pp，實際被壓的題目掉 3.9 pp，`short`/`lingua` 這組掉 17.6 pp（[README](https://github.com/jia-gao/leanctx/blob/HEAD/README.md)）。
5. **在 coding agent 流量上有量測的工具，幾乎都走結構規則、去重或可取回的做法**（Kompressor、Chisle、rtk、Headroom），見第 3 節。其中 Chisle 的數字最值得留意：單個合格輸出少約 46%，但只佔整個 session 內容的 1.3–2.1%（[報告](https://github.com/JayPokale/Chisle/blob/HEAD/benchmarks/results/2026-07-07-input-axis.md)）。

---

## 1. 檢視範圍與計數

共檢視 **49 個專案**（清單散見第 2–5 節；FlashRAG 只看到路徑、第 5 節標明未檢視的幾個都不計入），另有 3 個沒有找到相關內容或沒有定位到程式（第 6 節）。

有量測的專案，依量的內容分組（有重疊）：

| 分組 | 數量 | 專案 |
|---|---:|---|
| (a) 量 LLMLingua 用在 tool output 或 coding transcript | 2 | leanctx（壓縮數字）、Tamp（只量防護觸發率，也就是可壓範圍） |
| (b) 量 LLMLingua 用在散文、RAG、一般提示 | 3 | leanctx、DEFRA、TOMC |
| (c) 量非 LLMLingua 的做法用在 coding agent | 5 | optscale-kompressor、Chisle、rtk 基準 2 個（zuwasi、tahadz2008）、Headroom |
| (d) 其他量測（非 LLMLingua，也非 coding agent） | 2 | CAVEWOMAN、Entroly |

不重複計算共 **11 個專案有可查的量測**，其中只有 leanctx 和 Tamp 同時碰到「LLMLingua」和「coding agent 流量」。

有 Amazon 的 EMNLP 2025 研究（[repo](https://github.com/amazon-science/information-preservation-in-prompt-compression)）和 LongCodeZip（[ASE 2025](https://github.com/YerbaPage/LongCodeZip)）沒有算進去，因為這次只讀了 README，沒有讀論文數字。

---

## 2. 實際呼叫 LLMLingua 的專案

官方 API 的預設值：`rate=0.5`、`force_tokens=[]`、`force_reserve_digit=False`、`drop_consecutive=False`（[prompt_compressor.py](https://github.com/microsoft/LLMLingua/blob/HEAD/llmlingua/prompt_compressor.py)）。

### 2.1 框架整合

| 專案 | ★／最後 commit | 呼叫與參數 | 壓什麼 | 保護什麼 | 狀態與量測 |
|---|---|---|---|---|---|
| [AutoGen 0.2 `TextMessageCompressor`](https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/contrib/capabilities/transforms.py) | 61657／2026-10-28 | 見 2.2 | 對話中每則訊息的文字 | 無內建保護，靠使用者設 `filter_dict` | 0.2 分支才有；無量測 |
| [LangChain `LLMLinguaCompressor`](https://github.com/langchain-ai/langchain-community/blob/HEAD/libs/community/langchain_community/document_compressors/llmlingua_filter.py) | 285／2026-06-19，這個拆分出來的 repo 已封存；是否搬到別處未查 | 預設 `NousResearch/Llama-2-7b-hf`（v1）；`compress_prompt(context, instruction, question, target_token, rank_method, condition_in_question="after", context_budget="+100", reorder_context="sort", dynamic_context_compression_ratio=0.4)` | 檢索後的文件 | query 與 instruction 不在被壓的 context 裡 | 無量測 |
| [LlamaIndex `LongLLMLinguaPostprocessor`](https://github.com/run-llama/llama_index/blob/HEAD/llama-index-integrations/postprocessor/llama-index-postprocessor-longllmlingua/llama_index/postprocessor/longllmlingua/base.py) | 52764／2026-10-14 | 預設同上（v1），可切 `use_llmlingua2` | 檢索後的 node | query 與 instruction | 無量測 |
| [AWorld（ai-agent-book 內的副本）](https://github.com/chemark/ai-agent-book/blob/HEAD/chapter8/gaia-experience/AWorld/aworld/core/context/processor/llmlingua_compressor.py) | 362／2026-10-07 | v1 Llama-2；`target_token=300`；用 `<#refN#>` 標記對回訊息 | agent 對話訊息與純文字 | 無內建 | 無量測 |
| [FlashRAG](https://github.com/RUC-NLPIR/FlashRAG/blob/HEAD/flashrag/refiner/llmlingua_compressor.py)、[BERGEN](https://github.com/naver/bergen/blob/HEAD/models/context_processors/llmlingua2.py) | 3602／2026-10-27；283／2026-03-11 | BERGEN：v2、`force_tokens=["\n","?"]`、rate 由設定決定 | RAG 評測的 context | — | 是評測框架；這次沒有讀它們的結果。FlashRAG 僅看到搜尋結果中的路徑 |

**Semantic Kernel**：`llmlingua repo:microsoft/semantic-kernel` 的 code search 和 `semantic kernel llmlingua` 的 repo search 都是 0 筆（2026-11-01）。code search 有索引延遲，這不等於一定沒有。

### 2.2 AutoGen `TextMessageCompressor` 細讀 [原始碼]

來源：[text_compressors.py](https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/contrib/capabilities/text_compressors.py)、[transforms.py](https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/contrib/capabilities/transforms.py)。

- **預設**：`microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`、`use_llmlingua2=True`、`device_map="cpu"`、`structured_compression=False`。`compression_params` 預設為空，所以實際 rate 是函式庫預設的 0.5。
- **位置**：掛在 `TransformMessages` 上，每次呼叫模型前對訊息清單做轉換。
- **閘門只有兩個**：
  - `min_tokens` 比的是**整份對話的總量**（`min_tokens_reached(messages, ...)`），不是單則。一過門檻，短訊息也一起壓。
  - `filter_dict` / `exclude_filter`，預設不過濾。
- **沒有的東西**：沒有最近訊息保護，沒有程式碼、JSON 或路徑判斷，沒有 tool result 的特殊處理，也不留原文。
- **快取**：有選用的 `cache`，因為模型在本地跑（[PR #2225](https://github.com/microsoft/autogen/pull/2225) 的註記）。`cache_key` 只用 content 和 `min_tokens`，不含 `compression_params`，換 rate 會讀到舊結果 [推論，由程式碼讀出]。
- **小瑕疵**：
  - `_compress_multimodal` 的 `elif isinstance(item, str)` 分支把結果指定給迴圈變數 `item`，沒有寫回 list，純字串項目的壓縮結果會被丟掉，但 savings 照算。
  - Protocol 的 docstring 寫結果放在 `compressed_text`，實際讀的是 `compressed_prompt`。
- **`structured_compression=True` 的風險**：預設模型是 v2，而維護者在 [LLMLingua #114](https://github.com/microsoft/LLMLingua/issues/114) 說 `structured_compress_prompt` 當時不支援 v2 系列。
- **量測**：PR #2225 內文沒有任何數字。class docstring 只說效果「can vary」。
- **後續使用者回報**：[#2499](https://github.com/microsoft/autogen/issues/2499)（TransformMessages 與 GroupChat 的 speaker selection 不相容，只看了標題）。[PR #2661](https://github.com/microsoft/autogen/pull/2661)（標題為 Ignore Some Messages When Transforming，應是 `filter_dict` 的來源 [推論]）。
- **現況**：AutoGen 預設分支的 [`python/packages`](https://github.com/microsoft/autogen/tree/HEAD/python/packages) 下沒有對應的 capability 套件，recursive tree 也找不到 `text_compressors` 或 `lingua`（這棵 tree 沒有檢查是否被截斷）。AG2 HEAD 的 tree（未被截斷）沒有路徑含 `compress`、`lingua`、`transform` 的檔案，舊路徑也已不存在。另外有 [elizaOS](https://github.com/elizaOS/eliza) 等 repo 帶著 vendored 副本（`mm_agents/coact/autogen/...`）。沒有找到說明移除原因的 issue，所以只能說「新版找不到」，不能說「因效果不好而棄用」。

### 2.3 Coding-agent 與 proxy 類

| 專案 | ★／最後 commit | 呼叫與參數 | 壓什麼 | 保護什麼 | 量測與反轉 |
|---|---|---|---|---|---|
| [Headroom](https://github.com/headroomlabs-ai/headroom) | 78480／2026-10-30 | 已移除 | 曾為 proxy 的文字階段 | — | [commit 3290a3d](https://github.com/headroomlabs-ai/headroom/commit/3290a3d582cffb8f4e97de7d64c8b3f58fa0b55b) 刪除 35 個檔案。[#143](https://github.com/headroomlabs-ai/headroom/issues/143)／[#67](https://github.com/headroomlabs-ai/headroom/issues/67) 的討論串說 v0.5.5 移除，[wiki](https://github.com/headroomlabs-ai/headroom/blob/HEAD/wiki/transforms.md) 寫 0.9.x，版本號互相矛盾，以 commit 日期為準 |
| [leanctx](https://github.com/jia-gao/leanctx) | 321／2026-08-22 | `llmlingua-2-xlm-roberta-large-meetingbank`、ratio 0.5 | 文件、檢索段落、log、舊回合 | code、stack trace、`tool_use_id`、tool 名稱與輸入、JSON 逐字 | 見第 4 節。首次載入約 1.2 GB 權重 |
| [Tamp](https://github.com/sliday/tamp) | 95／2026-09-01 | [sidecar](https://github.com/sliday/tamp/blob/HEAD/sidecar/server.py)：XLM、`force_tokens=["\n","?","!",".",",","'",'"']`；README 寫預設 rate 0.7，sidecar 請求模型的預設是 0.5 | 只有不含路徑等內容的散文 | 見結論第 2 點 | 防護擋下 92%；可用 `TAMP_STAGES` 關掉 |
| [Machina-Harness](https://github.com/kiazh/Machina-Harness/blob/HEAD/machina/core/optimization/compression/learned.py) | 3／2026-10-29 | v2、目標 ratio 0.6、`force_tokens=["\n",".","?","!"]`、**預設關閉** | 較舊的 assistant 與 tool 文字 | system、當前回合、tool schema、已快取前綴；span protector 加 quality guard，失敗回原文；有 shadow 模式 | 無公開數字 |
| [superlocalmemory](https://github.com/qualixar/superlocalmemory/blob/HEAD/src/superlocalmemory/optimize/compress/prose_llmlingua.py) | 269／2026-10-28 | XLM、rate 0.5、需要 `compress_mode=aggressive` | 只有散文 | 註解寫「NEVER JSON or code」；先存原文（CCR） | 無 |
| [Laconic](https://github.com/lindameng-0/laconic/blob/HEAD/laconic/compress/llmlingua.py) | 21／2026-09-29 | XLM | payload 的自由文字片段 | `protected` 片段略過。註解：「agent traffic is *not* prose」 | 只看了 adapter |
| [Token-Optimizer](https://github.com/tankumar27/Token-Optimizer/blob/HEAD/optimizer/llm_lingua_layer.py) | 0／2026-06-22 | rate 0.9／0.78／0.65、`force_reserve_digit=True`、`drop_consecutive=True` | 提示第二階段 | placeholder、語意與實體驗證，不過就退回；大提示跳過；在 Render 上預設不載模型 | 無 |
| [token-proxy](https://github.com/ChenYueqi2024/token-proxy/blob/HEAD/app/compression/llmlingua_backend.py) | 0／2026-07-20 | v2，rate 由呼叫端決定 | 逐則訊息 | README 寫有關鍵片段保護、驗證、逾時、LRU；建議先關閉 | 無 |
| [claude-shorthand](https://github.com/gladehq/claude-shorthand) | 7／2026-03-16 | BERT、rate 0.4、門檻 800、語言關鍵字與錯誤類別放進 `force_tokens` | Claude Code 的**使用者提示**（`UserPromptSubmit` hook） | `force_tokens` 只保住那些字，不保護整段 | README 寫「up to 60%」，只有一行 log 範例，repo 描述寫 ~55% |
| [ClaudeShrink](https://github.com/g-akshay/ClaudeShrink) | 5／2026-04-25 | 目標 30%，512–4096 token 上下限 | 手動丟入的提示與檔案（skill） | 無 | 只有 README 表格 |
| [Shiori](https://github.com/PaoloMassignan/shiori/blob/HEAD/src/shiori/compressors/llmlingua.py) | 0／2026-06-15 | BERT、rate 0.5 | 只壓 user prompt | 註解：「should never be used for retrieval or QA tasks」 | 無 |
| [autonomous-sre-agent](https://github.com/faizanhussainrabbani/autonomous-sre-agent/blob/HEAD/src/sre_agent/adapters/compressor/llmlingua_adapter.py) | 2／2026-08-15 | XLM、ratio 0.5、30 個 SRE 詞放進 `force_tokens` | 事件文字 | 指定的詞 | 無 |

### 2.4 其他呼叫（僅呼叫點，無量測）

| 專案 | ★／最後 commit | 參數 |
|---|---|---|
| [LightMem](https://github.com/zjunlp/LightMem/blob/HEAD/src/lightmem/factory/pre_compressor/llmlingua_2.py) | 1208／2026-10-26 | v2 或 v1，進入記憶前逐則壓，超過 512 token 再壓一次；失敗就略過壓縮。LoCoMo 等結果在它的 README，這次沒有分離出壓縮的影響 |
| [sandeco/prompts](https://github.com/sandeco/prompts/blob/HEAD/sandeco-token/sandeco-token-reduce/scripts/compress.py) | 923／2026-10-26 | rate 0.4、領域 `force_tokens`、`force_reserve_digit`、`drop_consecutive`；壓縮前先去掉 code fence 行 |
| [edge-ai-libraries](https://github.com/open-edge-platform/edge-ai-libraries/blob/HEAD/libraries/adaptive-token-compressor/src/adaptive_token_compressor/model_servers/lingua/app.py)（Intel） | 177／2026-10-30 | v2 服務、預設 rate 0.33、`["\n","?"]`、OpenVINO 後端 |
| [clojure-system-prompt](https://github.com/iwillig/clojure-system-prompt/blob/HEAD/compress.py) | 46／2026-05-13 | CLI，rate 0.5，壓 `SYSTEM.md` |
| [deepview-mcp](https://github.com/Mitek99/deepview-mcp/blob/HEAD/compress.py) | 65／2025-08-07 | XLM；`--ratio` 只用於訊息，呼叫時寫死 `rate=0.55` |
| [sago](https://github.com/duriantaco/sago/blob/HEAD/src/sago/utils/compression.py) | 14／2026-04-12 | BERT、目標比 0.5、可傳 instruction 和 question |
| [Tokenomics](https://github.com/Tokenomics-AI/Tokenomics/blob/HEAD/tokenomics/compression/llmlingua_compressor.py) | 9／2026-01-01 | BERT、0.4 |
| [context_pager](https://github.com/vatsalyd/context_pager/blob/HEAD/src/context_pager/core/compression.py) | 0／2026-08-27 | v2、用 `target_token`、`["\n","?","!"]` |
| [token-maxxing](https://github.com/kadamsahil2511/token-maxxing/blob/HEAD/compressor.py) | 0／2026-10-22 | rate 0.6、`["\n",".","?"]`、`force_reserve_digit` |
| [Brandsight-GEO](https://github.com/Alchemist-PANDA/Brandsight-GEO/blob/HEAD/geo_audit_agent/services/context_compression.py) | 1／2026-07-21 | rate 0.3、括號與領域詞、`drop_consecutive` |
| [caduceus](https://github.com/TSKVenkat/caduceus/blob/HEAD/src/compress/llmlingua.ts) | 0／2026-08-02 | TS 透過 sidecar，rate 0.5 |
| [Entroly](https://github.com/juyterman1000/entroly/blob/HEAD/bench/accuracy.py) | 481／2026-11-01 | 只當 benchmark 選項（`llmlingua`、`hybrid`），XLM |

**不是真正呼叫函式庫，但名字有 LLMLingua**：[vincio](https://github.com/Ohswedd/vincio/blob/HEAD/vincio/context/llmlingua.py)（★2，自己的 token 評分規則），[memory-indexer](https://github.com/iyulab/memory-indexer/blob/HEAD/src/MemoryIndexer.Sdk/Intelligence/Compression/LLMLinguaCompressor.cs)（★1，C#，用 embedding 當 perplexity 的替代）。

### 2.5 參數使用的觀察

只統計上表讀到的呼叫點：

- **rate**：集中在 0.4–0.6；最激進的是 0.3（Brandsight）和 0.33（Intel 預設），最保守的是 Token-Optimizer 的 0.9／0.78／0.65。
- **`force_tokens`**：多半是 README 範例 `["\n","?"]` 的變形。少數放領域詞（SRE、claude-shorthand、sandeco、Brandsight）。
- **`drop_consecutive`**：只有 3 個專案開（Brandsight、sandeco、Token-Optimizer）。
- **`force_reserve_digit`**：sandeco、Token-Optimizer、token-maxxing 開；Intel 服務提供選項但預設關。
- **模型**：幾乎都是 `*-meetingbank`，從名字看是會議語料訓練的。這和它們被拿來壓的 tool output 不是同一類文字 [推論]。
- **保護方式的分水嶺**：認真處理 agent 流量的專案（leanctx、Tamp、Machina、superlocalmemory、Laconic）都是在**呼叫前先分類，不讓結構內容進模型**，而不是靠 `force_tokens` 救。原因見第 4 節 #93、#149：`force_tokens` 保單一 token，保不住整個路徑或識別字 [推論]。

---

## 3. Coding-agent 端的做法（不限 LLMLingua）

| 專案 | ★／最後 commit | 做法 | 壓什麼 | 不壓什麼 | 量測 |
|---|---|---|---|---|---|
| [optscale-kompressor](https://github.com/hystax/optscale-kompressor/blob/HEAD/README.md) | 28／2026-10-22 | 確定性規則、可取回（`ref:k_…`） | ≥512 字的 tool output | **Claude Code 刻意完全不壓**：最後一則是 cache breakpoint，改任何位元組都會讓快取失效 | Terminal-Bench 2.1，89 任務，帳單差異，見下 |
| [Chisle](https://github.com/JayPokale/Chisle/blob/HEAD/benchmarks/results/2026-07-07-input-axis.md) | 731／2026-10-24 | ANSI 與重複行清理、頭尾保留、撈出錯誤行、去重 | Bash、Agent、WebFetch、WebSearch、Grep、Glob、`mcp__*`（allowlist） | Read、Edit、Write | 171 個真實 session 重播，見下 |
| [rtk](https://github.com/rtk-ai/rtk/blob/HEAD/README.md) | 85152／2026-10-31 | 指令別的過濾器 | bash 輸出 | `rtk read` 預設原樣 | 自己承認省的比例會被稀釋；第三方基準見下 |
| [Headroom](https://github.com/headroomlabs-ai/headroom/blob/HEAD/README.md) | 78480／2026-10-30 | JSON 統計取樣、錯誤全留、Kompress、CCR 可取回 | live zone 的工具內容 | [程式碼多半直接通過，近 4 則不壓，對話含「debug／fix」等字時全部保護](https://github.com/headroomlabs-ai/headroom/blob/HEAD/wiki/LIMITATIONS.md) | 見下 |
| [Prism](https://github.com/shawnt1790/prism) | 0／2026-10-27 | 過濾 vs 卸載＋路徑 | tool output | — | 課程專案，**還沒有結果** |
| [Repomix](https://github.com/yamadashy/repomix/blob/HEAD/website/client/src/en/guide/code-compress.md) | 29101／2026-11-01 | tree-sitter 留簽章，去掉實作 | 打包進提示的程式碼 | — | 文件標為 experimental；只讀了開頭，未見數字 |
| [Aider](https://github.com/Aider-AI/aider/blob/HEAD/aider/history.py) | 49856／2026-05-22 | LLM 摘要：留尾端約一半額度，前段遞迴摘要 | 舊對話 | 尾端訊息 | 無 |
| [opencode](https://github.com/anomalyco/opencode/blob/HEAD/packages/core/src/session/compaction.ts) | 223628／2026-11-01 | LLM 摘要＋保留尾端；摘要的 transcript 分級縮短：完整→tool output 頭尾各 2000 字→移除 output→只留 user→省略；背景先寫好摘要，等到需要才換上，以免破壞快取 | 舊對話 | 近期內容 | 無 |
| [Roo-Code](https://github.com/RooCodeInc/Roo-Code/blob/HEAD/src/core/context-management/index.ts) | 24253／2026-05-15，已封存 | [LLM 摘要](https://github.com/RooCodeInc/Roo-Code/blob/HEAD/src/core/condense/index.ts)，不足時依比例藏訊息 | 舊對話 | 第一則 | 無 |
| [Cline](https://github.com/cline/cline/blob/HEAD/apps/vscode/src/sdk/sdk-compaction.ts) | 71125／2026-10-30 | 只讀到 VS Code adapter，策略在 SDK，**未檢視** | — | — | — |

**這類專案的量測重點** [README 或報告，全部是專案方或第三方自述]：

- **Kompressor**：Terminal-Bench 2.1，87 個完成的任務，帳單 $107.89 → $83.40（−22.7%），Headroom 預設 −8.2%，最激進 −11.6%。解題率：不壓 82.2%、Kompressor 81.1%、Headroom 預設 81.6%、Headroom 最激進 85.1%，作者聲明解題率差異**不顯著**。billed prompt 有 93.0% 是 cache read。6,255 個 tool output 重播：Kompressor 去掉 62.8%，Headroom 開 ML 22.6%、關 ML 7.3%；每 KB 分別 0.2 ms、87 ms、1.5 ms。注意這是廠商部落格式的比較，對手是它點名的競品，且是 Codex 不是 Claude Code。
- **Chisle**：一位開發者的 171 個 session。tool output 佔 67.5%；超過 8K 字的輸出只佔 4%，但佔全部內容 25%；大輸出的主要來源是 Read（5.62M 字，Bash 只有 0.45M）。結果：單個合格輸出少 45–47%，**但只佔 session 內容 1.3–2.1%**，因為 Read 被排除。字元相同的去重 **0 次命中**（真實重跑通常時間戳不同）。作者承認沒有做對抗性的正確性測試。
- **rtk（[zuwasi 基準](https://github.com/zuwasi/rtk-token-benchmark/blob/HEAD/README.md)）**：12 個指令省 87–88%，但：
  - `rtk gain` 自己回報 44.9%；
  - 檔案讀取的省量來自 `--max-lines 150`；
  - pytest 的 12 個失敗只點名 10 個；
  - **Amp A/B（每邊 3 條 thread）**：tool output −56.4%，但處理的 context token 只 −16.2%；答對率 5/7 → 6–7/7，主因是 Amp 會截掉 50K 字以上的結果。
- **rtk（[tahadz2008 基準](https://github.com/tahadz2008/rtk-token-benchmark/blob/HEAD/README.md)）**：277 個真實檔案。`rtk read` 預設 0%；aggressive 模式只有 11.4% 的檔案落在宣稱的 60–90% 區間，中位數 0%；被壓的程式檔保留的識別字只有 52–79%；`rtk ls` 甚至多 21.7% token。token 用 regex 估算，非真實 tokenizer。
- **Headroom**：[Proof 表](https://github.com/headroomlabs-ai/headroom/blob/HEAD/README.md)是「依真實 MCP 輸出格式建的」合成情境，省 21–57%，GSM8K、TruthfulQA、SQuAD、BFCL 各 N=100。[benchmarks wiki](https://github.com/headroomlabs-ai/headroom/blob/HEAD/wiki/benchmarks.md)：build log 93.9%，**grep 和 Python 原始碼都是 0%**。

---

## 4. 反面證據與抱怨

**LLMLingua 本身**：

- [#149](https://github.com/microsoft/LLMLingua/issues/149)：「Fuel Dilution」變成「uedil」。維護者回覆這是 token 級壓縮的特性，建議用 `recover`。
- [#93](https://github.com/microsoft/LLMLingua/issues/93)：車牌、ID 等英數實體被破壞。維護者承認。
- [#104](https://github.com/microsoft/LLMLingua/issues/104)：壓縮截斷詞句，遺失關鍵資訊（法律文本）。維護者承認，歸因於 GPT-2 語意能力弱，建議換模型。
- [#39](https://github.com/microsoft/LLMLingua/issues/39)：LongLLMLingua 重排後 MRR 和 recall 沒有改善。
- [#64](https://github.com/microsoft/LLMLingua/issues/64)：壓縮速度慢，量化模型也不見得快。
- [#114](https://github.com/microsoft/LLMLingua/issues/114)：`structured_compress_prompt` 當時不支援 v2。
- [Transparency FAQ](https://github.com/microsoft/LLMLingua/blob/HEAD/Transparency_FAQ.md)：官方承認輸出對人難讀；高壓縮率、短提示時表現差。
- [#193](https://github.com/microsoft/LLMLingua/issues/193)：端到端延遲數字是 GPT-3.5 在 MeetingBank 摘要任務上量的，不能外推到 agent 流量 [推論]。

**leanctx 的量測本身也有反面**（[README](https://github.com/jia-gao/leanctx/blob/HEAD/README.md)）：

- README 明寫「Compression costs accuracy, it does not add it」。
- 整體 −1.8 pp 剛好落在專案自設的 −2 pp 門檻內；verbatim 那半數題目貢獻 0，壓到的題目是 −3.9 pp。單文件 QA −11.5 pp（N=78）。
- 程式碼多的 agent 流量估算只省 10.2%（線性外推，非實測）。
- [重現檢查](https://github.com/jia-gao/leanctx/blob/HEAD/benchmarks/clawrouter/results/short_route_counterfactual.md)自己標「DOES NOT fully reproduce」：早期公布 24.1%，重跑 18.7%。README 現在採用 18.7%，但 repo 描述仍寫 40–60%。
- 未壓縮的基準準確率只有 45.3%，這個任務本身就難，差異要連同這點一起看。

**獨立研究**：

- [DEFRA spike](https://github.com/DEFRA/ai-spike-token-optimisation/blob/HEAD/experiment-writeup.md)（英國政府部門的實驗）：LLMLingua-2 的 METEOR 0.42，**比簡單去停用詞的 0.48 低**；只多省 4–5%；輸出反而長 11%。只壓中段、保留前後指令的「Oreo」做法兩種都更好。注意限制：只有 10 個提示，都不到 1000 token，GPT-4，rate 0.8。
- [CAVEWOMAN](https://github.com/danielle34/cavewoman)（EMNLP 2026，128 萬次生成）：壓輸入讓成本最多增加 96%，每一級答案都變差；壓輸出便宜 1.7–3 倍。**不能直接套用**：它用文法剝除而非 LLMLingua，壓的是短問題（省 15–16 token），而 README 明說只在單回合短答案上測過。長 tool output 的情況不同。
- [TOMC](https://github.com/ZipengWu365/TOMC/blob/HEAD/docs/comparison_with_llmlingua.md)：直接用 LLMLingua-2 在 1M 長度的歷史上**產生 200 個空記憶**。這是競品自己的比較，但指出了「低 token 數不等於有效壓縮」這個評測陷阱。
- [Amazon EMNLP 2025](https://github.com/amazon-science/information-preservation-in-prompt-compression)：摘要提到有些方法保不住原文的關鍵細節。這次只讀了摘要。

**後繼者也有同樣問題**：[Headroom #4256](https://github.com/headroomlabs-ai/headroom/issues/4256)：Kompress 不知道問題是什麼，在 256-token context 下答案逐字保留率 41%，未壓縮是 65%。[Entroly](https://github.com/juyterman1000/entroly/blob/HEAD/README.md) 也承認 SQuAD 上從 80% 掉到 72%（n=20–50）。

**不做這件事的判斷**：

- [agentic-coding-evaluation #423](https://github.com/StrGm-AI-Ltd/agentic-coding-evaluation/issues/423)：原本想對超大 tool output 跑 perplexity 壓縮，複查後發現工具端已經截斷（Read 12000、Bash 8000 字），前提不成立，改為縮小範圍。
- Headroom [PR #4530](https://github.com/headroomlabs-ai/headroom/pull/4530) 描述中，有個受測 chat 引擎直接說「deliberately not using LLMLingua or similar, they pull in torch」。這只是引述，不是實驗。
- Kompressor 對 Claude Code 完全不壓，理由是快取（第 3 節）。

---

## 5. 只有 README、沒有資料的主張

下列數字這次找不到可查的方法或原始結果（不等於一定是錯的）：

- [claude-shorthand](https://github.com/gladehq/claude-shorthand)：「up to 60%」「~55%」，只有一行範例 log。
- [ClaudeShrink](https://github.com/g-akshay/ClaudeShrink)：~70%，是目標值，不是量測。
- [Tamp](https://github.com/sliday/tamp/blob/HEAD/README.md)：52.6%、60–70% 的管線總數。它有白皮書和 `bench/`，這次沒有讀。README 自己說單請求 fixtures 上 v0.5 到 L9 幾乎沒有差別（45.1–45.4%），又主張真實 session 上差很多，但沒有給數字。
- [llmslim](https://github.com/Thanatos9404/llmslim)（★24）：README 有 24 筆樣本的延遲和離線 benchmark 連結，這次沒有讀。範例是單一 ticket，112→72 token。
- [TwoTrim](https://github.com/overseek944/twotrim)、[chonkify](https://github.com/thom-heinrich/chonkify)（「+69% vs LLMLingua」）、[cctx](https://github.com/anil7948/cctx)（「70-90%」）、[Context-Sandbox](https://github.com/Youan-ai/Context-Sandbox)（「99.2%」）：只看到搜尋結果中的描述，**未檢視，不計入 49 個**。
- [LongCodeZip](https://github.com/YerbaPage/LongCodeZip)、LLMLingua 官方的「up to 20x」：有論文，這次沒有讀論文數字。

---

## 6. 沒有找到內容的專案

- **Semantic Kernel**：見 2.1，0 筆。
- **Mem0**：HEAD recursive tree 沒有路徑含 `compress` 或 `lingua`。不代表沒有其他形式的壓縮，**未檢視**。
- **Letta**：HEAD tree 沒有路徑含 `summar` 或 `compact`，舊路徑 `letta/services/summarizer/` 也取不到。這對一個同規模的專案很可疑，可能是目錄重組；**沒有定位到程式，不做任何推論**。

---

## 7. 綜合

| 做法 | 用在哪 | 在 coding 流量上的證據 |
|---|---|---|
| **Token 丟棄**（LLMLingua、Kompress） | 散文、RAG、舊回合、文件 | 只有 leanctx 的玩具 transcript 量過 LLMLingua。Tamp 的實測是負面的。Kompress 有 Kompressor 重播（22.6%），也有 Headroom 自己的 41% vs 65% 反例 |
| **結構規則**（過濾器、頭尾、錯誤撈取、JSON 取樣、tree-sitter） | tool output、程式碼 | 證據最多：Kompressor、Chisle、rtk、Headroom。但 rtk 的兩份第三方基準和 Chisle 都顯示，單項漂亮的數字到整個 session 會大幅縮水 |
| **去重**（重複讀檔、重複輸出） | session 範圍 | Tamp 宣稱重複區塊 −99%，無 session 數字。Chisle 的字元相同去重 0 次命中。證據不足且互相矛盾 |
| **摘要**（LLM） | 整段舊對話 | Aider、opencode、Roo、Cline 的路線。這次讀到的專案都沒有公開品質量測 |
| **可取回**（drawer、CCR、`ref:`） | 配合上述任一種 | Headroom、Kompressor、superlocalmemory、Prism 都有。Kompressor 有扣掉取回成本的數字（2,029,706 → 2,015,180，只是單次範例）。Prism 想量的「算進後續讀取後是否還省錢」目前沒有結果 |

**沒有被回答的問題**：沒有任何一份資料在真實 coding session 上比較過「token 丟棄 vs 規則 vs 可取回」，同時看任務成功率。最接近的是 Kompressor 的 Terminal-Bench，但它的臂沒有 LLMLingua，解題率差異也不顯著。

**對 Jev 的意義** [推論]：

- 有 coding-agent 量測的模式（依工具分流、頭尾預覽、保留錯誤、留可取回的指標）和本 repo 現行的 drawer 設計方向相同。這次的調查沒有給出改用 token 丟棄的理由。
- 如果要試，只有在散文上才有支持。可以對照的現成界線是 leanctx 和 Tamp 的「先分類，結構內容逐字」，而且應該比照 leanctx 把準確率變化一起量；只看 reduction 不夠。
- Kompressor 反對改寫 Claude Code 快取前綴的論點，針對的是**每個請求都改寫**。Jev 只在壓縮事件時才改寫，處境不同，不能直接套用。
- Chisle 的數字提醒：Read 是最大宗（它的語料中超過 8K 字的輸出幾乎都是），排除 Read 的壓縮對整個 session 影響很小。
