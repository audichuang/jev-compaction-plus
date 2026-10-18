# jev-compaction-plus

Claude Code mod（function-hook plugin），fork 自 cth9191/jev-compaction-plus，再併入 orangewk 與 Agreor 兩個 fork 的修正（來源表見 README 開頭）。README 寫給安裝的人；這份寫給改 code 的 agent。

## 改完必跑

- 發版前跑 `scripts/replay.mts`（用法在檔頭）重播幾個真實 session：每個的 reduction 都要 ≥ 25%、`unpaired` 輸出側要是 0；`ROUNDS=3` 看多輪，`left` 欄看剩下的是什麼。這也是調門檻的資料來源（`KEEP=0.6` 可換門檻比較）。挑的 session 路徑和輸出含客戶專案名，不要進 repo。
- `npx vitest run`、`npm run typecheck`、`npm run validate:plugin`。validator 是 host 載入時的同一套靜態檢查，沒過的話 hook 會靜默載入失敗，`/compact` 直接走內建摘要，連 toast 都沒有。
- 改到 hook 行為要實機驗證：先在 settings 關掉已安裝版（或用 `--settings '{"enabledPlugins":{"jev-compaction-plus@jev-compaction-plus":false}}'`），再 `claude -p "<prompt>" --plugin-dir . --debug-file <檔> < /dev/null`，debug 檔裡要看到 `hooks module jev-compaction-plus@inline loaded`。zsh 不會拆 `${X:+--flag $X}`，多步驟測試用 bash 腳本跑。
- host 不會把 `isMeta` 列（載入的 skill 內文、teammate 訊息）交給 `session.compact`。重播腳本已排除它們；實測 host 給了什麼，在 hook 裡暫時 `$.ui.log` 一行 `event.messages` 摘要再看 debug 檔。
- `compactAtPercent`（60）在 turn.complete 呼叫 `$.session.compact()`。回合還在跑時 host 會拒（真實紀錄被拒 4 次），但大多會成功：transcript 記成 `manual`，前面沒有 `/compact`，preTokens 落在 1M 的約 60%（17 次）。0.3.1 曾因只看到被拒就把它刪掉，0.3.4 加回來；判斷有沒有作用要看 boundary，不能只看錯誤。Claude Code 原生的自動和閒置壓縮（trigger `auto`）也會經過這個 hook。
- 要讓 Jev 真的出手，session 要夠長：最新 `preserveRecentMessages`（6）則訊息和第一則都受保護，平行呼叫會拆成一個 block 一則訊息。用「一步一個 Read、依序讀 5 個 400 行檔」的寫法最穩。
- resume 驗證：`/compact` 後用新 process `--resume` 問問題，再用 `jq -c 'select(.type=="assistant") | [.message.id, (.message.content|tostring|.[0:200])]' <jsonl> | sort | uniq -c | awk '$1>1'` 檢查有沒有重複（只比 message.id 不準，一個回覆本來就會寫成多行同 id）。

## 不可退回的設計

- `toSessionMessages` 只有「沒有 tool result 的 user 訊息」原封回傳（帶 handle），其他一律重建。帶 handle 回傳會讓 resume 丟歷史（#89/#145）或重複 assistant 訊息（#129）。等 anthropics/claude-code#95328、#99727 修好才可以退回。
- 同一個回覆的平行 call 要重建成一則訊息（`responseStarts` + `sourceIndices`），否則 host 會把結果換成 "Tool result missing"（#137）。
- `keepThreshold` 0.6、`minReductionRatio` 0.25 是用 `scripts/replay.mts` 在 10 個真實 session 上量出來的（有預覽時 keepResult 中位數約 0.45）。drawer 模式下門檻太高只是多一次讀檔，太低會讓 session 退回內建摘要（0.2 時實際發生過）。不要靠降 `minReductionRatio` 解決退回：永遠不是候選的東西會一直累積，下一輪還是退回。
- Jev 丟掉的結果分兩層：keepResult ≥ `POINTER_ONLY_BELOW`（0.25）、錯誤、`Agent`/`Task` 的回傳，留頭尾預覽（`previewChars`）加 drawer 指標；更低的只留指標。每個指標都寫出 INDEX.md。來由：稽核 18 次真實壓縮，模型多半不知道自己丟了什麼，會痛的是只存在 result 裡的結論（PASS/FAIL、「這實驗無效」）。代價是單輪 reduction 少 6–16 點（重播）；預覽縮到 400 字只拿回 1–2 點，不值得。不要改成叫 LLM 逐項摘要：Jev 只回機率不能產文字，中間帶數量多，30 秒做不完（docs/research/compaction-approaches.md）。
- 小結果（< `minDropChars`）不問 Jev，但保護範圍外、非錯誤、≥ 500 字的照規則留 300 字開頭、其餘進 drawer；已經是 drawer 開頭的不再搬。不搬的話每輪都整份留下（真實 session 每輪 30–86 個）。
- Claude Code 會在閒置約 54 分鐘、context 至少 200K 時自動壓縮（trigger 一樣是 `auto`；CHANGELOG v2.1.299，`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` 調門檻、`"idleCompaction": false` 關掉）。離上一輪不久時新內容少，壓縮率會不到 25%（`ROUNDS=3` 重播：6 個 session 有 4 個在第 2、3 輪掉到 25% 以下）。這時若 `$.session.usage()` 的 context 低於 70% 就 `{ skip }`，不要退回 Opus 摘要；讀不到用量或快滿了才退回。
- 大的 tool 輸入欄位（Write content、Bash command、Agent prompt）和系統寫入的 user 文字（skill 內文、task-notification、system-reminder）照規則搬進 drawer，不問 Jev。它們在真實 session 佔一半以上，不搬的話一半的壓縮會退回內建摘要。使用者打的字和 `<pasted_content>` 絕不動。
- drawer 預設 `~/.claude/jev-drawer`，不要改回專案相對路徑：專案多半在 Google Drive 同步資料夾裡，`.gitignore` 擋不住同步。

## mod API 的雷

- `$.env.get('NAME')` 參數必須是字面字串。
- plugin.json 的 `userConfig.default` 會被 host 當成 options 傳進來，所以改預設值要同時改 `src/compact.ts` 的 `DEFAULT_OPTIONS` 和 plugin.json，測試只看得到前者。改數字別用全域字串取代（`0.2` 會吃到 `0.25`）。

## 發版

- `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json` 的 `version` 一起升，push 後 `claude plugin marketplace update jev-compaction-plus && claude plugin update jev-compaction-plus@jev-compaction-plus`。
- 參考 remote：`upstream`（cth9191）、`orangewk`、`agreor`。`git log main..orangewk/main` 看 orangewk 有沒有新修正可以搬。
