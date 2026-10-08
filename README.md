# dcmoney

在 Discord 裡分帳，不用再切換到別的 app。

一群人出去玩、合租、揪團訂餐，錢常常是這個人先墊、那個人後補。dcmoney 讓你在
原本就在聊天的頻道裡把這些記下來，隨時知道誰欠誰多少，最後用最少的筆數還清。

```text
/expense add ledger:沖繩 amount:4500 payer:@我 split:平均分攤 description:民宿
  → 選擇分攤成員 → 確認 → 每人 1500

/balances ledger:沖繩
  → 小明 應付 我 1500
     小美 應付 我 1500

/settle ledger:沖繩 payer:@小明 receiver:@我
  → 金額自動帶入 1500，記錄完成
```

**適合**：朋友出遊、室友分攤、社團或小團隊的共同開銷。
**不適合**：需要匯率換算、收據辨識、或串接實際金流的情境 —— 這些都不在範圍內。

## 為什麼是這個而不是別的

- **免費的債務簡化**。A 欠 B、B 欠 C 會自動收斂成 A 欠 C，N 個人最多 N−1 筆還款
  就能清帳。這在部分商業 app 是付費功能。
- **改得動，也查得到**。任何成員都能修改或刪除紀錄，每次變更都留稽核紀錄，
  刪除是軟刪除。多人同時編輯有版本鎖保護。
- **自己的資料放自己家**。跑在你自己的 Cloudflare 帳號上，資料在你自己的 D1。
- **不讀你的聊天內容**。只接收 slash command，不建立 Gateway 連線，也不需要
  任何訊息讀取權限。

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

- 多帳本與帳本成員權限，可設多位管理者並轉移建立者身分。
- 支出分類，選單會回填該帳本用過的分類。
- 單一付款者、多人成員平均分攤。
- 單一付款者、逐人指定分攤金額。
- 支出與還款的日期、成員、分類、類型篩選，附上下頁按鈕。
- 期間統計：總支出、每人付出與分攤淨額、分類佔比。
- 鏈狀債務簡化，例如 A 欠 B 100、B 欠 C 100 顯示為 A 欠 C 100。
- 部分還款與全部結清。省略金額時依簡化建議自動帶入該組的欠款金額；
  也可填入明確金額，記錄簡化建議以外實際發生的付款。
- 帳本可封存，從清單與選單隱藏但保留全部紀錄。
- 所有帳本成員皆可修改或刪除紀錄。
- revision conflict、軟刪除、audit trail、Interaction 冪等與帳本餘額版本鎖。
- 所有帳務畫面預設為 Discord ephemeral response。
- 公開帳本會把記帳、還款、修改與刪除公告到頻道，讓成員知道誰動了帳。
- 加入成員時會在頻道通知並提及對方，這是唯一會真的 ping 人的訊息。

分攤成員從只列出帳本成員的選單挑選，一筆支出最多 25 位。每個帳本只能使用一種幣別；第一版內建 TWD、JPY、USD、EUR，不處理匯率。

## 權限

| 角色 | 能做什麼 |
| --- | --- |
| 建立者 | 管理者的全部權限。永遠是管理者，不能被降級或移出帳本 |
| 管理者 | 加入／移除成員、設定公開、封存、改名、轉移建立者、指派其他管理者 |
| 成員 | 記帳、還款、查詢，以及**修改或刪除任何一筆紀錄** |

帳本至少會保留一位管理者，所以不會出現沒有人能管理的狀態。

成員一律平等：任何人都能改動別人記的帳。這是刻意的設計 —— 記錯帳的人不一定是
發現的人。變更全部留在稽核紀錄裡，刪除也只是標記，不會真的消失。

## 指令

| 指令 | 用途 |
| --- | --- |
| `/ledger create` | 建立帳本並選擇幣別 |
| `/ledger list` | 列出自己可以使用的帳本；`archived` 可改列已封存的，`page` 翻頁 |
| `/ledger member add` | 管理者加入帳本成員；不指定 user 會開多選，一次最多 25 位 |
| `/ledger member remove` | 管理者移除帳本成員 |
| `/ledger member list` | 列出帳本成員，標示建立者與管理者 |
| `/ledger public` | 管理者切換帳本是否公開記帳動態 |
| `/ledger archive` | 管理者封存或復原帳本 |
| `/ledger rename` | 管理者更改帳本名稱 |
| `/ledger transfer` | 管理者轉移建立者身分 |
| `/ledger manager` | 管理者設定或取消其他成員的管理者身分 |
| `/expense add` | 透過引導流程新增平均或指定金額分攤；`public` 可單筆公開 |
| `/expenses` | 依成員、分類、日期、類型及頁碼查詢紀錄 |
| `/balances` | 查看目前或截至指定日期的簡化欠款；`public` 可公開給頻道 |
| `/summary` | 總支出、每人花費與實際付款、分類佔比；`member` 看某人的花費明細；`public` 可公開給頻道 |
| `/settle` | 記錄還款；省略金額代表依簡化建議結清這一組；`public` 可單筆公開 |

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
