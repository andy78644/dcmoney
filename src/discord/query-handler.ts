import {
  LedgerService,
  memberLabel,
  type LedgerMember,
} from "../application/ledger-service";
import { ApplicationError } from "../application/errors";
import { SessionService } from "../application/session-service";
import {
  TransactionService,
  type LedgerTransaction,
} from "../application/transaction-service";
import { formatMinorAmount, parsePositiveAmountToMinor } from "../domain/money";
import { splitEqually } from "../domain/accounting";
import { todayInTaipei } from "./date";
import {
  announce,
  changeAnnouncement,
  settlementAnnouncement,
} from "./announce";
import {
  modalValue,
  optionalModalValue,
  optionalInteger,
  optionalBoolean,
  optionalString,
  requiredString,
  requireActorUserId,
  requireGuildId,
} from "./options";
import {
  ephemeral,
  modal,
  publicMessage,
  updateMessage,
} from "./responses";
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

function historyDetailComponents(
  sessionId: string,
  transaction: LedgerTransaction,
): unknown[] {
  return [
    actionRow(
      {
        type: 2,
        style: 1,
        custom_id: `history_edit:${sessionId}:${transaction.id}`,
        label: "修改",
      },
      {
        type: 2,
        style: 4,
        custom_id: `history_delete:${sessionId}:${transaction.id}:${transaction.revision}`,
        label: "刪除",
      },
      {
        type: 2,
        style: 2,
        custom_id: `history_back:${sessionId}`,
        label: "返回列表",
      },
    ),
  ];
}

function parseUserId(value: string): string {
  const match = /^(?:<@!?)?(\d{2,30})>?$/.exec(value.trim());
  if (match?.[1] === undefined) {
    throw new ApplicationError("INVALID_INPUT", "Invalid Discord user ID.");
  }
  return match[1];
}

/**
 * Resolves a token typed into the shares box: a Discord id, a mention, or the
 * member's display name. Names are what the form prefills, so they are what
 * people edit.
 */
function resolveMemberId(
  token: string,
  members: readonly LedgerMember[],
): string {
  const trimmed = token.trim();
  const asId = /^(?:<@!?)?(\d{2,30})>?$/.exec(trimmed);
  if (asId?.[1] !== undefined) {
    return asId[1];
  }
  const matches = members.filter(
    (member) =>
      member.displayName !== null &&
      member.displayName.toLowerCase() === trimmed.toLowerCase(),
  );
  if (matches.length === 1 && matches[0] !== undefined) {
    return matches[0].userId;
  }
  throw new ApplicationError(
    "INVALID_INPUT",
    matches.length > 1
      ? `Ambiguous member name: ${trimmed}`
      : `Unknown member: ${trimmed}`,
    {
      detail:
        matches.length > 1
          ? `帳本內有多位成員叫「${trimmed}」，請改填 Discord ID。`
          : `帳本內找不到「${trimmed}」，請從分攤欄位的既有名稱修改。`,
    },
  );
}

function parseShares(
  value: string,
  currencyScale: number,
  members: readonly LedgerMember[],
): Array<{ userId: string; amountMinor: number }> {
  const entries = value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new ApplicationError("INVALID_INPUT", "At least one share is required.");
  }
  return entries.map((entry) => {
    const separator = entry.lastIndexOf("=");
    if (separator < 1) {
      throw new ApplicationError(
        "INVALID_INPUT",
        "Each share must use member=amount format.",
      );
    }
    return {
      userId: resolveMemberId(entry.slice(0, separator), members),
      amountMinor: parsePositiveAmountToMinor(
        entry.slice(separator + 1),
        currencyScale,
      ),
    };
  });
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
  ctx?: ExecutionContext,
): Promise<Response> {
  const [action, sessionId, transactionIdFromAction, revisionText] = (
    interaction.data?.custom_id ?? ""
  ).split(":");
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
    return updateMessage(
      transactionDetail(session.state, transaction),
      historyDetailComponents(sessionId, transaction),
    );
  }
  if (action === "history_back") {
    const transactions = await listFromHistoryState(
      session.state,
      session.guildId,
      session.userId,
      db,
    );
    session.state.transactionIds = transactions.map(({ id }) => id);
    await new SessionService(db).update(sessionId, session.state);
    return updateMessage(
      historyContent(session.state, transactions),
      historyComponents(sessionId, session.state, transactions),
    );
  }
  if (
    (action === "history_edit" || action === "history_delete") &&
    transactionIdFromAction !== undefined
  ) {
    if (!session.state.transactionIds.includes(transactionIdFromAction)) {
      return updateMessage("這筆紀錄不在目前查詢結果中。");
    }
    const transaction = await new TransactionService(db).get({
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      transactionId: transactionIdFromAction,
    });
    if (action === "history_edit") {
      const members = await new LedgerService(db).listMembers(
        session.state.ledgerId,
      );
      const memberChoice = (selectedUserId: string) =>
        members.map((member) => ({
          label: memberLabel(member),
          value: member.userId,
          default: member.userId === selectedUserId,
        }));
      if (transaction.type === "expense") {
        return modal({
          customId: `history_edit_submit:${sessionId}:${transaction.id}:${transaction.revision}`,
          title: "修改支出",
          fields: [
            {
              customId: "amount",
              label: `${session.state.currencyCode} 總額`,
              value: formatMinorAmount(
                transaction.totalAmountMinor,
                session.state.currencyScale,
              ),
              maxLength: 30,
            },
            {
              customId: "date",
              label: "日期（YYYY-MM-DD）",
              value: transaction.occurredOn,
              maxLength: 10,
            },
            {
              kind: "select",
              customId: "payer",
              label: "付款者",
              options: memberChoice(transaction.payerUserId),
            },
            {
              customId: "shares",
              label: "分攤",
              description: "每行「成員=金額」。留空則在原參與者之間平均分攤。",
              value: transaction.shares
                .map(({ userId, amountMinor }) => {
                  const member = members.find((m) => m.userId === userId);
                  const who =
                    member === undefined ? userId : memberLabel(member);
                  return `${who}=${formatMinorAmount(
                    amountMinor,
                    session.state.currencyScale,
                  )}`;
                })
                .join("\n"),
              required: false,
              maxLength: 4000,
              style: 2,
            },
            {
              customId: "description",
              label: "說明",
              value: transaction.description,
              required: false,
              maxLength: 200,
            },
          ],
        });
      }
      return modal({
        customId: `history_edit_submit:${sessionId}:${transaction.id}:${transaction.revision}`,
        title: "修改還款",
        fields: [
          {
            customId: "amount",
            label: `${session.state.currencyCode} 金額`,
            value: formatMinorAmount(
              transaction.totalAmountMinor,
              session.state.currencyScale,
            ),
            maxLength: 30,
          },
          {
            customId: "date",
            label: "日期（YYYY-MM-DD）",
            value: transaction.occurredOn,
            maxLength: 10,
          },
          {
            kind: "select",
            customId: "payer",
            label: "付款者（欠款人）",
            options: memberChoice(transaction.payerUserId),
          },
          {
            kind: "select",
            customId: "receiver",
            label: "收款者",
            options: memberChoice(transaction.receiverUserId),
          },
          {
            customId: "description",
            label: "說明",
            value: transaction.description,
            required: false,
            maxLength: 200,
          },
        ],
      });
    }
    return updateMessage(
      `確定要刪除這筆${
        transaction.type === "expense" ? "支出" : "還款"
      }嗎？刪除後餘額會立即重新計算，稽核紀錄仍會保留。`,
      [
        actionRow(
          {
            type: 2,
            style: 4,
            custom_id: `history_delete_confirm:${sessionId}:${transaction.id}:${transaction.revision}`,
            label: "確認刪除",
          },
          {
            type: 2,
            style: 2,
            custom_id: `history_back:${sessionId}`,
            label: "取消",
          },
        ),
      ],
    );
  }
  if (
    action === "history_delete_confirm" &&
    transactionIdFromAction !== undefined
  ) {
    const revision = Number(revisionText);
    if (!Number.isInteger(revision)) {
      return updateMessage("紀錄版本無效，請重新載入。");
    }
    const service = new TransactionService(db);
    // 讀在刪除之前，否則公告拿不到金額與說明。
    const removed = await service.get({
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      transactionId: transactionIdFromAction,
    });
    await service.delete({
      interactionId: interaction.id,
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      transactionId: transactionIdFromAction,
      expectedRevision: revision,
    });
    await announceChange(
      interaction,
      db,
      session,
      "delete",
      removed.description,
      removed.totalAmountMinor,
      removed.occurredOn,
      ctx,
    );
    session.state.transactionIds = session.state.transactionIds.filter(
      (id) => id !== transactionIdFromAction,
    );
    await new SessionService(db).update(sessionId, session.state);
    return updateMessage("已刪除紀錄並重新計算帳本餘額。", [
      actionRow({
        type: 2,
        style: 2,
        custom_id: `history_back:${sessionId}`,
        label: "返回列表",
      }),
    ]);
  }
  return ephemeral("不支援這個歷史紀錄操作。");
}

export async function handleHistoryModal(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
): Promise<Response> {
  const [action, sessionId, transactionId, revisionText] = (
    interaction.data?.custom_id ?? ""
  ).split(":");
  if (
    action !== "history_edit_submit" ||
    sessionId === undefined ||
    transactionId === undefined
  ) {
    return ephemeral("不支援這個修改表單。");
  }
  const session = await requireHistorySession(interaction, db, sessionId);
  if (!session.state.transactionIds.includes(transactionId)) {
    return updateMessage("這筆紀錄不在目前查詢結果中。");
  }
  const expectedRevision = Number(revisionText);
  if (!Number.isInteger(expectedRevision)) {
    return updateMessage("紀錄版本無效，請重新載入。");
  }
  const service = new TransactionService(db);
  const current = await service.get({
    ledgerId: session.state.ledgerId,
    guildId: session.guildId,
    actorUserId: session.userId,
    transactionId,
  });
  const amountMinor = parsePositiveAmountToMinor(
    modalValue(interaction, "amount"),
    session.state.currencyScale,
  );
  if (current.type === "expense") {
    const members = await new LedgerService(db).listMembers(
      session.state.ledgerId,
    );
    const sharesText = optionalModalValue(interaction, "shares").trim();
    // Blank means "keep the same people, split the new amount evenly" — the
    // common edit is a corrected total, and retyping every share for that is
    // busywork.
    const shares =
      sharesText === ""
        ? splitEqually(
            amountMinor,
            current.shares.map(({ userId }) => userId),
          )
        : parseShares(sharesText, session.state.currencyScale, members);
    await service.updateExpense({
      interactionId: interaction.id,
      transactionId,
      expectedRevision,
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      payerUserId: parseUserId(modalValue(interaction, "payer")),
      totalAmountMinor: amountMinor,
      shares,
      description: optionalModalValue(interaction, "description"),
      occurredOn: modalValue(interaction, "date"),
    });
  } else {
    await service.updateSettlement({
      interactionId: interaction.id,
      transactionId,
      expectedRevision,
      ledgerId: session.state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      payerUserId: parseUserId(modalValue(interaction, "payer")),
      receiverUserId: parseUserId(modalValue(interaction, "receiver")),
      amountMinor,
      description: optionalModalValue(interaction, "description"),
      occurredOn: modalValue(interaction, "date"),
    });
  }
  const updated = await service.get({
    ledgerId: session.state.ledgerId,
    guildId: session.guildId,
    actorUserId: session.userId,
    transactionId,
  });
  await announceChange(
    interaction,
    db,
    session,
    "update",
    updated.description,
    updated.totalAmountMinor,
    updated.occurredOn,
    ctx,
  );
  return updateMessage("已更新紀錄並重新計算帳本餘額。", [
    actionRow({
      type: 2,
      style: 2,
      custom_id: `history_back:${sessionId}`,
      label: "返回列表",
    }),
  ]);
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
  const isPublic = optionalBoolean(options, "public");
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
  const content =
    asOf === undefined
      ? balanceContent(state)
      : balanceContent(state).replace(
          "簡化後欠款",
          `截至 ${asOf} 的簡化欠款`,
        );

  // 公開與歷史檢視都是唯讀：結算元件綁定發起人的 session，
  // 掛在別人也看得到的訊息上只會讓其他人按了拿到錯誤。
  if (isPublic) {
    return publicMessage(content);
  }
  if (asOf !== undefined) {
    return ephemeral(content);
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
  ctx?: ExecutionContext,
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
    const outstanding = formatMinorAmount(
      suggestion.amountMinor,
      session.state.currencyScale,
    );
    return modal({
      customId: `balance_partial_submit:${sessionId}:${index}`,
      title: "記錄部分還款",
      fields: [
        {
          customId: "amount",
          label: `${session.state.currencyCode} 還款金額（上限 ${outstanding}）`,
          // 預填全額，改小即為部分還款，不必記住上一畫面的數字。
          value: outstanding,
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
      ctx,
    );
    await new SessionService(db).delete(sessionId);
    return updateMessage("已記錄全部還款，這筆建議已結清。");
  }
  return ephemeral("不支援這個餘額操作。");
}

export async function handleBalanceModal(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
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

async function announceChange(
  interaction: DiscordInteraction,
  db: D1Database,
  session: { state: HistorySessionState; guildId: string; userId: string },
  action: "update" | "delete",
  description: string,
  totalAmountMinor: number,
  occurredOn: string,
  ctx?: ExecutionContext,
): Promise<void> {
  const ledger = await new LedgerService(db).requireMember(
    session.state.ledgerId,
    session.guildId,
    session.userId,
  );
  if (!ledger.isPublic) {
    return;
  }
  announce(
    interaction,
    changeAnnouncement({
      actorUserId: session.userId,
      ledgerName: session.state.ledgerName,
      action,
      description,
      totalAmountMinor,
      occurredOn,
      currency: session.state,
    }),
    ctx,
  );
}

async function createSuggestedSettlement(
  interaction: DiscordInteraction,
  db: D1Database,
  session: Awaited<ReturnType<typeof requireBalanceSession>>,
  suggestion: BalanceSessionState["suggestions"][number],
  amountMinor: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const occurredOn = todayInTaipei();
  await new TransactionService(db).createSettlement({
    interactionId: interaction.id,
    ledgerId: session.state.ledgerId,
    guildId: session.guildId,
    actorUserId: session.userId,
    payerUserId: suggestion.debtorUserId,
    receiverUserId: suggestion.creditorUserId,
    amountMinor,
    description: "還款",
    occurredOn,
  });
  const ledger = await new LedgerService(db).requireMember(
    session.state.ledgerId,
    session.guildId,
    session.userId,
  );
  if (ledger.isPublic) {
    announce(
      interaction,
      settlementAnnouncement({
        actorUserId: session.userId,
        ledgerName: session.state.ledgerName,
        payerUserId: suggestion.debtorUserId,
        receiverUserId: suggestion.creditorUserId,
        amountMinor,
        occurredOn,
        currency: session.state,
      }),
      ctx,
    );
  }
}

export async function createDirectSettlement(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
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
  const amountText = optionalString(options, "amount");
  let amountMinor: number;
  if (amountText !== undefined) {
    amountMinor = parsePositiveAmountToMinor(amountText, ledger.currencyScale);
  } else {
    // Omitting the amount means "settle this suggestion", so it resolves to
    // what the simplified graph says this pair owes — never the payer's whole
    // debt, which would be wrong the moment they owe more than one person.
    const suggested = (
      await new TransactionService(db).getSuggestions({
        ledgerId,
        guildId,
        actorUserId,
      })
    ).find(
      ({ debtorUserId, creditorUserId }) =>
        debtorUserId === payerUserId && creditorUserId === receiverUserId,
    );
    if (suggested === undefined) {
      return ephemeral(
        `目前的建議還款中沒有 <@${payerUserId}> → <@${receiverUserId}> 這一筆，` +
          "所以無法自動判斷金額。請填入實際還款金額，或用 `/balances` 依建議結清。",
      );
    }
    amountMinor = suggested.amountMinor;
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
  if (ledger.isPublic || optionalBoolean(options, "public")) {
    announce(
      interaction,
      settlementAnnouncement({
        actorUserId,
        ledgerName: ledger.name,
        payerUserId: settlement.payerUserId,
        receiverUserId: settlement.receiverUserId,
        amountMinor: settlement.totalAmountMinor,
        occurredOn: settlement.occurredOn,
        currency: ledger,
      }),
      ctx,
    );
  }
  return ephemeral(
    `已記錄還款：<@${settlement.payerUserId}> → <@${
      settlement.receiverUserId
    }> ${ledger.currencyCode} ${formatMinorAmount(
      settlement.totalAmountMinor,
      ledger.currencyScale,
    )}。`,
  );
}
