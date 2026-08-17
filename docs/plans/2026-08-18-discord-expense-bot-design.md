# Discord 多人記帳 Bot — MVP 設計

- 狀態：已確認
- 日期：2026-08-18
- 預期用途：個人、小型朋友群組與家庭的 Discord 多人記帳

## 1. 目標

建立一個以 Discord Slash Commands 操作的多人記帳 Bot。使用者可以在同一個 Discord 伺服器內建立多個獨立帳本、記錄一人付款後由多人分攤的支出、查詢歷史紀錄、記錄部分或全部還款，並取得跨成員簡化後的最終欠款狀態。

成功標準：

1. 一筆支出能準確表達付款者、分攤者及每人的分攤金額。
2. 所有帳本成員都能新增、修改及刪除帳目，且變更可追查。
3. 歷史紀錄可依帳本、成員、日期與類型篩選。
4. 系統可把鏈狀或循環債務轉換成較精簡的還款建議，但不改動原始紀錄。
5. 重複送出、多人同時修改及金額小數誤差不會破壞帳務一致性。

## 2. MVP 範圍

### 包含

- 一個 Discord 伺服器可建立多個帳本。
- 每個帳本使用單一幣別。
- 帳本建立者管理成員。
- 所有帳本成員都能新增、修改及軟刪除帳目。
- 單一付款者、多人平均分攤。
- 單一付款者、多人指定金額分攤。
- 付款者可以同時是分攤者。
- 部分還款及全部結清。
- 原始支出／還款列表及篩選。
- 截至指定日期的簡化欠款結果。
- 操作與修改稽核紀錄。

### 暫不包含

- 多人共同付款。
- 百分比或權重分攤。
- 同一帳本多幣別及匯率換算。
- 自動讀取一般聊天訊息。
- 週期性支出、提醒通知、收據 OCR 或 Web 管理介面。
- 帳本成員以外的臨時參與者。

## 3. 技術架構

- 語言：TypeScript。
- 執行環境：Cloudflare Workers。
- 互動方式：Discord HTTP Interactions，不建立常駐 Gateway WebSocket。
- 資料庫：Cloudflare D1。
- 部署工具：Wrangler。
- 測試：核心領域邏輯使用快速單元測試；Worker 路由與 D1 使用整合測試。

Discord 將 Slash Command、按鈕、選單及表單事件送到 Worker 的公開 endpoint。Worker 先驗證 Discord request signature，再將請求交給 command handler。Command handler 只負責輸入與顯示，實際帳務規則放在獨立 service，資料存取則透過 repository 封裝。這讓日後若需要改成常駐 Bot 或 PostgreSQL，可以重用帳務核心。

```text
Discord Interaction
        |
        v
Signature verification -> Command / Component handlers
                                  |
                                  v
                         Ledger domain services
                                  |
                                  v
                           D1 repositories
```

正式環境和預覽／測試環境使用不同的 D1 database 與 Discord application secrets。

## 4. 權限模型

- 帳本隸屬於建立它的 Discord guild。
- 建立者自動成為帳本 owner 與第一位成員。
- 只有 owner 能加入或移除帳本成員。
- 只有帳本成員能查看帳本內容。
- 所有帳本成員均能新增、修改及刪除該帳本內的支出與還款。
- owner 不可被移除；未來若要轉移 owner，需另外設計明確流程。
- 帳本成員的 Discord user ID 是身份依據，顯示名稱只作畫面呈現，不作關聯鍵。
- 修改與刪除不覆蓋稽核資訊；每次操作記錄操作者、時間及修改前後內容。

所有查詢結果及操作表單預設使用 ephemeral response，避免非帳本成員從公開頻道看到帳務。完成後可由使用者選擇將不含操作控制項的摘要分享至目前頻道。

## 5. 資料模型

建議的主要資料表：

### `ledgers`

- `id`
- `guild_id`
- `name`
- `currency_code`
- `currency_scale`
- `owner_user_id`
- `created_at`
- `archived_at`
- 同一 guild 內的有效帳本名稱不可重複。

### `ledger_members`

- `ledger_id`
- `user_id`
- `added_by`
- `created_at`
- 主鍵為 `(ledger_id, user_id)`。

### `transactions`

- `id`
- `ledger_id`
- `type`：`expense` 或 `settlement`
- `description`
- `total_amount_minor`
- `occurred_on`
- `created_by`
- `created_at`
- `updated_by`
- `updated_at`
- `revision`
- `deleted_at`
- `deleted_by`

所有金額均以最小貨幣單位的整數儲存。例如 TWD 100 儲存為 `100`，USD 10.25 儲存為 `1025`。`currency_scale` 在建立帳本時依幣別固定，第一版不允許建立交易後更改帳本幣別。

### `postings`

- `id`
- `transaction_id`
- `user_id`
- `amount_minor`

每筆交易的 postings 加總必須為零。正數表示該成員淨應收增加，負數表示淨應付增加。

### `transaction_audits`

- `id`
- `transaction_id`
- `action`：`create`、`update` 或 `delete`
- `actor_user_id`
- `before_snapshot`
- `after_snapshot`
- `created_at`

### `interaction_receipts`

- `interaction_id`（唯一）
- `operation`
- `created_at`

用 Discord interaction ID 保證寫入操作的冪等性，避免網路重送造成重複入帳。

## 6. 帳務規則

### 支出

一筆總額為 `T` 的支出，付款者先取得 `+T` posting，每位參與者再取得其分攤額的負 posting。付款者若也是參與者，兩筆 posting 可在顯示或查詢時合併。

例：Andy 支付 TWD 900，Andy、A、B 平分：

- Andy：`+900 - 300 = +600`
- A：`-300`
- B：`-300`

### 平均分攤與餘數

以整數除法計算基本分攤額，剩餘的最小貨幣單位依使用者選取順序分配，直到總額完全分配。預覽必須顯示最終數字。例如 TWD 100 由三人平分會得到 34、33、33。

### 指定金額

每位參與者的指定金額必須大於零，且合計必須完全等於支出總額。第一版不接受負數、零、公式或百分比。

### 還款

若 A 向 B 支付 `X`：

- A：`+X`，減少自己的應付。
- B：`-X`，減少自己的應收。

由 `/balances` 提供的部分還款或全部結清操作，會在送出前重新計算最新結果；金額不得超過當下 A 對 B 的建議還款額。若其他成員已修改帳目導致建議改變，操作中止並要求重新載入。

## 7. 債務簡化

`/balances` 對指定帳本、截至指定日期的所有有效 postings 按成員加總：

1. 淨額大於零者列為債權人。
2. 淨額小於零者列為債務人。
3. 兩組依金額絕對值由大到小排序；金額相同時以 Discord user ID 排序，確保結果可重現。
4. 每次取最大的債務人與債權人，建立金額為兩者較小餘額的還款建議。
5. 扣除已配對金額，直到所有淨額歸零。

這個流程保留每人的淨應收／應付，最多產生「非零餘額成員數減一」筆建議。它會產生穩定且精簡的結果，但不宣稱在所有組合下都能得到數學上最少的轉帳筆數。

例如 A 欠 B 100、B 欠 C 100，淨額是 A `-100`、B `0`、C `+100`，結果顯示 A 應付 C 100。原始兩筆交易仍保留在 `/expenses`。

成員 filter 只影響顯示：系統必須先用全帳本資料完成簡化，再顯示涉及該成員的建議，不能先排除其他成員的交易。

## 8. Discord 指令與操作流程

### 帳本

- `/ledger create`：輸入名稱與幣別，建立帳本。
- `/ledger list`：列出使用者在目前 guild 可存取的帳本。
- `/ledger member add`：owner 加入一位 Discord 成員。
- `/ledger member remove`：owner 移除一位成員。

帳本參數使用 autocomplete，只列出操作者有權限使用的帳本。

### 新增支出

- `/expense add` 啟動 ephemeral 引導流程。
- 選擇帳本、付款者、總額、日期與說明。
- 選擇平均分攤或指定金額。
- 使用 Discord user select 選取參與者。
- 平均分攤直接計算；指定金額則逐位輸入並顯示尚未分配的金額。
- 最後顯示完整預覽，使用者確認後才原子寫入 transaction、postings、audit 與 interaction receipt。

### 歷史紀錄

- `/expenses` 支援：帳本、成員、開始日期、結束日期、交易類型及分頁。
- 預設依 `occurred_on`、`created_at` 由新到舊排列。
- 每筆紀錄可開啟詳細資料，並提供修改及刪除按鈕。
- 修改採 `revision` 樂觀鎖；若 revision 已變更，拒絕覆蓋並顯示最新版。
- 刪除採軟刪除，相關 postings 不再納入餘額，但 audit 永久保留。

### 餘額與還款

- `/balances` 支援：帳本、截至日期及成員。
- 預設顯示目前全帳本的簡化還款建議。
- 每筆建議旁提供「部分還款」與「全部結清」。
- `/settle` 亦可直接啟動相同還款流程，但仍須通過最新餘額驗證。

## 9. 驗證、錯誤與一致性

- 所有 Discord requests 必須驗證 Ed25519 signature，驗證失敗直接回應 401。
- 每個 command 在讀寫前重新檢查 guild、帳本成員與 owner 權限。
- 日期以帳本使用者輸入的日曆日期保存；系統時間使用 UTC。
- 所有金額解析先轉換成最小貨幣單位整數，不使用浮點數進行帳務運算。
- 建立／修改交易時，以單一 D1 atomic batch 寫入交易、postings、audit 及 interaction receipt。
- 所有自動產生的公開訊息設定 `allowed_mentions`，避免帳務摘要意外 ping 成員。
- 向使用者顯示可理解的中文錯誤；內部 log 不記錄 Discord token、完整 interaction token 或其他 secrets。
- D1 暫時失敗時不顯示成功訊息；允許使用者安全重試，interaction receipt 防止重複入帳。

## 10. 測試策略

### 單元測試

- 平均分攤可整除與不可整除。
- 付款者包含及不包含於分攤者。
- 指定金額總和驗證。
- 金額格式、零、負數及超出安全整數範圍。
- 單一債務、鏈狀債務、循環債務及多債權人／債務人。
- 簡化前後每位成員的淨額完全相同。
- 部分還款與全部結清。
- 交易修改及軟刪除後重新計算餘額。

### 整合測試

- Discord signature 成功與失敗。
- 非成員、一般成員及 owner 的各項權限。
- interaction ID 重複送出。
- revision 衝突。
- `/expenses` 的日期、成員、類型與分頁篩選。
- `/balances` 的截至日期與成員顯示 filter。
- D1 batch 任一步失敗時不留下半套資料。

### 手動驗收

在測試 Discord guild 完整走過：建立帳本、加入三位成員、建立平均及指定分攤、修改、刪除、查詢、部分還款、全部結清、分享摘要，以及兩位成員同時修改同一筆交易。

## 11. 部署與營運

- 使用 Wrangler migrations 管理 D1 schema，不手動修改正式資料表。
- Discord public key、application ID 與 bot token 存入 Cloudflare secrets，不提交到版本庫。
- 部署流程先執行 typecheck、lint、unit tests 與 integration tests，再套用 migration 及部署 Worker。
- 第一版依 Cloudflare Workers/D1 免費方案設計；接近限額時加入用量告警，再評估付費方案。
- 定期匯出或備份帳務資料；恢復流程應在正式使用前至少演練一次。

## 12. 後續可能擴充

- 多人付款與百分比／權重分攤。
- 帳本 owner 轉移、共同管理員及唯讀成員。
- 多幣別、固定或自訂匯率及匯兌差額。
- 週期支出與還款提醒。
- CSV 匯出／匯入與 Web 管理介面。
- 移至 Gateway 型 Bot 以監聽訊息；領域 service 與 repository 介面應保持可重用。

## 13. 官方參考

- [Discord Interactions](https://docs.discord.com/developers/platform/interactions)
- [Discord 在 Cloudflare Workers 上的教學](https://docs.discord.com/developers/tutorials/hosting-on-cloudflare-workers)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

