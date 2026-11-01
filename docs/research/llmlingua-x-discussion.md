# X 上對 LLMLingua 與 coding agent 上下文壓縮的實務討論

調查日期：2026-11-01。貼文內容都當資料看，數字是作者自報，除非另有標註，我沒有重現過。

## 結論

- **X 上找不到任何人把 LLMLingua 接進 coding agent、量過任務結果的第一手回報。** 66 則提及絕大多數是工具清單或轉述 README 的「up to 20x」。非工具作者的使用者回報只有兩則，都沒有數字，一正一負。有數字的第一手量測都來自工具作者（Tamp、grug）。
- **反對把 LLMLingua 用在程式碼的證據，來自 X 引用的研究與競品自測**：一篇 arXiv 論文（patch 套用率 70.7% 對 98.0%，數字來自 X 轉述），以及競品作者測的否定詞遺失率（43%）。
- **壓縮工具的高省量，多半是工具自己計數器上的單次輸出比例**。少數長期使用者的整體數字低得多（RTK 35%、RTK 加 Headroom 約 14%）。第三方配對 A/B 量到 RTK 在 low effort 讓成本上升 7.6%，在 high effort 約持平。
- **丟棄和原文可取回的組合，是近期被引用最多的方向**：CliffCompaction、Mainplane、Codex Astra、pi-optchat、Headroom 的 retrieve 都屬於這類。同時也有直接反例，見主題 5。

## 涵蓋範圍與限制

| 項目 | 數量 |
| --- | --- |
| 查詢變體 | 32 組，31 組成功 |
| 回傳貼文 | 734 則 |
| 去重後 | 655 則 |
| 程式篩選為切題（含 token 等寬鬆關鍵字） | 497 則 |
| 含數字 | 325 則 |
| 含數字且為第一人稱 | 144 則 |
| 提及 LLMLingua | 66 則 |
| 我讀過摘錄 | 約 250 則 |
| 我讀過全文 | 約 30 則 |
| **我判定為第一手且有實測數字** | **24 則** |

- **管道**：`agent-reach twitter search`（X 站內搜尋，未登入操作、未發文），每組最多 25 則。
- **限流**：第 32 組查詢（`"prompt compression" cache "not worth"`）遇到 HTTP 429，頻道暫停約 1 小時，我依 skill 規定沒有等待或換管道。因此**回覆串都沒讀到**，包括負評 DavidOndrej1 那則底下的討論。
- **沒讀的部分**：約 400 則沒有逐則看。篩選靠正規表達式，不含數字又不含負面關鍵字的經驗談可能漏掉。
- **看不到的內容**：貼文裡的截圖（如 `rtk gain` 畫面）和被引用的原推。搜尋排序也偏向高互動貼文，有宣傳偏誤。
- **Fast Apply**：查過 `Fast Apply claude code tokens`，25 則裡只有 1 則真的提到它（laogui [2007037995510350134](https://x.com/i/status/2007037995510350134)，轉述 morph 宣稱的 10,500 tokens/s、98% 準確率），沒有實務回報，其餘都是一般省 token 的貼文。
- **「24 則」的定義**：作者自稱跑過並給出數字。其中多數只有 token 計數，沒有任務成功率的對照。
- **標註 `[非 X]` 的內容**來自公開網頁，不是 X 貼文。

貼文連結格式為 `https://x.com/i/status/<id>`。

## 主題 1：LLMLingua / LLMLingua-2 本身

提及的 66 則大致分成：工具清單或「省 token 的 N 個 repo」（2026 年佔多數）、2023–2024 年的發布轉述、論文引用。Grok 帳號的自動回覆（`grok` 的 3 則）不算證據。

| 作者 | 日期 | 連結 ID | 原文摘錄 | 數字 | 判斷 |
| --- | --- | --- | --- | --- | --- |
| DavidOndrej1 | 2025-09-06 | [1964267502667509980](https://x.com/i/status/1964267502667509980) | "i've tried LLMLingua, but that shit is trash" | 提示 72,400 tokens，沒有壓縮結果 | 第一手、未量測、沒說原因 |
| xpranavprakash | 2024-09-18 | [1836462352482377742](https://x.com/i/status/1836462352482377742) | "We have this integrated in our products at most places." | 無 | 第一手、未量測、用途不明 |
| akshayballal95 | 2026-08-22 | [2091216699836014946](https://x.com/i/status/2091216699836014946) | "LLMLingua-2 dropped 43% of the negations it saw. grug dropped none." | MeetingBank QA 450 題，Sonnet 4.6：全文 F1 0.74；規則版 0.75（62% tokens）；分類器 0.5 為 0.74（54%）；0.33 為 0.69（37%） | 有量測，但作者是競品（grug）；資料是會議問答，不是程式碼 |
| kdpisda | 2026-10-16 | [2110923121255657843](https://x.com/i/status/2110923121255657843) | "LLMLingua-2 kept 17.5% of lines verbatim and 70.7% of its patches applied. Whole files: 98.0%." | 300 個 SWE-rebench issue；選檔法解決 43.7%（GPT-5.6）、46.7%（Opus 5），比最佳壓縮器高 6.3 點 | 轉述論文，非第一手；來源見下 |
| staskulesh | 2026-03-25 | [2036876293799588133](https://x.com/i/status/2036876293799588133) | "LLMLingua-2 neural compression default" | Tamp 加權平均 -32.0%；來源碼 -39.8%；10 輪 -22.6%（樣本 473–6,773 tokens） | 工具作者自測，只量 token，沒量任務結果；「$3,400/year」是推算 |
| chopra_tejas | 2026-03-11 | [2031543876633383055](https://x.com/i/status/2031543876633383055) | "Headroom OSS ( works with LLMLingua-2, but you know is coming?" | 無 | Headroom 作者預告自製模型，算間接訊號：他們想換掉 LLMLingua-2，原因未說 |
| QingQ77 | 2026-05-11 | [2053965372353589481](https://x.com/i/status/2053965372353589481) | "Verbatim（代码和错误不碰）、Lingua（本地 LLMLingua-2 抽取式压缩，零边际成本）" | 宣稱 40–60% | 介紹工具，非實測；設計值得參考：程式碼和錯誤不進 LLMLingua |
| TONGYI_SpeechAI | 2026-08-12 | [2087448630273904713](https://x.com/i/status/2087448630273904713) | "token-level compression (LLMLingua-2) to reasoning steps" | 文字長度降到 40% | 研究團隊貼文，用在推理步驟，不是 tool 輸出 |
| rohanpaul_ai | 2024-04-21 | [1782148352844481012](https://x.com/i/status/1782148352844481012) | "Extremeley useful when you are continuously feeding info to an agent." | 重述 README | 主張，未量測 |

`[非 X]` 來源核對：

- kdpisda 轉述的論文是 [arXiv 2610.21073](https://arxiv.org/abs/2610.21073)，"Skip the Compressor"，2026-10-15。摘要證實 43.7% 和 46.7%，以及「壓縮器改動程式碼文字導致 patch 套不上」的機制。
- 17.5%、70.7%、98.0% 只有 X 轉述，我沒讀到全文。貼文說 UIUC，但取得的 arXiv 頁面沒有列出機構。
- 另一篇 [arXiv 2603.28119](https://arxiv.org/pdf/2603.28119) 的搜尋摘要稱 LLMLingua-2 在 SWE-bench Verified 上壓縮比低於 3 倍。我只看到摘要，未驗證。

## 主題 2：RTK 與工具輸出壓縮：標題數字和整體數字的落差

| 作者 | 日期 | 連結 ID | 原文摘錄 | 數字 | 判斷 |
| --- | --- | --- | --- | --- | --- |
| dirkkok | 2026-04-04 | [2040401687953698871](https://x.com/i/status/2040401687953698871) | "The 99% headline is real for test runners... read commands dominate my workflow, and those only compress about 25%." | 約 20K 指令、省 51M tokens、整體 35% | 第一手、樣本最大、最可信 |
| cip_spiridon | 2026-06-21 | [2068557193880993994](https://x.com/i/status/2068557193880993994) | "Same workload. 351.3M tokens in. 302.3M out." | 24 小時；RTK 省 0.81M；Headroom 省 49.1M；自稱約 15%，換算約 14%；約 $229（未計快取） | 第一手；工具計數，沒有品質對照 |
| usleaderlab | 2026-08-31 | [2094342060870697298](https://x.com/i/status/2094342060870697298) | "debug、git diff、migration、deploy 这类关键操作，反而可能漏掉重要信息" | 部分場景最高 97.1% | 第一手；改成選擇性壓縮，屬部分棄用 |
| fkysly | 2026-03-08 | [2030518029424136367](https://x.com/i/status/2030518029424136367) | "不过只能节省输入 token，而且有信息丢失的问题" | grep 527KB → 102 bytes | 第一手、單次；102 bytes 幾乎肯定丟了內容 |
| 0xMilkRabbit | 2026-05-20 | [2057036554602942507](https://x.com/i/status/2057036554602942507) | "之前每天差不多用 20% 的周额度，现在每天只需 10%" | 一週；省一千多萬 token | 第一手；少數以額度衡量的回報，但沒控制工作量 |
| mretsal | 2026-04-01 | [2039455645393432701](https://x.com/i/status/2039455645393432701) | "74.1% token savings" | 11.2M 中省 8.3M | 第一手；`rtk gain` 自報 |
| dsr_ai | 2026-03-30 | [2038622309871964165](https://x.com/i/status/2038622309871964165) | "73 commands in, it's saved me 1.6M tokens — 98% reduction." | 同左 | 第一手；樣本小 |
| PierceZhang34 | 2026-05-21 | [2057432610654339203](https://x.com/i/status/2057432610654339203) | "用了 415 次命令，节省了 2490 万 Token，节省率 99.6%" | 同左 | 第一手；數字異常高（平均每指令約 6 萬），可信度低 |
| neural_avb、trevin、hqmank | 2026 | [2061345960060707238](https://x.com/i/status/2061345960060707238)、[2047484713556947247](https://x.com/i/status/2047484713556947247)、[2042909900708417696](https://x.com/i/status/2042909900708417696) | "saved 2.5M tokens"、"almost 400M tokens"、"~60% fewer tokens" | 同左 | 第一手；都是自報計數，沒有結果對照 |

反證（X 上的轉述，加 `[非 X]` 核對）：

- ajs6888 [2079208067372294514](https://x.com/i/status/2079208067372294514)：「80 对有效样本里 成本中位数反而 +7.6% 轮次 +13.8%」，並指出「Claude Code 的 Read Grep 不经过 Bash hook RTK 碰不到」。
- ZeroZ_JQ [2079379621607604533](https://x.com/i/status/2079379621607604533) 的讀法是「Token 减少不代表执行轮数减少」。
- `[非 X]` 原文是 [JetBrains 部落格](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)，抓取時回 403，我沒讀到。[TechTimes 報導](https://www.techtimes.com/articles/321223/20260721/rtk-raises-claude-code-costs-low-effort-jetbrains-benchmark-debunks-6090-claim.htm)的搜尋摘要：86 個任務、425 次試驗；low effort 成本 +7.6%（p=0.004）；high effort 約持平；品質不變。這是 RTK 0.43.0 的結果，不適用於其他版本或工具。
- `[非 X]` [Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/) 據搜尋摘要有類似結果。

噪音警告：「30 分鐘 118k → 24k」被 0xverdao、rohit4verse 等反覆當成效果轉貼，這些貼文沒有附自己的量測。JulianGoldieSEO 的 82.9% 自稱是「our test」，但沒有對照結果，又帶行銷語氣，不計入。

## 主題 3：內建 compaction 的成本與失真

| 作者 | 日期 | 連結 ID | 原文摘錄 | 數字 | 判斷 |
| --- | --- | --- | --- | --- | --- |
| Alezander9 | 2026-10-29 | [2115842962521509968](https://x.com/i/status/2115842962521509968) | "the summary is lossy. The exact error message, the file path, the one number you needed is often gone." | 約 400k，Opus 5.5：快取過期 38 s、$1.99；未過期 29 s、$0.17；Mainplane 15 s、$0.10 | 第一手單次；Mainplane 作者；只量恢復成本，沒量後續任務品質 |
| 0xMfox | 2026-10-31 | [2116578686715457587](https://x.com/i/status/2116578686715457587) | "The biggest one squeezed 970K tokens into 31K, and Claude forgot the rest." | 3 個月 5 次、共 $2，都是熱快取 | 第一手 log；「forgot」未量測；實際成本很低，算反證 |
| _avichawla | 2026-08-22 | [2091078211904139377](https://x.com/i/status/2091078211904139377) | "Compacting your agent's context can cut its tokens and still raise costs." | 100K 快取讀約合 10K；壓成 10K 摘要的快取寫 12.5K | 計價推導，非量測，但機制正確；作者也說之後數輪會回本 |
| theo | 2026-09-18 | [2100762304862384257](https://x.com/i/status/2100762304862384257) | "I often see cache write costs go over 60% of my total LLM spend" | 快取寫 >60% | 第一手，觀察值，沒有附資料 |
| guifav | 2026-09-24 | [2103055304686526730](https://x.com/i/status/2103055304686526730) | "cache reads are 78% of the modeled bill" | GLM 5.1、無 compaction | 轉述 CliffCompaction；和 theo 的比重不同，因工作負載與是否壓縮而異 |
| neil_xbt | 2026-10-28 | [2115477189290266950](https://x.com/i/status/2115477189290266950) | "the agent wrote 178K tokens and read 24.4 million." | 111 輪；重讀佔成本 80% | 第一手單次 |
| 0xjoeytw | 2026-03-25 | [2036838097120624676](https://x.com/i/status/2036838097120624676) | "/compact 是止痛藥不是解藥,壓縮反而觸發更多重注入" | 改 5 檔 = 3K、40 檔 = 30K tokens／每則 | 第一手排查；屬 2026-03 版本行為，現況未驗證 |
| ScarletKc | 2026-10-08 | [2108294527362711695](https://x.com/i/status/2108294527362711695) | "清理旧的工具输出也是在改历史，从改动的位置开始缓存全部失效。要清就攒着一次清一批" | 轉述：Qwen 命中率 0% → 96.7%；OpenCode 132 次壓縮實付 $70.51，全走快取讀只需 $8.17 | 自稱讀了 9 個 agent 的原始碼；品質很高但多為轉述，值得整篇讀 |
| dani_avila7 | 2026-01-06 | [2008653214472614369](https://x.com/i/status/2008653214472614369) | "Every time it triggered for me, I lost important context." | 無 | 第一手棄用（關掉 auto-compact），無數字 |
| dotey | 2025-08-27 | [1960748443489505477](https://x.com/i/status/1960748443489505477) | "/compact 可能会损失上下文，我更愿意手动重新整理上下文" | 無 | 第一手棄用；2026-10 改建議設 `/autocompact 300k`，見 [2108669008283402744](https://x.com/i/status/2108669008283402744) |
| iuditg | 2026-07-21 | [2079564117367787701](https://x.com/i/status/2079564117367787701) | "reducing the auto compact to 150k contextual window" | 主觀感受，無對照 | 第一手、未量測 |

`/autocompact` 一波討論的共識是提早壓縮，別等 967K。多則貼文轉述 Anthropic 工程師 Lydia Hallie 的說法（如 xiax0603 [2108897355722604877](https://x.com/i/status/2108897355722604877)），我沒有查原文。閒置壓縮的討論也和本 repo AGENTS.md 記載的 v2.1.299 行為一致，同時有人教怎麼關掉（dani_avila7 [2110878669183082622](https://x.com/i/status/2110878669183082622)）。

## 主題 4：Jev 式丟棄與「截斷勝過摘要」

正方：

- arkyyang [2103114577382904308](https://x.com/i/status/2103114577382904308) 轉述 CliffCompaction（arXiv，2026-09-22）："drops any tool result longer than 500 characters and shrinks each tool call to just its name plus arguments."
  - tool 結果佔 56%、tool 呼叫佔 28%。
  - Terminal-Bench 2.0：Kimi K2.6 在 16K 預算下 61.42%，全上下文 59.16%。
  - SWE-bench Verified：32K 預算與全上下文差約 0.6 點。
  - 成本最多降約 50%。
  - 這是轉述論文、有對照，是本調查中和本 repo 最相關的研究。全文未核對。
- buildoak_ [2033224165944394197](https://x.com/i/status/2033224165944394197)："~80% of context bloat is stale tool results." 280 輪 session：39.6k → 4.7k（88%）。工具作者、單次，沒有成效對照。它的設計（錯誤和近期回合不動、由 Claude 自己決定）值得對照。
- aehyok [2101249966899654725](https://x.com/i/status/2101249966899654725)：「有人 1 秒把 Claude 会话从近 100 万压到 8.6 万。适合去噪，别当官方 compaction 的完整替代。」這是轉述，非第一手。

反方：

- theo [2100762304862384257](https://x.com/i/status/2100762304862384257)："Deleting these things randomly will keep the model from knowing what it's tried and dooms you to end up in 'stupid loops'". 他另外列了：Jev 看不到 reasoning、編輯歷史會造成快取重寫、前沿模型針對內建 compaction 訓練過。全是推論，沒有數字，原推指的實作也沒讀到。

未驗證的主張很多：RoundtableSpace、Supriik_、3three_AI、make_claude 等都是清單或轉述。make_claude 的「约 30%」講的是 jevgrep 一類工具，不是壓縮。**我沒找到任何人報告 Jev 式壓縮在長 session 後的任務成功率或重讀次數。**

## 主題 5：原文保留加按需取回：直接反例也在這裡

正方：

- Mainplane（Alezander9，見主題 3）：不寫摘要，新 session 從完整紀錄檢索。作者數字，沒量品質。
- owengretzinger [2097288108026826964](https://x.com/i/status/2097288108026826964) 追 Codex 實作：notes 工具、`new_context`、`history.search_contents`。"after several compactions, specific decisions and instructions can disappear from the summaries entirely"。有原始碼追蹤，無數字。
- chasen_liao [2114596825290477980](https://x.com/i/status/2114596825290477980) 轉述 pi-optchat：摘要樹加 zoom。作者 A/B 稱原本約 100K 放棄的任務能跑完。轉述，無細節。
- fahdmirza [2073888086808018995](https://x.com/i/status/2073888086808018995)：本機跑 Headroom，看到 retrieve 取回原文，除錯任務在 64K 窗口內用了 40K。第一手、單次。

反方與限制：

- **sermakarevich [2115438632672645153](https://x.com/i/status/2115438632672645153)：「Clearing tool results lost the fact needed at turn 28; compaction kept it and saved 10%.」** 30 個產品、8 種策略、同一張 30 輪票重播。這是和「丟 tool 結果」最直接相反的第一手結果，但只有一張票，細節在連結裡，我沒讀到。
- bei351009016 [2114479754049184212](https://x.com/i/status/2114479754049184212)：「这类功能的插件很多，但是似乎都无法解决可能的重要内容丢失问题。」主張，未量測。
- leonli1994b3 [2105870135936585815](https://x.com/i/status/2105870135936585815)："Direct context recall beats compaction by up to 8x."。來源不明，未量測，而且 recall 本身的失敗模式（檢索不到）沒有提。
- sitinme [2114532458419073105](https://x.com/i/status/2114532458419073105)：Context Mode 專案自估有 hooks 約省 98%，只靠說明文件約省 60%，因為「模型不总听话」。這對所有「靠模型自己去取回」的設計是個警訊。

## 主題 6：其他節省手法的誠實反例

- ReignSwords [2113979625634468087](https://x.com/i/status/2113979625634468087)（caveman）：自造 JSON 23,239 → 2,006 tokens（-91.4%，fail 行全留）；同題回答 2,620 → 528 字。同一則也引用反面：整個 session 約省 5%（BuzzRAG 的算式）；JetBrains 86 任務輸出只省 8.5%（p=0.82 為品質）；規則先吃約 1,160 tokens。這則是少數自己把正反都寫出來的貼文。
- mybitstar [2073702806352007614](https://x.com/i/status/2073702806352007614)：一小時少約 31%；純編碼約 54%、文件約 17%；ultra 模式連必要註解都砍。第一手，沒有對照。
- joganicpe [2074411723096993972](https://x.com/i/status/2074411723096993972)（pxpipe 把文字渲染成 PNG）：帳單 -59–70%，但 12 字元 hex 在 Opus 4.8 上「0/15全错」、誤讀約 7%。轉述，說明壓縮可能以 ID 和 hash 為代價。
- colerepo [2112237172963078599](https://x.com/i/status/2112237172963078599)："same 30 steps/model: $0.10 vs $0.37 four old files caused it." 第一手，說明清理常駐內容的效益可能比壓縮大。
- DeveloperL92487 [2111429254496075797](https://x.com/i/status/2111429254496075797)："Measure → turn on prompt caching → compress → route." 自稱測過 100+ 工具，沒有附數字，只作為看法參考。
- ivanusto [2116725171432370485](https://x.com/i/status/2116725171432370485)：TokenEconomizer「每輪省 6% 到 15%，但預設設定可能讓它倒賠」。這是標題轉貼，內容沒讀到。

## 證據品質總覽

24 則第一手實測的組成：

- **只有 token 計數或單次比例**：多數（RTK 系列、Tamp、wet、caveman、Headroom）。
- **有用量或金額**：0xMilkRabbit（額度）、Alezander9（單次成本）、0xMfox（log）、colerepo（單次）。都沒有控制任務品質。
- **有品質指標**：只有 akshayballal95（F1，競品自測、非程式碼）。sermakarevich 有重播結果，但只有單張票。
- **有對照的任務成功率**：X 上只見於轉述的第三方或論文（JetBrains、CliffCompaction、arXiv 2610.21073），沒有個人實務回報。

## 對本 repo 的含意（我的判斷）

1. **不要用 LLMLingua 處理程式碼或會被 Edit 比對的內容。** patch 套用率的下降是目前最具體的反證；這點只有 X 轉述的數字，採用前要讀論文全文。若要試，只限散文類的 tool 輸出，錯誤訊息和含否定詞的結論比照現有的預覽層保護。
2. **drawer 加預覽的方向和「丟棄加可取回」的趨勢一致**，也回應 theo 的「deleted permanently」批評。但 sermakarevich 的第 28 輪案例和 Context Mode 的「模型不总听话」都指向同一個未驗證風險：模型不一定會回頭讀 drawer。X 上沒人量過這件事，repo 應該自己量讀回率。
3. **別用 reduction 當唯一指標。** RTK 的 A/B 顯示 token 下降可能換來輪次上升。`scripts/replay.mts` 量不到這點，要回答這題得用真實任務比較輪次和成本。
4. **一次批量清理比每輪清理便宜**（ScarletKc、theo、_avichawla 的快取推導）。這和本 repo 只在壓縮時動歷史的做法相符，不需要改。

未查證事項：貼文數字都沒有重現；上面的論文全文、JetBrains 原文、sermakarevich 的完整評測、回覆串都沒讀到。
