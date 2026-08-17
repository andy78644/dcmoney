const stringOption = 3;
const userOption = 6;
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
] as const;
