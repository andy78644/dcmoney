# 開發進度

最後更新：2026-08-19

目前狀態：MVP 功能已完成實作並通過本機驗證；尚待設定 Cloudflare 與 Discord 憑證後部署。

## 已完成

- 建立 TypeScript、Cloudflare Workers、D1 與 Vitest 專案基礎，包含 D1 migration 與 GitHub Actions CI。
- 建立多帳本資料模型：每個 Discord 伺服器可建立多個帳本，帳本建立者管理成員；所有帳本成員均可修改或刪除紀錄，且操作會留下稽核紀錄。
- 建立金額與分帳核心：使用最小貨幣單位的安全整數、單一付款人、平均或自訂精確分攤，以及債務鏈簡化。
- 建立 D1 資料服務：帳本、成員、交易、分錄、結算、互動工作階段、冪等請求與稽核紀錄；也保護餘額更新的並行寫入。
- 完成 Discord slash commands：

  - `/ledger`：建立、列出帳本，以及新增／移除成員。
  - `/expense add`：以選單與 Modal 引導輸入付款人、參與者、金額、分攤方式與說明。
  - `/expenses`：依帳本、日期與付款人查詢明細，可檢視、編輯與刪除。
  - `/balances`：列出經債務簡化後的未結清餘額，支援成員篩選與歷史截止日查詢。
  - `/settle`：支援全額或部分結算。

- 實作 Discord Interaction 簽章驗證、指令註冊腳本與本機／遠端 D1 migration 指令。

## 最近驗證結果

2026-08-19 已執行 `npm run verify`：

- TypeScript 型別產生與型別檢查通過。
- Vitest：8 個測試檔、46 個測試全部通過。
- Cloudflare Workers 生產環境 dry-run bundle 通過：114.53 KiB（gzip 21.18 KiB）。
- `npm audit --audit-level=high`：0 個高嚴重度以上弱點。

## 尚待部署

1. 建立 Cloudflare D1 資料庫，並把 `wrangler.jsonc` 中的預留 database ID 換成實際值。
2. 執行遠端 D1 migration。
3. 設定 Worker secret `DISCORD_PUBLIC_KEY`，然後部署 Worker。
4. 將 Discord Application 的 Interaction Endpoint URL 指向 Worker 網址。
5. 使用 Discord application ID、bot token 與測試 guild ID 註冊 slash commands，再將應用程式安裝到伺服器。

完整操作步驟請見 [README](../README.md)。

## 目前不在 MVP 範圍

- 多付款人、百分比分攤或權重分攤。
- 多幣別與匯率換算。
- 自然語言聊天解析、Gateway 常駐連線、定期帳單、收據 OCR、CSV 匯入匯出與網頁後台。

目前互動式新增支出最多支援 10 位參與者；帳本幣別在建立時固定，內建 TWD、JPY、USD、EUR。

## 相關文件

- [MVP 設計決策](plans/2026-08-18-discord-expense-bot-design.md)
- [部署與開發指引](../README.md)

## 維護方式

每完成一個功能或部署階段，更新本文件的「已完成」、「最近驗證結果」與「尚待部署」，並附上對應 commit 或驗證日期。
