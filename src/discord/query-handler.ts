import { LedgerService } from "../application/ledger-service";
import { SessionService } from "../application/session-service";
import {
  TransactionService,
  type LedgerTransaction,
} from "../application/transaction-service";
import { formatMinorAmount, parsePositiveAmountToMinor } from "../domain/money";
import { todayInTaipei } from "./date";
import {
  modalValue,
  optionalInteger,
  optionalString,
  requiredString,
  requireActorUserId,
  requireGuildId,
} from "./options";
import { ephemeral, modal, updateMessage } from "./responses";
import type { DiscordInteraction } from "./types";

interface HistorySessionState {
  ledgerId: string;
  ledgerName: string;
  currencyCode: string;
  currencyScale: number;
  memberUserId?: string;
  startDate?: string;
  endDate?: string;
  type?: "expense" | "settlement";
  page: number;
  transactionIds: string[];
}

interface BalanceSessionState {
  ledgerId: string;
  ledgerName: string;
  currencyCode: string;
  currencyScale: number;
  suggestions: Array<{
    debtorUserId: string;
    creditorUserId: string;
    amountMinor: number;
  }>;
}

function actionRow(...components: unknown[]): unknown {
  return { type: 1, components };
}

function transactionLabel(
  transaction: LedgerTransaction,
  scale: number,
): string {
  const kind = transaction.type === "expense" ? "支出" : "還款";
  const description = transaction.description || kind;
  return `${transaction.occurredOn} ${description} ${formatMinorAmount(
    transaction.totalAmountMinor,
    scale,
  )}`.slice(0, 100);
}

function historyContent(
  state: HistorySessionState,
  transactions: LedgerTransaction[],
): string {
  if (transactions.length === 0) {
    return `「${state.ledgerName}」在這個篩選條件下沒有紀錄。`;
  }
  const lines = transactions.map((transaction, index) => {
    const kind = transaction.type === "expense" ? "支出" : "還款";
    return `${index + 1}. ${transaction.occurredOn}｜${kind}｜${
      transaction.description || "未填說明"
    }｜${state.currencyCode} ${formatMinorAmount(
      transaction.totalAmountMinor,
      state.currencyScale,
    )}`;
  });
  return [`「${state.ledgerName}」紀錄（第 ${state.page} 頁）：`, ...lines].join(
    "\n",
  );
}

function historyComponents(
  sessionId: string,
  state: HistorySessionState,
  transactions: LedgerTransaction[],
): unknown[] {
  if (transactions.length === 0) {
    return [];
  }
  return [
    actionRow({
      type: 3,
      custom_id: `history_select:${sessionId}`,
      placeholder: "選擇一筆查看明細",
      min_values: 1,
      max_values: 1,
      options: transactions.map((transaction) => ({
        label: transactionLabel(transaction, state.currencyScale),
        value: transaction.id,
      })),
    }),
  ];
}

function transactionDetail(
  state: HistorySessionState,
  transaction: LedgerTransaction,
): string {
  const base = [
    transaction.type === "expense" ? "支出明細" : "還款明細",
    `日期：${transaction.occurredOn}`,
    `金額：${state.currencyCode} ${formatMinorAmount(
      transaction.totalAmountMinor,
      state.currencyScale,
    )}`,
    `說明：${transaction.description || "未填"}`,
    `版本：${transaction.revision}`,
  ];
  if (transaction.type === "expense") {
    return [
      ...base,
      `付款者：<@${transaction.payerUserId}>`,
      "分攤：",
      ...transaction.shares.map(
        ({ userId, amountMinor }) =>
          `• <@${userId}>：${state.currencyCode} ${formatMinorAmount(
            amountMinor,
            state.currencyScale,
          )}`,
      ),
    ].join("\n");
  }
  return [
    ...base,
    `付款者：<@${transaction.payerUserId}>`,
    `收款者：<@${transaction.receiverUserId}>`,
  ].join("\n");
}

async function listFromHistoryState(
  state: HistorySessionState,
  guildId: string,
  actorUserId: string,
  db: D1Database,
) {
  return new TransactionService(db).list({
    ledgerId: state.ledgerId,
    guildId,
    actorUserId,
    ...(state.memberUserId === undefined
      ? {}
      : { memberUserId: state.memberUserId }),
    ...(state.startDate === undefined ? {} : { startDate: state.startDate }),
    ...(state.endDate === undefined ? {} : { endDate: state.endDate }),
    ...(state.type === undefined ? {} : { type: state.type }),
    limit: 10,
    offset: (state.page - 1) * 10,
  });
}

export async function startExpenses(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const options = interaction.data?.options ?? [];
  const ledgerId = requiredString(options, "ledger");
  const ledger = await new LedgerService(db).requireMember(
    ledgerId,
    guildId,
    actorUserId,
  );
  const kind = optionalString(options, "kind");
  const memberUserId = optionalString(options, "member");
  const startDate = optionalString(options, "start_date");
  const endDate = optionalString(options, "end_date");
  const state: HistorySessionState = {
    ledgerId,
    ledgerName: ledger.name,
    currencyCode: ledger.currencyCode,
    currencyScale: ledger.currencyScale,
    page: optionalInteger(options, "page") ?? 1,
    transactionIds: [],
    ...(memberUserId === undefined ? {} : { memberUserId }),
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(kind === "expense" || kind === "settlement" ? { type: kind } : {}),
  };
  const transactions = await listFromHistoryState(
    state,
    guildId,
    actorUserId,
    db,
  );
  state.transactionIds = transactions.map(({ id }) => id);
  const session = await new SessionService(db).create({
    guildId,
    userId: actorUserId,
    kind: "history",
    state,
  });
  return ephemeral(
    historyContent(state, transactions),
    historyComponents(session.id, state, transactions),
  );
}

async function requireHistorySession(
  interaction: DiscordInteraction,
  db: D1Database,
  sessionId: string,
) {
  return new SessionService(db).require<HistorySessionState>({
    id: sessionId,
    guildId: requireGuildId(interaction),
    userId: requireActorUserId(interaction),
    kind: "history",
  });
}

export async function handleHistoryComponent(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const [action, sessionId] = (interaction.data?.custom_id ?? "").split(":");
  if (sessionId === undefined) {
    return ephemeral("查詢已過期，請重新執行 `/expenses`。");
  }
  const session = await requireHistorySession(interaction, db, sessionId);
  if (action === "history_select") {
    const transactionId = interaction.data?.values?.[0];
    if (
      transactionId === undefined ||
      !session.state.transactionIds.includes(transactionId)
    ) {
      return updateMessage("這筆紀錄不在目前查詢結果中。");
    }
    const transaction = await new TransactionService(db).get({
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      transactionId,
    });
    return updateMessage(transactionDetail(session.state, transaction), [
      actionRow({
        type: 2,
        style: 2,
        custom_id: `history_back:${sessionId}`,
        label: "返回列表",
      }),
    ]);
  }
  if (action === "history_back") {
    const transactions = await listFromHistoryState(
      session.state,
      session.guildId,
      session.userId,
      db,
    );
    return updateMessage(
      historyContent(session.state, transactions),
      historyComponents(sessionId, session.state, transactions),
    );
  }
  return ephemeral("不支援這個歷史紀錄操作。");
}

function balanceContent(state: BalanceSessionState): string {
  if (state.suggestions.length === 0) {
    return `「${state.ledgerName}」目前沒有未結清欠款。`;
  }
  return [
    `「${state.ledgerName}」簡化後欠款：`,
    ...state.suggestions.map(
      (suggestion, index) =>
        `${index + 1}. <@${suggestion.debtorUserId}> 應付 <@${
          suggestion.creditorUserId
        }> ${state.currencyCode} ${formatMinorAmount(
          suggestion.amountMinor,
          state.currencyScale,
        )}`,
    ),
  ].join("\n");
}

function balanceComponents(sessionId: string, state: BalanceSessionState): unknown[] {
  if (state.suggestions.length === 0) {
    return [];
  }
  return [
    actionRow({
      type: 3,
      custom_id: `balance_select:${sessionId}`,
      placeholder: "選擇一筆欠款進行還款",
      min_values: 1,
      max_values: 1,
      options: state.suggestions.slice(0, 25).map((suggestion, index) => ({
        label: `${index + 1}. ${formatMinorAmount(
          suggestion.amountMinor,
          state.currencyScale,
        )} ${state.currencyCode}`,
        description: `${suggestion.debtorUserId} → ${suggestion.creditorUserId}`.slice(
          0,
          100,
        ),
        value: String(index),
      })),
    }),
  ];
}

export async function startBalances(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const options = interaction.data?.options ?? [];
  const ledgerId = requiredString(options, "ledger");
  const ledger = await new LedgerService(db).requireMember(
    ledgerId,
    guildId,
    actorUserId,
  );
  const asOf = optionalString(options, "as_of");
  const memberUserId = optionalString(options, "member");
  const suggestions = await new TransactionService(db).getSuggestions({
    ledgerId,
    guildId,
    actorUserId,
    ...(asOf === undefined ? {} : { asOf }),
    ...(memberUserId === undefined ? {} : { memberUserId }),
  });
  const state: BalanceSessionState = {
    ledgerId,
    ledgerName: ledger.name,
    currencyCode: ledger.currencyCode,
    currencyScale: ledger.currencyScale,
    suggestions,
  };
  if (asOf !== undefined) {
    const historical = balanceContent(state).replace(
      "簡化後欠款",
      `截至 ${asOf} 的簡化欠款`,
    );
    return ephemeral(historical);
  }
  const session = await new SessionService(db).create({
    guildId,
    userId: actorUserId,
    kind: "balance",
    state,
  });
  return ephemeral(
    balanceContent(state),
    balanceComponents(session.id, state),
  );
}

async function requireBalanceSession(
  interaction: DiscordInteraction,
  db: D1Database,
  sessionId: string,
) {
  return new SessionService(db).require<BalanceSessionState>({
    id: sessionId,
    guildId: requireGuildId(interaction),
    userId: requireActorUserId(interaction),
    kind: "balance",
  });
}

export async function handleBalanceComponent(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const [action, sessionId, indexText] = (
    interaction.data?.custom_id ?? ""
  ).split(":");
  if (sessionId === undefined) {
    return ephemeral("餘額查詢已過期，請重新執行 `/balances`。");
  }
  const session = await requireBalanceSession(interaction, db, sessionId);
  if (action === "balance_select") {
    const index = Number(interaction.data?.values?.[0]);
    const suggestion = session.state.suggestions[index];
    if (!Number.isInteger(index) || suggestion === undefined) {
      return updateMessage("找不到這筆還款建議。");
    }
    return updateMessage(
      `<@${suggestion.debtorUserId}> 應付 <@${
        suggestion.creditorUserId
      }> ${session.state.currencyCode} ${formatMinorAmount(
        suggestion.amountMinor,
        session.state.currencyScale,
      )}`,
      [
        actionRow(
          {
            type: 2,
            style: 1,
            custom_id: `balance_partial:${sessionId}:${index}`,
            label: "部分還款",
          },
          {
            type: 2,
            style: 3,
            custom_id: `balance_full:${sessionId}:${index}`,
            label: "全部結清",
          },
          {
            type: 2,
            style: 2,
            custom_id: `balance_back:${sessionId}`,
            label: "返回",
          },
        ),
      ],
    );
  }
  if (action === "balance_back") {
    const suggestions = await new TransactionService(db).getSuggestions({
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
    });
    session.state.suggestions = suggestions;
    await new SessionService(db).update(sessionId, session.state);
    return updateMessage(
      balanceContent(session.state),
      balanceComponents(sessionId, session.state),
    );
  }
  const index = Number(indexText);
  const suggestion = session.state.suggestions[index];
  if (!Number.isInteger(index) || suggestion === undefined) {
    return updateMessage("找不到這筆還款建議。");
  }
  if (action === "balance_partial") {
    return modal({
      customId: `balance_partial_submit:${sessionId}:${index}`,
      title: "記錄部分還款",
      fields: [
        {
          customId: "amount",
          label: `${session.state.currencyCode} 還款金額`,
          maxLength: 30,
        },
      ],
    });
  }
  if (action === "balance_full") {
    await createSuggestedSettlement(
      interaction,
      db,
      session,
      suggestion,
      suggestion.amountMinor,
    );
    await new SessionService(db).delete(sessionId);
    return updateMessage("已記錄全部還款，這筆建議已結清。");
  }
  return ephemeral("不支援這個餘額操作。");
}

export async function handleBalanceModal(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const [action, sessionId, indexText] = (
    interaction.data?.custom_id ?? ""
  ).split(":");
  if (action !== "balance_partial_submit" || sessionId === undefined) {
    return ephemeral("不支援這個還款表單。");
  }
  const session = await requireBalanceSession(interaction, db, sessionId);
  const index = Number(indexText);
  const suggestion = session.state.suggestions[index];
  if (!Number.isInteger(index) || suggestion === undefined) {
    return updateMessage("找不到這筆還款建議。");
  }
  const amountMinor = parsePositiveAmountToMinor(
    modalValue(interaction, "amount"),
    session.state.currencyScale,
  );
  await createSuggestedSettlement(
    interaction,
    db,
    session,
    suggestion,
    amountMinor,
  );
  await new SessionService(db).delete(sessionId);
  return updateMessage(
    `已記錄部分還款 ${session.state.currencyCode} ${formatMinorAmount(
      amountMinor,
      session.state.currencyScale,
    )}。`,
  );
}

async function createSuggestedSettlement(
  interaction: DiscordInteraction,
  db: D1Database,
  session: Awaited<ReturnType<typeof requireBalanceSession>>,
  suggestion: BalanceSessionState["suggestions"][number],
  amountMinor: number,
): Promise<void> {
  await new TransactionService(db).createSettlement({
    interactionId: interaction.id,
    ledgerId: session.state.ledgerId,
    guildId: session.guildId,
    actorUserId: session.userId,
    payerUserId: suggestion.debtorUserId,
    receiverUserId: suggestion.creditorUserId,
    amountMinor,
    description: "還款",
    occurredOn: todayInTaipei(),
  });
}

export async function createDirectSettlement(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const options = interaction.data?.options ?? [];
  const ledgerId = requiredString(options, "ledger");
  const payerUserId = requiredString(options, "payer");
  const receiverUserId = requiredString(options, "receiver");
  const ledger = await new LedgerService(db).requireMember(
    ledgerId,
    guildId,
    actorUserId,
  );
  const current = (
    await new TransactionService(db).getSuggestions({
      ledgerId,
      guildId,
      actorUserId,
    })
  ).find(
    (suggestion) =>
      suggestion.debtorUserId === payerUserId &&
      suggestion.creditorUserId === receiverUserId,
  );
  const amountText = optionalString(options, "amount");
  const amountMinor =
    amountText === undefined
      ? current?.amountMinor
      : parsePositiveAmountToMinor(amountText, ledger.currencyScale);
  if (amountMinor === undefined) {
    return ephemeral("目前沒有符合這個付款方向的欠款建議。");
  }
  const settlement = await new TransactionService(db).createSettlement({
    interactionId: interaction.id,
    ledgerId,
    guildId,
    actorUserId,
    payerUserId,
    receiverUserId,
    amountMinor,
    description: optionalString(options, "description") ?? "還款",
    occurredOn: optionalString(options, "date") ?? todayInTaipei(),
  });
  return ephemeral(
    `已記錄還款：<@${settlement.payerUserId}> → <@${
      settlement.receiverUserId
    }> ${ledger.currencyCode} ${formatMinorAmount(
      settlement.totalAmountMinor,
      ledger.currencyScale,
    )}。`,
  );
}
