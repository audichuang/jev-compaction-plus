# jev-compaction-plus

Claude Code mod（function-hook plugin），fork 自 cth9191/jev-compaction-plus，再併入 orangewk 與 Agreor 兩個 fork 的修正（來源表見 README 開頭）。README 寫給安裝的人；這份寫給改 code 的 agent。

## 改完必跑

- `npx vitest run`、`npm run typecheck`、`npm run validate:plugin`。validator 是 host 載入時的同一套靜態檢查，沒過的話 hook 會靜默載入失敗，`/compact` 直接走內建摘要，連 toast 都沒有。
- 改到 hook 行為要實機驗證：先在 settings 關掉已安裝版（或用 `--settings '{"enabledPlugins":{"jev-compaction-plus@jev-compaction-plus":false}}'`），再 `claude -p "<prompt>" --plugin-dir . --debug-file <檔> < /dev/null`，debug 檔裡要看到 `hooks module jev-compaction-plus@inline loaded`。zsh 不會拆 `${X:+--flag $X}`，多步驟測試用 bash 腳本跑。
- 要讓 Jev 真的出手，session 要夠長：最新 `preserveRecentMessages`（6）則訊息和第一則都受保護，平行呼叫會拆成一個 block 一則訊息。用「一步一個 Read、依序讀 5 個 400 行檔」的寫法最穩。
- resume 驗證：`/compact` 後用新 process `--resume` 問問題，再用 `jq -c 'select(.type=="assistant") | [.message.id, (.message.content|tostring|.[0:200])]' <jsonl> | sort | uniq -c | awk '$1>1'` 檢查有沒有重複（只比 message.id 不準，一個回覆本來就會寫成多行同 id）。

## 不可退回的設計

- `toSessionMessages` 只有「沒有 tool result 的 user 訊息」原封回傳（帶 handle），其他一律重建。帶 handle 回傳會讓 resume 丟歷史（#89/#145）或重複 assistant 訊息（#129）。等 anthropics/claude-code#95328、#99727 修好才可以退回。
- 同一個回覆的平行 call 要重建成一則訊息（`responseStarts` + `sourceIndices`），否則 host 會把結果換成 "Tool result missing"（#137）。
- `keepThreshold` 0.5、`minReductionRatio` 0.25 是實測過的組合。drawer 模式下門檻太高只是多一次讀檔，太低會讓短 session 退回內建摘要（0.2 時實際發生過）。要調先從真實 transcript 的 `decisions:` 行抓 keepResult 分布。
- drawer 預設 `~/.claude/jev-drawer`，不要改回專案相對路徑：專案多半在 Google Drive 同步資料夾裡，`.gitignore` 擋不住同步。

## mod API 的雷

- `$.env.get('NAME')` 參數必須是字面字串。
- plugin.json 的 `userConfig.default` 會被 host 當成 options 傳進來，所以改預設值要同時改 `src/compact.ts` 的 `DEFAULT_OPTIONS` 和 plugin.json，測試只看得到前者。改數字別用全域字串取代（`0.2` 會吃到 `0.25`）。

## 發版

- `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json` 的 `version` 一起升，push 後 `claude plugin marketplace update jev-compaction-plus && claude plugin update jev-compaction-plus@jev-compaction-plus`。
- 參考 remote：`upstream`（cth9191）、`orangewk`、`agreor`。`git log main..orangewk/main` 看 orangewk 有沒有新修正可以搬。
