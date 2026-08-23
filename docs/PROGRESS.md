# 開發進度

最後更新：2026-08-24

目前狀態：已上線運作中。Worker、D1 與 Discord slash commands 都已部署完成，
MVP 功能之外另有多輪介面與效能修正。

## 部署現況

| 項目 | 值 |
| --- | --- |
| Cloudflare 帳號 | Confirmed Degree |
| Worker | `https://dcmoney.confirmed-degree.workers.dev` |
| Interactions Endpoint | 同上 `+ /interactions` |
| D1 | `dcmoney-us`，位於 ENAM（美東） |
| Discord Application | moneybot |
| Slash commands | global scope，5 個指令 |
| Worker secret | `DISCORD_PUBLIC_KEY` |

帳號是用 Cloudflare 的 temporary account 建立、再 claim 成正式帳號的，因此
與原本的個人帳號並存。Worker 執行時只需要 `DISCORD_PUBLIC_KEY` 與 D1 binding，
不持有任何 Discord bot token。

## 已完成

### MVP

- TypeScript、Cloudflare Workers、D1 與 Vitest 專案基礎，含 migration 與 CI。
- 多帳本資料模型：每個伺服器可建多個帳本，建立者管理成員，所有成員都能修改或
  刪除紀錄且留下稽核紀錄。
- 金額與分帳核心：最小貨幣單位整數、單一付款人、平均或自訂分攤、債務鏈簡化。
- D1 資料服務：帳本、成員、交易、分錄、結算、工作階段、冪等請求與稽核紀錄，
  並保護餘額更新的並行寫入。
- 五個 slash command 與 Interaction 簽章驗證。

### 上線後的修正與增補

- **成員選單只列帳本成員**。原本用 Discord user select，一定列出整個伺服器，
  選到非成員時流程還會照常走到確認步驟，直到寫入才失敗。改為由帳本成員產生的
  string select，付款者、收款者等欄位則改用 autocomplete。
- **成員顯示名稱**。`ledger_members` 新增 `display_name`，加入成員時擷取
  伺服器暱稱、global name 或 username，選單不再顯示一串數字 ID。
- **還款金額可見**。部分還款表單預填目前欠款、`/settle` 的金額提供 autocomplete，
  超額還款的錯誤會講出實際上限，並與「方向相反」分成不同訊息。
- **autocomplete 不再回錯誤型別的回應**。Discord 只接受 type 8，原本的錯誤處理
  一律回 type 4，會被 Discord 視為失敗但 Worker 記錄成成功。
- **公開可見度**。帳本可設為公開，記帳、還款、修改與刪除都會公告到頻道；
  `/expense add`、`/settle`、`/balances` 也各有單次公開的選項。
- **批次加入成員**。`/ledger member add` 不指定 user 時開多選，一次最多 25 位，
  只做一次權限檢查與一次批次寫入，已在帳本內的人會被略過而非讓整批失敗。
- **成員清單與加入通知**。新增 `/ledger member list`；加入成員時在頻道通知並
  提及對方，這是唯一會實際 ping 人的訊息。

## 效能：資料庫位置

D1 原本建在 APAC/HKG，因為它是從台灣用 wrangler 建立的。但實際流量全部來自
Discord 位於美國的伺服器，Worker 因此固定在 ATL 執行。

實測 29 筆請求：SQL 本身只花 0.24ms，整個請求卻要 217–1654ms，時間全部消耗在
跨太平洋往返，每趟約 200ms。最慢的請求已用掉 Discord 3 秒上限的一半以上，
偶爾超時就會顯示載入失敗，而 Worker 端仍記錄為成功，難以察覺。

資料庫重建於 ENAM 並搬移資料後，往返降至約 20ms。

**經驗**：D1 的位置要對齊流量來源，不是開發者的所在地。

## 驗證

2026-08-24：型別檢查通過，Vitest 11 個測試檔、69 個測試全部通過。

## 目前不在範圍內

- 多付款人、百分比分攤或權重分攤。
- 多幣別與匯率換算。
- 自然語言解析、Gateway 常駐連線、定期帳單、收據 OCR、CSV 匯入匯出與網頁後台。
- 私訊通知。Worker 刻意不持有 bot token，因此通知一律發在頻道。

一筆支出最多 25 位分攤成員，一次最多加入 25 位帳本成員，兩者都是 Discord
元件的上限。帳本幣別在建立時固定，內建 TWD、JPY、USD、EUR。

## 已知待辦

- 修改紀錄的表單仍以 Discord user ID 文字輸入，因為 Discord modal 只支援文字欄位。
- 專案沒有 git remote，所有 commit 只存在於本機。
- 舊的 `dcmoney`（HKG）資料庫尚未刪除，確認新資料庫穩定後可移除。

## 相關文件

- [MVP 設計決策](plans/2026-08-18-discord-expense-bot-design.md)
- [部署與開發指引](../README.md)

## 維護方式

每完成一個功能或部署階段，更新「已完成」、「驗證」與「已知待辦」，並附上對應
commit 或驗證日期。
