import { SessionService } from "../application/session-service";
import { TransactionService } from "../application/transaction-service";
import {
  LedgerService,
  memberLabel,
  type LedgerMember,
} from "../application/ledger-service";
import {
  splitEqually,
  validateCustomShares,
  type Share,
} from "../domain/accounting";
import {
  formatMinorAmount,
  parsePositiveAmountToMinor,
} from "../domain/money";
import {
  getSubcommand,
  modalValue,
  optionalBoolean,
  optionalString,
  requiredString,
  requireActorUserId,
  requireGuildId,
} from "./options";
import { ephemeral, modal, updateMessage } from "./responses";
import type { DiscordInteraction } from "./types";
import { todayInTaipei } from "./date";
import { announce, expenseAnnouncement } from "./announce";

interface ExpenseSessionState {
  ledgerId: string;
  ledgerName: string;
  currencyCode: string;
  currencyScale: number;
  payerUserId: string;
  totalAmountMinor: number;
  splitMethod: "equal" | "custom";
  description: string;
  category?: string;
  occurredOn: string;
  announcePublicly?: boolean;
  participantUserIds?: string[];
  shares?: Share[];
  customAmounts?: number[];
}

function actionRow(...components: unknown[]): unknown {
  return { type: 1, components };
}

// Discord 的 string select 最多 25 個選項。
const MAX_PARTICIPANT_OPTIONS = 25;

function participantPicker(
  sessionId: string,
  members: readonly LedgerMember[],
): unknown[] {
  const options = members
    .slice(0, MAX_PARTICIPANT_OPTIONS)
    .map((member) => ({ label: memberLabel(member), value: member.userId }));
  return [
    actionRow({
      type: 3,
      custom_id: `expense_participants:${sessionId}`,
      placeholder: "選擇要分攤的成員",
      min_values: 1,
      max_values: options.length,
      options,
    }),
    actionRow({
      type: 2,
      style: 4,
      custom_id: `expense_cancel:${sessionId}`,
      label: "取消",
    }),
  ];
}

function customAmountButton(
  sessionId: string,
  participantUserId: string,
  index: number,
): unknown[] {
  return [
    actionRow({
      type: 2,
      style: 1,
      custom_id: `expense_amount:${sessionId}:${index}`,
      label: `輸入第 ${index + 1} 位成員的金額`,
    }),
    actionRow({
      type: 2,
      style: 4,
      custom_id: `expense_cancel:${sessionId}`,
      label: "取消",
    }),
  ];
}

function preview(
  state: ExpenseSessionState,
  sessionId: string,
): Response {
  const shares = state.shares ?? [];
  const shareLines = shares.map(
    ({ userId, amountMinor }) =>
      `• <@${userId}>：${state.currencyCode} ${formatMinorAmount(
        amountMinor,
        state.currencyScale,
      )}`,
  );
  const content = [
    "請確認支出：",
    `帳本：${state.ledgerName}`,
    `付款者：<@${state.payerUserId}>`,
    `總額：${state.currencyCode} ${formatMinorAmount(
      state.totalAmountMinor,
      state.currencyScale,
    )}`,
    `日期：${state.occurredOn}`,
    ...(state.description === "" ? [] : [`說明：${state.description}`]),
    "分攤：",
    ...shareLines,
  ].join("\n");
  return updateMessage(content, [
    actionRow(
      {
        type: 2,
        style: 3,
        custom_id: `expense_confirm:${sessionId}`,
        label: "確認入帳",
      },
      {
        type: 2,
        style: 4,
        custom_id: `expense_cancel:${sessionId}`,
        label: "取消",
      },
    ),
  ]);
}

async function requireExpenseSession(
  interaction: DiscordInteraction,
  db: D1Database,
  sessionId: string,
) {
  return new SessionService(db).require<ExpenseSessionState>({
    id: sessionId,
    guildId: requireGuildId(interaction),
    userId: requireActorUserId(interaction),
    kind: "expense",
  });
}

export async function startExpense(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const command = getSubcommand(interaction.data?.options);
  if (command.name !== "add") {
    return ephemeral("不支援這個支出操作。");
  }
  const ledgerId = requiredString(command.options, "ledger");
  const ledgers = new LedgerService(db);
  const ledger = await ledgers.requireMember(ledgerId, guildId, actorUserId);
  const split = requiredString(command.options, "split");
  if (split !== "equal" && split !== "custom") {
    return ephemeral("不支援這個分攤方式。");
  }
  const members = await ledgers.listMembers(ledgerId);
  const payerUserId = requiredString(command.options, "payer");
  if (!members.some((member) => member.userId === payerUserId)) {
    return ephemeral(
      `<@${payerUserId}> 不是「${ledger.name}」的成員，無法作為付款者。請先用 /ledger member add 加入。`,
    );
  }
  const state: ExpenseSessionState = {
    ledgerId,
    ledgerName: ledger.name,
    currencyCode: ledger.currencyCode,
    currencyScale: ledger.currencyScale,
    payerUserId,
    totalAmountMinor: parsePositiveAmountToMinor(
      requiredString(command.options, "amount"),
      ledger.currencyScale,
    ),
    splitMethod: split,
    description: optionalString(command.options, "description") ?? "",
    occurredOn: optionalString(command.options, "date") ?? todayInTaipei(),
    ...(() => {
      const category = optionalString(command.options, "category");
      return category === undefined ? {} : { category };
    })(),
    ...(optionalBoolean(command.options, "public")
      ? { announcePublicly: true }
      : {}),
  };
  const session = await new SessionService(db).create({
    guildId,
    userId: actorUserId,
    kind: "expense",
    state,
  });
  const truncated = members.length > MAX_PARTICIPANT_OPTIONS;
  return ephemeral(
    [
      `正在新增「${ledger.name}」支出。請選擇分攤成員（付款者也可以包含在內）。`,
      ...(truncated
        ? [
            `此帳本有 ${members.length} 位成員，選單只顯示前 ${MAX_PARTICIPANT_OPTIONS} 位。`,
          ]
        : []),
    ].join("\n"),
    participantPicker(session.id, members),
  );
}

export async function handleExpenseComponent(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const [action, sessionId, indexText] = customId.split(":");
  if (sessionId === undefined) {
    return ephemeral("支出操作已失效，請重新開始。");
  }
  const sessions = new SessionService(db);

  if (action === "expense_cancel") {
    await requireExpenseSession(interaction, db, sessionId);
    await sessions.delete(sessionId);
    return updateMessage("已取消新增支出。");
  }

  const session = await requireExpenseSession(interaction, db, sessionId);
  const state = session.state;

  if (action === "expense_participants") {
    const participantUserIds = interaction.data?.values ?? [];
    if (participantUserIds.length === 0) {
      return updateMessage(
        "至少要選擇一位分攤成員。",
        participantPicker(
          sessionId,
          await new LedgerService(db).listMembers(state.ledgerId),
        ),
      );
    }
    state.participantUserIds = participantUserIds;
    if (state.splitMethod === "equal") {
      state.shares = splitEqually(state.totalAmountMinor, participantUserIds);
      await sessions.update(sessionId, state);
      return preview(state, sessionId);
    }
    state.customAmounts = [];
    delete state.shares;
    await sessions.update(sessionId, state);
    return updateMessage(
      `已選擇 ${participantUserIds.length} 位成員。接著逐一輸入分攤金額，第一位是 <@${participantUserIds[0]}>。`,
      customAmountButton(sessionId, participantUserIds[0] ?? "", 0),
    );
  }

  if (action === "expense_amount") {
    const index = Number(indexText);
    const participantUserId = state.participantUserIds?.[index];
    if (!Number.isInteger(index) || participantUserId === undefined) {
      return updateMessage("自訂分攤進度無效，請重新開始。");
    }
    return modal({
      customId: `expense_amount_submit:${sessionId}:${index}`,
      title: `輸入第 ${index + 1} 位的分攤金額`,
      fields: [
        {
          customId: "amount",
          label: `${state.currencyCode} 金額`,
          placeholder: `成員 ID：${participantUserId}`,
          maxLength: 30,
        },
      ],
    });
  }

  if (action === "expense_confirm") {
    const shares = state.shares;
    if (shares === undefined) {
      return updateMessage("分攤尚未完成，請重新開始。");
    }
    const transaction = await new TransactionService(db).createExpense({
      interactionId: interaction.id,
      ledgerId: state.ledgerId,
      guildId: session.guildId,
      actorUserId: session.userId,
      payerUserId: state.payerUserId,
      totalAmountMinor: state.totalAmountMinor,
      shares,
      description: state.description,
      ...(state.category === undefined ? {} : { category: state.category }),
      occurredOn: state.occurredOn,
    });
    await sessions.delete(sessionId);
    const ledger = await new LedgerService(db).requireMember(
      state.ledgerId,
      session.guildId,
      session.userId,
    );
    if (ledger.isPublic || state.announcePublicly === true) {
      announce(
        interaction,
        expenseAnnouncement({
          actorUserId: session.userId,
          ledgerName: state.ledgerName,
          description: transaction.description,
          payerUserId: state.payerUserId,
          totalAmountMinor: transaction.totalAmountMinor,
          occurredOn: transaction.occurredOn,
          shares,
          currency: state,
        }),
        ctx,
      );
    }
    return updateMessage(
      `已記錄支出「${transaction.description || "未命名支出"}」：${
        state.currencyCode
      } ${formatMinorAmount(transaction.totalAmountMinor, state.currencyScale)}。`,
    );
  }

  return ephemeral("不支援這個支出操作。");
}

export async function handleExpenseModal(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const [action, sessionId, indexText] = customId.split(":");
  if (action !== "expense_amount_submit" || sessionId === undefined) {
    return ephemeral("不支援這個支出表單。");
  }
  const session = await requireExpenseSession(interaction, db, sessionId);
  const state = session.state;
  const index = Number(indexText);
  const participantUserIds = state.participantUserIds ?? [];
  if (!Number.isInteger(index) || participantUserIds[index] === undefined) {
    return updateMessage("自訂分攤進度無效，請重新開始。");
  }
  const amountMinor = parsePositiveAmountToMinor(
    modalValue(interaction, "amount"),
    state.currencyScale,
  );
  const amounts = state.customAmounts ?? [];
  amounts[index] = amountMinor;
  state.customAmounts = amounts;
  const nextIndex = index + 1;
  const sessions = new SessionService(db);
  if (nextIndex < participantUserIds.length) {
    await sessions.update(sessionId, state);
    return updateMessage(
      `已記錄 <@${participantUserIds[index]}> 的金額。下一位是 <@${participantUserIds[nextIndex]}>。`,
      customAmountButton(
        sessionId,
        participantUserIds[nextIndex] ?? "",
        nextIndex,
      ),
    );
  }

  const shares = participantUserIds.map((userId, shareIndex) => ({
    userId,
    amountMinor: amounts[shareIndex] ?? 0,
  }));
  try {
    state.shares = validateCustomShares(state.totalAmountMinor, shares);
  } catch {
    state.customAmounts = [];
    delete state.shares;
    await sessions.update(sessionId, state);
    return updateMessage(
      `自訂分攤合計必須等於 ${state.currencyCode} ${formatMinorAmount(
        state.totalAmountMinor,
        state.currencyScale,
      )}，請重新輸入第一位 <@${participantUserIds[0]}> 的金額。`,
      customAmountButton(sessionId, participantUserIds[0] ?? "", 0),
    );
  }
  await sessions.update(sessionId, state);
  return preview(state, sessionId);
}
