const stringOption = 3;
const userOption = 6;
const integerOption = 4;
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

const memberSubcommands = ["add", "remove"].map((name) => ({
  type: subcommand,
  name,
  description: name === "add" ? "加入帳本成員" : "移除帳本成員",
  options: [
    ledgerOption,
    {
      type: userOption,
      name: "user",
      description: "Discord 成員",
      required: true,
    },
  ],
}));

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
          {
            type: userOption,
            name: "payer",
            description: "付款者",
            required: true,
          },
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
      {
        type: userOption,
        name: "member",
        description: "只顯示涉及這位成員的紀錄",
        required: false,
      },
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
      {
        type: userOption,
        name: "member",
        description: "只顯示與這位成員有關的建議",
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
      {
        type: userOption,
        name: "payer",
        description: "付款者（欠款人）",
        required: true,
      },
      {
        type: userOption,
        name: "receiver",
        description: "收款者",
        required: true,
      },
      {
        type: stringOption,
        name: "amount",
        description: "還款金額；不填代表全部結清",
        required: false,
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
    ],
  },
] as const;
