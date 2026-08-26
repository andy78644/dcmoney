# dcmoney

部署在 Cloudflare Workers + D1 的 Discord 多人記帳 Bot。每個 Discord 伺服器可以建立多個獨立帳本，支援平均／指定金額分攤、歷史查詢、部分還款、全部結清，以及跨成員的債務簡化。

目前實作與部署狀態請見 [開發進度](docs/PROGRESS.md)。

## 自架一份

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/andy78644/dcmoney)

按鈕會把這個 repo clone 到你的 GitHub、在你的 Cloudflare 帳號建立 Worker 與
D1、套用 migration，並接上 Workers Builds 做後續自動部署。過程中會請你填入
`DISCORD_PUBLIC_KEY`。

部署完成後仍需自行完成 Discord 端設定：把 Interactions Endpoint URL 指向
`<你的 worker 網址>/interactions`、註冊 slash commands、把 application 安裝到
伺服器。步驟見下方[設定與部署 Discord Bot](#設定與部署-discord-bot)。

D1 的位置建議選擇離 Discord 伺服器近的區域，理由見
[開發進度](docs/PROGRESS.md)的效能一節。

## 功能

- 多帳本與帳本成員權限。
- 單一付款者、多人成員平均分攤。
- 單一付款者、逐人指定分攤金額。
- 支出與還款的日期、成員、類型篩選。
- 鏈狀債務簡化，例如 A 欠 B 100、B 欠 C 100 顯示為 A 欠 C 100。
- 部分還款與全部結清。還款不受債務簡化建議限制，可記錄實際發生的任何一筆付款。
- 帳本可封存，從清單與選單隱藏但保留全部紀錄。
- 所有帳本成員皆可修改或刪除紀錄。
- revision conflict、軟刪除、audit trail、Interaction 冪等與帳本餘額版本鎖。
- 所有帳務畫面預設為 Discord ephemeral response。
- 公開帳本會把記帳、還款、修改與刪除公告到頻道，讓成員知道誰動了帳。
- 加入成員時會在頻道通知並提及對方，這是唯一會真的 ping 人的訊息。

分攤成員從只列出帳本成員的選單挑選，一筆支出最多 25 位。每個帳本只能使用一種幣別；第一版內建 TWD、JPY、USD、EUR，不處理匯率。

## 指令

| 指令 | 用途 |
| --- | --- |
| `/ledger create` | 建立帳本並選擇幣別 |
| `/ledger list` | 列出自己可以使用的帳本；`archived` 可改列已封存的 |
| `/ledger member add` | 建立者加入帳本成員；不指定 user 會開多選，一次最多 25 位 |
| `/ledger member remove` | 建立者移除帳本成員 |
| `/ledger member list` | 列出帳本成員與建立者 |
| `/ledger public` | 建立者切換帳本是否公開記帳動態 |
| `/ledger archive` | 建立者封存或復原帳本 |
| `/expense add` | 透過引導流程新增平均或指定金額分攤；`public` 可單筆公開 |
| `/expenses` | 依成員、日期、類型及頁碼查詢紀錄 |
| `/balances` | 查看目前或截至指定日期的簡化欠款；`public` 可公開給頻道 |
| `/settle` | 記錄任兩位成員之間的還款；省略金額代表結清付款者全部欠款；`public` 可單筆公開 |

`/expenses` 的紀錄明細提供修改與刪除。修改表單的付款者與收款者是成員選單，分攤欄位
預填「成員名稱=金額」，留空則在原參與者之間平均分攤。

## 技術需求

- Node.js 20 以上（CI 使用 Node.js 22）
- Cloudflare 帳號
- Discord Application 與 Bot token

Bot 只接收 Discord HTTP Interactions，不建立 Gateway WebSocket，也不讀取一般聊天訊息。

## 本機安裝與測試

```bash
npm ci
npm run check
```

`npm run check` 會依 `wrangler.jsonc` 產生 Worker/D1 型別、執行 TypeScript 型別檢查，並在 Cloudflare 的本機 workerd + D1 測試環境跑完整測試。

其他常用指令：

```bash
npm run test:watch
npm run db:migrate:local
npm run dev
npm run verify
```

複製 `.dev.vars.example` 為 `.dev.vars`，填入 Discord Application 的 Public Key。`.dev.vars`、`.env`、Bot token 與其他 secrets 都不會提交到 Git。

## 建立 Cloudflare D1

1. 登入 Wrangler：

   ```bash
   npx wrangler login
   ```

2. 建立 D1 database：

   ```bash
   npx wrangler d1 create dcmoney-us --location enam
   ```

   `--location` 很重要。Discord 從美國的伺服器送出 interaction，Worker 因此
   在美東執行；資料庫放在別的大陸會讓每次查詢多花約 200ms，累積起來會逼近
   Discord 的 3 秒回應上限。詳見 [開發進度](docs/PROGRESS.md) 的效能一節。

3. 將指令輸出的 `database_id` 與 `database_name` 填入 `wrangler.jsonc`。

4. 重新產生型別並套用 migration：

   ```bash
   npm run types
   npm run db:migrate:remote
   ```

專案使用 `migrations/` 版本化 D1 schema。不要直接在正式資料庫手動修改資料表。

`npm run deploy` 會先套用 migration 再部署，因此正式環境的 schema 不會落後於
程式碼。migration 指令引用的是 binding 名稱 `DB` 而非資料庫名稱，這樣別人自架
時即使資料庫取了別的名字也能運作。

## 設定與部署 Discord Bot

1. 在 Discord Developer Portal 建立 Application 和 Bot，記下：
   - Application ID
   - Public Key
   - Bot Token
2. 將 Public Key 存成 Cloudflare secret：

   ```bash
   npx wrangler secret put DISCORD_PUBLIC_KEY
   ```

3. 部署 Worker：

   ```bash
   npm run deploy
   ```

4. 在 Discord Application 的 General Information 頁面，將 Interactions Endpoint URL 設成：

   ```text
   https://<你的-worker-domain>/interactions
   ```

5. 註冊 Slash Commands。開發時建議先設定 `DISCORD_GUILD_ID`，guild commands 會較快生效：

   ```bash
   DISCORD_APPLICATION_ID=... \
   DISCORD_BOT_TOKEN=... \
   DISCORD_GUILD_ID=... \
   npm run commands:register
   ```

   確認完成後可省略 `DISCORD_GUILD_ID`，改註冊 global commands。

6. 從 Developer Portal 的 Installation 頁面，把 Application 安裝到測試伺服器並允許 application commands。

`DISCORD_BOT_TOKEN` 只供本機的 command registration script 呼叫 Discord REST API，不需要、也不應部署到 Worker。Worker 正式環境只需要 `DISCORD_PUBLIC_KEY` 與 D1 binding。

## 資料與安全

- 金額以最小貨幣單位的安全整數保存，不使用浮點數運算。
- Discord requests 全部驗證 Ed25519 signature。
- 寫入交易、分錄、audit 與 Interaction receipt 使用 D1 atomic batch。
- 交易更新使用 transaction revision；所有餘額變更另使用 ledger balance revision。
- 刪除只標記為 deleted，原始 audit 不會被移除。
- 預設日期使用 Asia/Taipei 日曆日期，資料庫時間戳使用 UTC。
- 回應設定 `allowed_mentions`，顯示成員時不會意外 ping。唯一的例外是加入成員
  的通知，它只提及該次新加入的人。

正式使用前建議定期執行 D1 export 或使用 Cloudflare 的備份／Time Travel 能力，並至少演練一次還原流程。

## 專案結構

```text
src/domain/         純金額、分攤、分錄與債務簡化
src/application/    D1 帳本、交易、稽核與 session services
src/discord/        Discord 指令、元件、Modal、公開公告與回應格式
migrations/         D1 schema migrations
scripts/            Slash Command 註冊工具
test/               domain、D1 service 與 Worker 互動測試
docs/plans/         已確認的 MVP 設計文件
```

詳細決策請參考 [MVP 設計](docs/plans/2026-08-18-discord-expense-bot-design.md)。
