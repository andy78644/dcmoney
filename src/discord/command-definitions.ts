const stringOption = 3;
const userOption = 6;
const integerOption = 4;
const booleanOption = 5;
const subcommand = 1;
const subcommandGroup = 2;

export const currencyChoices = [
  { name: "新台幣 (TWD)", value: "TWD:0" },
  { name: "日圓 (JPY)", value: "JPY:0" },
  { name: "美元 (USD)", value: "USD:2" },
  { name: "歐元 (EUR)", value: "EUR:2" },
] as const;

const ledgerOption = {
  type: stringOption,
  name: "ledger",
  description: "帳本",
  required: true,
  autocomplete: true,
} as const;

const expenseLedgerOption = { ...ledgerOption };

// 帳本成員欄位：用 autocomplete 字串而非 user option，
// 這樣候選清單能限制在帳本成員內，而不是整個伺服器。
const memberOption = (
  name: string,
  description: string,
  required: boolean,
) =>
  ({
    type: stringOption,
    name,
    description,
    required,
    autocomplete: true,
  }) as const;

const memberSubcommands = [
  {
    type: subcommand,
    name: "add",
    description: "加入帳本成員",
    options: [
      ledgerOption,
      {
        type: userOption,
        name: "user",
        description: "只加一位時可直接指定；留空會開啟多選選單",
        required: false,
      },
    ],
  },
  {
    type: subcommand,
    name: "remove",
    description: "移除帳本成員",
    options: [ledgerOption, memberOption("user", "帳本成員", true)],
  },
  {
    type: subcommand,
    name: "list",
    description: "列出帳本成員",
    options: [ledgerOption],
  },
];

export const commandDefinitions = [
  {
    name: "ledger",
    description: "管理多人記帳帳本",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      {
        type: subcommand,
        name: "create",
        description: "建立新帳本",
        options: [
          {
            type: stringOption,
            name: "name",
            description: "帳本名稱",
            required: true,
            min_length: 1,
            max_length: 80,
          },
          {
            type: stringOption,
            name: "currency",
            description: "帳本使用的單一幣別",
            required: true,
            choices: currencyChoices,
          },
          {
            type: booleanOption,
            name: "public",
            description: "記帳、還款、修改與刪除都公開到頻道（預設關閉）",
            required: false,
          },
        ],
      },
      {
        type: subcommand,
        name: "list",
        description: "列出我能使用的帳本",
      },
      {
        type: subcommandGroup,
        name: "member",
        description: "管理帳本成員",
        options: memberSubcommands,
      },
      {
        type: subcommand,
        name: "public",
        description: "切換帳本是否公開記帳動態（限建立者）",
        options: [
          ledgerOption,
          {
            type: booleanOption,
            name: "enabled",
            description: "開啟或關閉公開",
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "expense",
    description: "新增一筆多人分攤支出",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      {
        type: subcommand,
        name: "add",
        description: "新增支出並選擇分攤成員",
        options: [
          expenseLedgerOption,
          {
            type: stringOption,
            name: "amount",
            description: "支出總額",
            required: true,
          },
          memberOption("payer", "付款者", true),
          {
            type: stringOption,
            name: "split",
            description: "分攤方式",
            required: true,
            choices: [
              { name: "平均分攤", value: "equal" },
              { name: "指定每人金額", value: "custom" },
            ],
          },
          {
            type: stringOption,
            name: "description",
            description: "用途或備註",
            required: false,
            max_length: 200,
          },
          {
            type: stringOption,
            name: "date",
            description: "消費日期（YYYY-MM-DD，預設今天）",
            required: false,
          },
          {
            type: booleanOption,
            name: "public",
            description: "這筆公開到頻道（帳本已設公開時一律公開）",
            required: false,
          },
        ],
      },
    ],
  },
  {
    name: "expenses",
    description: "查詢支出與還款紀錄",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      ledgerOption,
      memberOption("member", "只顯示涉及這位成員的紀錄", false),
      {
        type: stringOption,
        name: "start_date",
        description: "開始日期（YYYY-MM-DD）",
        required: false,
      },
      {
        type: stringOption,
        name: "end_date",
        description: "結束日期（YYYY-MM-DD）",
        required: false,
      },
      {
        type: stringOption,
        name: "kind",
        description: "紀錄類型",
        required: false,
        choices: [
          { name: "支出", value: "expense" },
          { name: "還款", value: "settlement" },
        ],
      },
      {
        type: integerOption,
        name: "page",
        description: "頁碼（每頁 10 筆）",
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: "balances",
    description: "查看簡化後的目前欠款",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      ledgerOption,
      {
        type: stringOption,
        name: "as_of",
        description: "查看截至日期（YYYY-MM-DD）",
        required: false,
      },
      memberOption("member", "只顯示與這位成員有關的建議", false),
      {
        type: booleanOption,
        name: "public",
        description: "公開顯示給頻道所有人看（預設只有自己看得到）",
        required: false,
      },
    ],
  },
  {
    name: "settle",
    description: "記錄部分還款或全部結清",
    type: 1,
    contexts: [0],
    integration_types: [0],
    options: [
      ledgerOption,
      memberOption("payer", "付款者（欠款人）", true),
      memberOption("receiver", "收款者", true),
      {
        type: stringOption,
        name: "amount",
        description: "還款金額；不填代表全部結清",
        required: false,
        autocomplete: true,
      },
      {
        type: stringOption,
        name: "date",
        description: "還款日期（YYYY-MM-DD，預設今天）",
        required: false,
      },
      {
        type: stringOption,
        name: "description",
        description: "備註",
        required: false,
        max_length: 200,
      },
      {
        type: booleanOption,
        name: "public",
        description: "這筆公開到頻道（帳本已設公開時一律公開）",
        required: false,
      },
    ],
  },
] as const;
