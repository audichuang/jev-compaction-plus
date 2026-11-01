# LLMLingua 系列：演算法、執行需求、已發表結果與實測

查證日：2026-11-01。只用一手來源：三篇論文（arXiv 全文）、`microsoft/LLMLingua` 原始碼、官方文件、Hugging Face 模型 metadata、GitHub issues。

原始碼行號都對應 commit `5a4c78a`（main，2026-09-10）：
- `PC` = [`llmlingua/prompt_compressor.py`](https://github.com/microsoft/LLMLingua/blob/5a4c78ae18ab17a98cf997e8259354e546081d64/llmlingua/prompt_compressor.py)
- `U` = [`llmlingua/utils.py`](https://github.com/microsoft/LLMLingua/blob/5a4c78ae18ab17a98cf997e8259354e546081d64/llmlingua/utils.py)

論文：
- **LL1** = LLMLingua，[arXiv 2310.05736](https://arxiv.org/abs/2310.05736)（EMNLP 2023）
- **Long** = LongLLMLingua，[arXiv 2310.06839](https://arxiv.org/abs/2310.06839)（ACL 2024）
- **LL2** = LLMLingua-2，[arXiv 2403.12968v2](https://arxiv.org/abs/2403.12968)（Findings of ACL 2024）

標記：「論文」「程式碼」是來源直接寫的；「實測」是本次在這台跑的（§7），不是已發表結果；「推論」是我從來源推出來的。

用語：τ = 壓縮後長度 / 原長度（保留比例），1/τ 是壓縮倍數（LL1 §3）。程式的 `rate` 就是 τ。

## 1. 演算法

### 1.1 LLMLingua（LL1）：困惑度 + 由粗到細

核心是用小模型算每個 token 的困惑度，丟掉好預測的 token。沒有訓練專用分類器。

1. **切成三段**：instruction、demonstrations（context）、question。instruction 與 question 對壓縮敏感，預設 τ_ins = 0.85、τ_que = 0.9，k = 2，segment 大小 100（LL1 §5.1）。
2. **Budget controller**（LL1 §4.1，Algorithm 1）：
   - τ_dems = (τL − τ_ins·L_ins − τ_que·L_que) / L_dems（式 2）。
   - 算每個 demonstration 的困惑度，由高到低挑，直到超過 k·τ_dems·L_dems。
   - 剩下的額度分給 instruction 與 question：Δτ = (k·τ_dems·L_dems − L̃_D) / (L_ins + L_que)（式 3）。
3. **Iterative Token-level Prompt Compression, ITPC**（LL1 §4.2，Algorithm 2）：切 segment，每段的條件機率以「前面已壓縮的結果」為條件（式 5），依 τ 算該段門檻 γ_j（式 6），困惑度 > γ_j 的 token 留下（式 7）。
4. **Distribution Alignment**（LL1 §4.3）：用 target LLM 產生的資料 fine-tune 小模型。維護者後來的評估是影響只有 1–2 分（[Transparency_FAQ](https://github.com/microsoft/LLMLingua/blob/main/Transparency_FAQ.md)）。

程式碼對應：
- token 分數是逐 token cross entropy，也就是 −log p（`PC:197-204` `get_ppl`）。
- 門檻是排序後第 `int(len·ratio)−1` 個 loss（`PC:1508-1521`）。保留 `loss > threshold`，但只動當前 segment，前後都強制保留（`PC:1426-1428`）。
- 讀碼所得的差異：門檻算在累積的 `past_loss` 上（`PC:1705-1714`），不是論文字面上的單段分布。
- 超過模型長度時裁掉 KV cache 中段，靠 `cache_bos_num=10` 保留開頭（`PC:87`、`PC:1588-1610`）。
- 預設 `iterative_size=200`（`DOCUMENT.md`），重現 LL1 要用 100（FAQ）。

### 1.2 LongLLMLingua（Long）：加上問題感知

它**需要一個 question**，否則直接 assert 失敗（`PC:564-566`）。

1. **粗層 r_k**：不算文件的困惑度，改算「問題在這份文件之後的困惑度」（式 2）：r_k = −(1/N_c) Σ log p(x_i^{que,restrict} | x_k^{doc})。問題後面會接限制句 "We can get the answer to this question in the given documents."（`PC:2032-2045`）。
2. **細層 contrastive perplexity**（式 3）：s_i = perplexity(x_i | x_<i) − perplexity(x_i | x_que, x_<i)，等於條件 PMI（Long Appendix A）。程式碼是 `self_loss − loss > threshold`（`PC:1421`）。實際上要跑兩條序列。
3. **文件重排**（式 4）：依 r_k 排序，對付 lost in the middle。
4. **動態壓縮率**（式 5）：τ_k = clamp((1 − 2·I(r_k)/K′)·δτ + τ_doc, 0, 1)。排名高的文件留更多（`PC:1229-1236`）。
5. **Subsequence recovery**（§4.4，Algorithm 1）：把 LLM 回應裡被壓壞的實體，比對回原文子序列。這是**回應的後處理**（`PC:1751` `recover`）。

重現參數：`rate/ratio=0.55`、`condition_in_question="after_condition"`、`reorder_context="sort"`、`dynamic_context_compression_ratio=0.3` 或 `0.4`、`condition_compare=True`、`context_budget="+100"`（FAQ）。segment 200，小模型 LLaMA-2-7B-Chat（Long §5）。

旁記：`context_budget` 字串會直接進 `eval`（`PC:1201`）。

### 1.3 LLMLingua-2（LL2）：訓練好的 token 分類器

**訓練資料**（LL2 §3、Appendix A）：
- GPT-4-32k 用「只能刪字、不能換序、不能改字、不能加字」的指令壓縮 MeetingBank，不指定壓縮比（Fig. 2/9）。先切成每塊 ≤ 512 token 且結尾是句號（只切塊 2.6x，不切塊 21x，Table 7）。
- 用雙向滑動窗 + spaCy lemma 的模糊比對，把結果對回原文字詞，標 keep/drop（Algorithm 1、Appendix B）。
- 品質過濾：Variation Rate 最高 5% 丟棄、Alignment Gap 最高 10% 丟棄（§3.3）。
- 資料集 5,169 筆、41,746 塊，平均 3,635 → 1,415 token（2.57x，Table 8）。

**模型**（§4.1）：Transformer encoder + 線性分類層，對 `{preserve, discard}` 做 softmax，loss 是 cross entropy。訓練 10 epochs、lr 1e-5、batch 10（§5）。

**推論流程，論文版**（§4.2）：Ñ = τN，留機率最高的 Ñ 個字，維持原順序。

**推論流程，程式碼版**（`PC:727-973`、`PC:2230-2455`）：
1. `force_tokens` 裡多 token 的字串，先用文字取代換成 `[NEW{i}]`（上限 100 個，`PC:788-792`、`PC:112`）。
2. `__chunk_context`：每塊最多 510 token，從尾端往回找 `chunk_end_tokens`（預設 `.`、`\n`）切（`PC:2230-2253`）。
3. 每塊過模型，取 label 1 的 softmax 機率（`PC:2359-2362`）。
4. `__merge_token_to_word`：把 subtoken 併成字。特殊 token 直接略過（`PC:2263`），字的機率預設取 subtoken 平均（`token_to_word="mean"`，`PC:2294-2302`）。
5. 把字機率按 GPT-3.5 tiktoken 的 token 數展開，取百分位 `int(100·reduce_rate+1)` 當門檻（`PC:2399-2409`）。
6. 保留 `word_prob > threshold`（`PC:2414-2417`）。

**論文與程式碼的差異**（程式碼）：門檻在**每一塊內部**各算一次（`PC:2361` 的迴圈內），不是全文一個 top-Ñ，所以資訊密的塊和空洞的塊丟一樣多。論文也有量過這個代價：單篇共用 7x 和 5x 的固定 rate 分數 25.1、27.4；改成語料層共用門檻 29.5、32.2（LL2 Appendix L，Table 12）。不過那是跨樣本的門檻，發行版沒有這個選項。

**可選的 context 層**：每個 context 取字機率平均，再依百分位篩（`PC:850-861`、`PC:2227`）。沒指定時 `context_level_rate=(rate+1)/2`（`PC:826-829`）。

**保留機制與它的邊界**：

| 機制 | 實際行為 | 來源 |
|---|---|---|
| `force_tokens` | 機率設 1.0 | `PC:2269-2270` |
| `force_reserve_digit` | 只把**含數字的 subtoken** 設 1.0，再和同字其他 subtoken 平均，所以不保證整字留下 | `PC:2276-2287` |
| `drop_consecutive` | 連續重複的 force token 只留一個 | `PC:2385-2397`、`PC:2418-2424` |
| `force_context_ids` | 整個 context 不被粗層丟掉 | `PC:857-859` |
| `<llmlingua, rate=, compress=>` 標籤 | 分段指定比例或不壓。**只在 `structured_compress_prompt` 走 LL1 流程**；正則要求內文不含 `<`（`[^<]+`） | `PC:2090` |
| `compress_json` | 每個 key 指定 rate、compress、value_type、pair_remove | `DOCUMENT.md`、`U:123-238` |

**`rate` 的方向**：程式與 README 是「保留比例」。`DOCUMENT.md` 的 `ratio` 說明（「larger values result in fewer retained tokens」）和 `compress_prompt_llmlingua2` docstring（「greater than or equal to 1.0」，`PC:752-754`）都和程式不符。

### 1.4 後繼

- **SecurityLingua**（CoLM 2025）：用同一套後端偵測 jailbreak 意圖，固定門檻 0.5（`PC:2404-2405`、[README](https://github.com/microsoft/LLMLingua/blob/main/README.md)）。不是通用壓縮的改良。論文未讀。
- README News 裡的 MInference、RetrievalAttention、SCBench 是 KV cache 或推論加速，不適用黑箱 API。
- 專案狀態：最後 release v0.2.2（2024-04-09）。最後一次演算法相關 commit 是 2025-10 的 SecurityLingua，2026-09 只有 Actions pin（GitHub API）。
- 我沒找到微軟發表的 LLMLingua-3 或通用後繼（只查 repo 與 README，未全網窮舉）。

## 2. 執行需求

| | LL1 / Long | LL2-small | LL2 |
|---|---|---|---|
| 模型 | 預設 `NousResearch/Llama-2-7b-hf`（`PC:73`）；可換 GPT-2、phi-2 | `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` | `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` |
| 參數 | 7B | 110M（LL2 App. H） | 355M（LL2 App. H） |
| 權重檔 | 未查 | 709 MB（[HF API](https://huggingface.co/api/models/microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank?blobs=true)） | 2.24 GB（[HF API](https://huggingface.co/api/models/microsoft/llmlingua-2-xlm-roberta-large-meetingbank?blobs=true)） |
| GPU 記憶體峰值 | LL1 16.6 GB；Selective-Context 26.5 GB（LL2 App. I） | 未發表 | 2.1 GB（App. I） |
| 訓練時間 | 不需要 | 約 16 小時 | 約 23 小時（App. H） |

- 量化版 `TheBloke/Llama-2-7b-Chat-GPTQ` 需要 < 8 GB GPU 記憶體（README）。維護者說量化版不會比較快，可能略慢（[#64](https://github.com/microsoft/LLMLingua/issues/64)）。
- `device_map` 預設是 `cuda`（`PC:74`），CPU 要明確指定（[#216](https://github.com/microsoft/LLMLingua/issues/216)）。`trust_remote_code` 預設 True（`PC:121`，[#249](https://github.com/microsoft/LLMLingua/issues/249)）。

**已發表延遲，全部在 V100-32G GPU 上；我找不到任何論文發表的 CPU 數字。**

壓縮本身（秒，LL2 Table 5，MeetingBank，平均約 3,003 token）：

| 1/τ | 2x | 3x | 5x |
|---|---|---|---|
| Selective-Context | 15.9 | 15.6 | 15.5 |
| LLMLingua | 2.9 | 2.1 | 1.5 |
| LLMLingua-2 | 0.5 | 0.4 | 0.4 |

- 同一張表的端到端：不壓縮 14.9 s，LL2 2x 9.4 s（1.6x）、3x 7.5 s（2.1x）、5x 5.2 s（2.9x）。維護者補充：target 是 GPT-3.5-Turbo-0613、算到回應完整結束、`max_token=400`（[#193](https://github.com/microsoft/LLMLingua/issues/193)）。
- LL1 在 GSM8K（LL1 Table 6）壓縮 0.8 / 0.3 / 0.2 s（2x / 5x / 10x），端到端 8.6 → 4.9 / 2.3 / 1.3 s。
- Long 只發表端到端，且計算量是 LL1 的兩倍（Long Limitation）。LongBench 2,000 token 下 6.1 s（2.6x），原文 15.6 s（Table 2）。
- 維護者建議用 V100 等級 GPU（[#147](https://github.com/microsoft/LLMLingua/issues/147)）。對 100k token 兩秒內壓完的問題，只回「沒測過，加大 batch 或許可行」（[#175](https://github.com/microsoft/LLMLingua/issues/175)）。

**本機實測的 CPU 數字見 §7.3。**

**ONNX 與 JS/TS**（都是第三方，微軟沒有發布）：
- JS/TS：[`atjsh/llmlingua-2-js`](https://github.com/atjsh/llmlingua-2-js)，npm `@atjsh/llmlingua-2` 3.0.0（2026-08），README 標 Experimental。peer dependencies 是 `@huggingface/transformers ^4.2.0`、`js-tiktoken`。支援 Node CPU、WebGPU、CUDA、DML。README 列的 ONNX 大小：TinyBERT 57.1 MB、MobileBERT 99.2 MB、BERT 710 MB、XLM-RoBERTa 2,240 MB。**我沒有跑過**；TinyBERT、MobileBERT 的訓練方式與準確度沒有已發表數字可對照（未驗證）。
- ONNX：`ldenoue/llmlingua-2-bert-base-multilingual-cased-meetingbank` 有 `onnx/model.onnx` 709 MB、`onnx/model_quantized.onnx` 179 MB（HF API 確認檔案存在，未跑）。`Arcoldd/llmlingua4j-bert-base-onnx`（atjsh README 所列）、`aablsk-chaptr/llmlingua-2-xlm-roberta-large-meetingbank-onnx`（HF 搜尋結果）的檔案清單未驗證。
- 微軟 repo 的 issue 裡搜 `onnx` 與 `javascript` 都是 0 筆。

## 3. 已發表結果

指標都是越高越好。除非另註，target 是 GPT-3.5-Turbo。

### LL2（Tables 1–4、10）

| 資料集 | 指標 | 原文 | LL2（倍數） | 備註 |
|---|---|---|---|---|
| MeetingBank QA（訓練領域內） | EM | 87.75 | 86.92（3.1x） | small：85.82（3.0x）；LL1：67.52（2.5x） |
| MeetingBank 摘要 | Rouge1 | 47.28 | 48.64（3.1x） | |
| LongBench AVG | | 44.0 | 42.4（3x）/ 39.1（5x） | Long：48.8 / 48.0 |
| LongBench SingleDoc | | 39.7 | 35.5（3x）/ 29.8（5x） | |
| LongBench Synth. | | 37.8 | 21.4（3x）/ 21.3（5x） | 掉最多 |
| LongBench **Code** | | 54.2 | 62.8（3x）/ 58.9（5x） | **高於原文** |
| ZeroSCROLLS AVG | | 34.7 | 33.5（3x）/ 33.4（5x） | zero-shot 10.8 |
| GSM8K | EM | 78.85 | 79.08（5x）/ 77.79（14x） | |
| BBH | EM | 70.07 | 70.02（3x）/ 61.94（5x） | |
| **LongBench-Zh AVG** | | **42.5** | **38.1（5x）** | LL1：28.6 |
| Mistral-7B，MeetingBank QA | EM | 66.95 | 76.22（3.0x） | 長文超出它的能力時，壓縮反而加分 |

- LongBench Code 指標是編輯距離相似度，用 `fuzzywuzzy.ratio`；有人指出它不是真正的 Levenshtein（[#207](https://github.com/microsoft/LLMLingua/issues/207)）。任務是**補下一行程式**，不是查識別字。
- GPT-4 直接抽取式壓縮在 MeetingBank QA 只有 84.86（2.5x），低於 LL2（Table 9）。
- 訓練資料加 50k TriviaQA-wiki，AVG 只從 39.1 到 39.5（Table 6）。

### LL1（Tables 1–5）

| 資料集 | 全文 / 基準 | LL1 |
|---|---|---|
| GSM8K EM | 78.85 | 79.08（5x）、77.41（14x）、77.33（20x） |
| BBH EM | 70.07 | 70.11（3x）、61.60（5x）、56.85（7x） |
| ShareGPT BERTScore F1（參考答案是 GPT-3.5 自己的回覆） | | 89.52（1.9x）、87.70（3.3x） |
| Arxiv-March23 BERTScore F1 | | 90.33（4x）、89.03（9x） |

- 論文結論原文：「up to 20x compression with only a 1.5 point performance drop」，**這只是 GSM8K**。同表 BBH 7x 就掉 13.2 分。
- 崩潰點：「a notable performance drop ... excessively high compression ratios such as 25x-30x on GSM8K」（LL1 Limitations，Fig. 3）。
- 消融（GSM8K，5x）：不做迭代 72.93、不用 budget controller 73.62、完整 79.08；只移除 stop words 76.27 且只有 1.3x（Table 3）。

### Long（Tables 1–2，NaturalQuestions 20 documents）

- 原文 54.1–75.7（依答案位置）；Long 在 2x 70.5–77.2、4x 71.2–75.0。
- 論文 §5 寫答案在第 10 位時提升 21.4%、token 約少 4x。Table 1 對應的是原文 54.1 → 4x 的 Long 71.2（+17.1 分，相對 +31.6%），**我對不回 21.4 這個數字**（未驗證）。**答案在第 1 位時 75.7 → 75.0，沒有提升**。
- 無問題感知的 LL1 在同任務 4x 只有 23.5–30.0，低於 zero-shot 56.1（Table 1），也就是**純困惑度壓縮在「大量無關內容 + 一個問題」的任務上比不給 context 還差**。LL2 的 4x 是 39.9–48.6（LL2 Table 11），也低於 56.1。
- LongBench：48.8（3x）、48.3（6x），原文 44.0（Table 2）。LL2 Table 2 引用 2,000 token 時寫 48.0，對應 Long Table 4 不做重排的變體。
- 成本：LooGLE 少 94.0%（Long Table 9）。

### 退化規律（推論，出自上表）

- 問題和答案有明確落點、或內容冗餘（few-shot、CoT）的任務，5x 仍接近原文。
- 依賴**長文細節**的任務（SingleDoc、Synth.、BBH 追蹤物件）在 3x–5x 就明顯掉分。
- 任務無關的方法面對「多數內容無關」時，比 retrieval 差很多。
- LL2 Fig. 15 有 MeetingBank QA 與摘要對壓縮比的曲線，只有圖、沒有數字表（未抄值）。

## 4. 語言、程式碼、結構化內容

### 來源怎麼說

- **中文**：LL2 訓練資料只有英文。LongBench-Zh（5x）LL2 AVG 38.1、LL1 28.6、原文 42.5；SingleDoc 46.7 vs 61.2、MultiDoc 23.0 vs 28.7、Summ. 15.3 vs 16.0、Synth. 72.6 vs 77.5、FewShot 32.8 vs 29.2（Table 10）。論文歸因於 encoder 預訓練的多語能力（Appendix J）。**沒有繁體、日文、韓文的評測**。
- **LL1 + CJK**：輸出亂碼是已知問題，至今仍開著。維護者說是 tokenizer 解碼 Unicode 的 bug，且「因人力限制暫時無法修」（[#4](https://github.com/microsoft/LLMLingua/issues/4)）；日文同樣（[#63](https://github.com/microsoft/LLMLingua/issues/63)）；token 級壓縮會造成亂碼，建議改用 LL2（[#152](https://github.com/microsoft/LLMLingua/issues/152)）。
- **LL2 + 中文**：字之間多出空格，開放未修（[#131](https://github.com/microsoft/LLMLingua/issues/131)）。
- **JSON、XML、Markdown**：一般壓縮會破壞格式（[#50](https://github.com/microsoft/LLMLingua/issues/50)）。維護者稱只支援 JSON（走 `compress_json`），不支援保留 Markdown（[#202](https://github.com/microsoft/LLMLingua/issues/202)）。`compress_json` 搭 LL2 有 ZeroDivisionError 回報（[#183](https://github.com/microsoft/LLMLingua/issues/183)，未驗證）。
- **程式碼**：只有 LongBench 的補行任務（§3）。Long 的案例顯示壓縮後的程式已被切碎，如 `.("",.getStart`（Long Fig. 8）。
- **Logs、檔案路徑、stack trace**：三篇論文**沒有評測**（全文搜尋與資料集清單）。

### 程式碼實際行為

- **mBERT**：BERT tokenizer 把每個 CJK 字切成獨立 token，每字一個「字」，沒有 `##`（`U:81-89`；實測見下）。輸出用 `convert_tokens_to_string` 重組，字之間是空格（`PC:2430`），這就是 #131。
- **XLM-RoBERTa**：`is_begin_of_new_word` 只認 `▁` 或 ASCII `string.punctuation`（`U:90-99`）。中文沒有空白，所以 **ASCII 標點之間的整段 CJK 會合成一個「字」**，再用平均機率一起留或一起丟（推論，實測相符）。tokenizer 會把全形逗號正規化成 ASCII `,`，所以逗號算邊界；`。` 維持全形，不算邊界（實測 tokenize 輸出）。
- **路徑、識別字**：兩個 tokenizer 都會切開。BERT 把標點獨立成字，所以 `/`、`.`、`:` 各自被評分，且重組時被空格拆開。實測 tokenize 結果：`/Users/dev/src/compact.ts:142` → `/ User ##s / de ##v / s ##rc / compact . t ##s : 142`。
- **未知字元**（讀碼，未實測）：BERT 的 `[UNK]` 屬於 special token，會被 `PC:2263` 直接略過而消失，`force_tokens` 救不回來。
- **`word_label` / `return_word_label`**：只是回傳逐字的 0/1 標註（`PC:962-972`），不影響壓縮。`rate=1` 的路徑另用正則分詞（`PC:2314-2317`），那個正則對連續 CJK 只算一個字。
- 特殊 token bug：`TokenClfDataset` 沒傳 `model_name`（`PC:2164-2166`、`PC:2342-2344`），所以 XLM 模型也拿到 `[CLS]`、`[SEP]`、`[PAD]`（`U:19`、`U:26-31`；[#181](https://github.com/microsoft/LLMLingua/issues/181)，未修）。**發表分數是否受影響未知**。

## 5. 多輪對話與 agent context

- **有測的只有一個對話資料集**：LL1 的 ShareGPT。575 筆，「all dialogues except the final round as the prompt」，以 GPT-3.5 的回覆為參考，指標是與參考的相似度（LL1 Appendix A.1）。平均壓縮後才 304 token（1.9x，Table 1），也就是原本約 580 token，**遠短於 agent session**。
- **FAQ**：LL1 與多數 Long 實驗用 completion mode，「chat mode tends to be more sensitive to token-level compression」。這條直接影響現行的 chat 型 API。
- **Long** 只在引言提到 Multi-turn Agent 是 prompt 變長的原因，未評測（Long §1）。**LL2 全文沒有 conversation、dialog、agent、chat 這些字**（`grep`）。三篇都沒有 tool call、tool result。
- **對話的做法**：維護者建議把每輪分成不同 context 啟用粗層；用 `<llmlingua, compress=False>` 保護 speaker（README 範例）；或把 speaker 先抽掉，用 `keep_split` 留分隔再補回（[#68](https://github.com/microsoft/LLMLingua/issues/68)）。#68 的使用者回報壓成 τ = 0.1–0.15 後輸出偏離明顯，且懷疑要跨段彙整的任務不適合（維護者不同意）。
- **Agent**：有人把它接進 AutoGen compressible agent，「too slow on my mac book with llama2」。維護者同意 agent 場景適合，但「there might be new issues」（[#28](https://github.com/microsoft/LLMLingua/issues/28)）。**沒有來源評測過 agent transcript 壓縮後能否繼續工作**。

## 6. 已知限制與 open issues

**論文自述**：
- LL1：25x–30x 崩潰；小模型與 target tokenizer 不同會造成長度低估（Limitations）。FAQ：prompt 已很短時表現不好。
- Long：問題感知導致換問題就要重壓、無法快取；計算量加倍；context 與問題關係微妙時可能失效（Limitation）。
- LL2：資料只來自 MeetingBank（Limitations）。

**一個論文沒講的問題**（我讀圖的觀察）：LL2 宣稱 GPT-4 能重建原文，所以「no essential information loss」（§5）。但它的 Fig. 7 範例中，原文「We're in 28 counties」被重建成「20 out of 28 counties」，「hero program ... three and a half years」被重建成「I have been with the program for three and a half years」。**重建出來的句子通順，但事實被改了**。

**Issues**（全部一次性查詢；repo 的 `open_issues_count` 是 125，含 PR）：

| Issue | 狀態 | 內容 |
|---|---|---|
| [#4](https://github.com/microsoft/LLMLingua/issues/4)、[#63](https://github.com/microsoft/LLMLingua/issues/63)、[#152](https://github.com/microsoft/LLMLingua/issues/152) | open | LL1 的 CJK 亂碼 |
| [#131](https://github.com/microsoft/LLMLingua/issues/131) | open | LL2 中文多空格 |
| [#50](https://github.com/microsoft/LLMLingua/issues/50)、[#202](https://github.com/microsoft/LLMLingua/issues/202) | open | JSON/XML/Markdown 結構 |
| [#181](https://github.com/microsoft/LLMLingua/issues/181) | open | LL2 用錯特殊 token |
| [#147](https://github.com/microsoft/LLMLingua/issues/147)、[#64](https://github.com/microsoft/LLMLingua/issues/64)、[#175](https://github.com/microsoft/LLMLingua/issues/175)、[#79](https://github.com/microsoft/LLMLingua/issues/79) | open | 記憶體、速度、CPU OOM |
| [#104](https://github.com/microsoft/LLMLingua/issues/104) | closed | 法文文本丟失關鍵資訊（「à comp duvier 20.」），維護者承認，歸因於 GPT-2 |
| [#3](https://github.com/microsoft/LLMLingua/issues/3) | open | 整本書；Space demo 在 24.7k token 失敗 |
| [#155](https://github.com/microsoft/LLMLingua/issues/155)、[#146](https://github.com/microsoft/LLMLingua/issues/146)、[#136](https://github.com/microsoft/LLMLingua/issues/136)、[#22](https://github.com/microsoft/LLMLingua/issues/22) | open | 重現論文數字的問題（標題與搜尋結果，內文未逐一讀） |

## 7. 本次實測（非已發表）

### 7.1 條件

- Apple M4 Pro、48 GB、`llmlingua==0.2.2`（pip）、`transformers 4.49.0`、`torch 2.15.0`、`rate=0.5`，另測 `force_tokens=["\n"], force_reserve_digit=True`。
- pip 版與 main 的差異是 SecurityLingua、TinyBERT/MobileBERT 判斷，LL2 主流程相同（`diff`）。
- 樣本是我寫的 7 段短文（91–213 token），不含真實 session；只看結構與字面保留，**沒有測下游 LLM 的答題品質**。token 數用程式內建的 GPT-3.5 tiktoken。

### 7.2 保留情況

| 樣本 | mBERT（實際 τ） | XLM（實際 τ） |
|---|---|---|
| 繁中段落 | 71.4%，字間全是空格。去掉 CJK 間空格後約 50%（同段較短版本 τ=0.5 時 121→90 token）；丟了「沒有」 | 42.3%，開頭整段不見，**結論句「這個實驗無效」被丟**，保留「沒有」 |
| 日文 | 61.5%，字間空格 | **7.7%，只剩 `%に戻りました。`** |
| 中英混合工具結果 | 59.7%：`src compact. ts`、`0. 25`，**`FAIL` 消失** | 41.7%：`src/compact.ts`、`0.25`、`FAIL` 都在；`tests/compact.test.ts:142` 變 `tests/compact:142` |
| TypeScript | `keepResult ( score number opts ...`，`0. 25` 被拆 | `keepResult(score opts boolean >= opts.keepThreshold ...` |
| JSON | 無效 JSON；路徑變 `Users / dev / ...` | 無效 JSON；路徑變 `/Users/dev/project/src/compact`（副檔名沒了） |
| Log | `10 17 5432`（IP 壞了） | `10.0.4.17:5432` 完整，但 `ECONNREFUSED` 消失、時間戳剩 `.113Z` |
| 英文段落 | **`cannot` 消失** | **`cannot` 消失**；`invalid` 都留下 |

重點：
- **否定詞**：英文原句「the numbers cannot be compared with production」，兩個模型的輸出都變成近似「numbers (compared) production」。
- **XLM 的 CJK 粒度壞了**：同一段繁中，`rate=0.7` 與 `rate=0.5` 輸出完全相同（82 token），`rate=0.33` 跳到 39 token 且丟掉結論。這符合 §4 的「標點之間整段算一個字」。
- **mBERT 的 CJK 粒度正常但代價高**：`rate=0.7/0.5/0.33` → 去空格後 123/90/60 token（原 171）。例：`實驗無效測試開啟快取數字不比正式環境`，原文是「測試環境**沒有**開啟快取」，**語意相反**。
- `force_reserve_digit` 在中英混合與 JSON 樣本上沒有改善路徑與識別字完整度。
- 沒有 `force_tokens=["\n"]` 時，所有換行都消失（log、程式碼被壓成一行）。

### 7.3 速度與記憶體（CPU，已快取模型）

| 模型 | 匯入 + 載入 | RSS 峰值 | 20k token（10 執行緒） | 100k token（10 執行緒） | 100k（1 執行緒） |
|---|---|---|---|---|---|
| mBERT | 1.6 + 1.0 s | 2.78 GB | 1.5–3.1 s（6.4k–13k tok/s） | 9.84 s | 20.75 s（20k：4.12 s） |
| XLM | 1.8 + 1.2 s | 4.52 GB | 3.0–8.0 s（2.5k–6.7k tok/s） | 30.85 s | 未測 |

- 內容差異：同模型下 code 最慢、中文最快（20k，mBERT CPU：英文 2.1 s、中文 1.5 s、code 3.1 s、log 2.6 s）。
- mBERT 在 MPS 上 20k：0.6–2.0 s。XLM 未測 MPS。
- 文字是重複內容，只代表模型前向與分塊的成本。

## 8. 對 jev-compaction-plus 的含意（推論）

1. **直接替換 Jev 的丟棄決策不成立**。專案已知會痛的是 PASS/FAIL 與「這實驗無效」這類結論（`AGENTS.md`），而 LLMLingua 的保留偏好是名詞、形容詞、數字（LL2 Appendix N），實測也會掉否定詞、`FAIL`、錯誤碼，且只保留「看起來重要的字」。
2. **來源支持度**：好的數字都來自「冗餘內容 + 單一問題」。agent transcript（tool result、路徑、log、繁中）**完全沒被評測**，FAQ 又說 chat mode 更敏感。要用就得自己用 `scripts/replay.mts` 之類的工具量。
3. **唯一看來可行的位置**：當作 drawer 預覽的壓縮器，原文留在 drawer、可讀回，就不用賭字面完整。但這點只是假說，且 CJK 要用 mBERT 並自行去空格，XLM 在 CJK 上不可用。
4. **部署代價**：官方路徑是 Python + torch，2.8 GB RSS。TS 路徑只有第三方、實驗性的 `@atjsh/llmlingua-2`，要 Transformers.js 與至少 179 MB–710 MB 的 mBERT ONNX（量化版輸出是否等價未驗證）。
5. **速度不是主要障礙**：mBERT 在這台 CPU 上 100k token 約 10 s。1M context 的 60%（600k）線性外推約 60 s；若仍受 Jev 的 30 秒時限（`docs/research/compaction-approaches.md`）約束，需要只壓部分內容。

## 未驗證清單

- Long 摘要與 README 的「21.4%」對不回 Table 1。
- TinyBERT、MobileBERT 的準確度，以及 atjsh port 的輸出是否和 Python 版一致。
- `Arcoldd/...`、`aablsk-chaptr/...` ONNX 的實際內容。
- LL2 Table 5 的確切 prompt 長度：#193 只指向 MeetingBank 摘要任務；「約 3,003 token」是我用 Table 1 平均值帶入。
- #181 對發表分數的影響；#183 是否可重現。
- `[UNK]` 被略過只是讀碼，未跑案例。
- LLMLingua 對現行 Claude 模型的效果：論文只測到 Claude-v1.3（LL1 Table 4，GSM8K 83.51，5x）。
- SecurityLingua 論文、MInference 等未讀。
- 第三方宣稱（`gladehq/claude-shorthand` 的「up to 60%」、`jia-gao/leanctx`、`thom-heinrich/chonkify` 的比較數字）只看到 README 或 repo 描述，都未驗證，也不算一手來源。
