import { DomainError } from "../domain/errors";
import { ApplicationError } from "../application/errors";
import {
  handleLedgerAutocomplete,
  handleLedgerCommand,
  handleMemberComponent,
} from "./ledger-handler";
import {
  handleExpenseComponent,
  handleExpenseModal,
  startExpense,
} from "./expense-handler";
import {
  createDirectSettlement,
  handleBalanceComponent,
  handleBalanceModal,
  handleHistoryComponent,
  handleHistoryModal,
  startBalances,
  startExpenses,
} from "./query-handler";
import { autocomplete, ephemeral } from "./responses";
import type { DiscordInteraction } from "./types";

const applicationMessages: Record<string, string> = {
  CONFLICT: "這筆紀錄剛被其他成員修改，請重新載入後再試。",
  DUPLICATE_INTERACTION: "這個操作已經處理完成，沒有重複入帳。",
  FORBIDDEN: "你沒有權限使用這個帳本或執行這項操作。",
  INVALID_DATE: "日期格式或日期內容不正確。",
  INVALID_INPUT: "輸入內容不正確，請檢查後再試。",
  LEDGER_NAME_TAKEN: "這個伺服器已經有同名帳本。",
  MEMBER_ALREADY_EXISTS: "這位成員已經在帳本內。",
  MEMBER_NOT_FOUND: "帳本內找不到這位成員。",
  MEMBER_NOT_IN_LEDGER: "有成員不在帳本內，請先用 /ledger member add 加入。",
  NOT_FOUND: "找不到指定的帳本或紀錄。",
  OWNER_CANNOT_BE_REMOVED: "帳本建立者不能被移除。",
  SETTLEMENT_EXCEEDS_BALANCE: "還款金額超過付款者的欠款總額。",
  SETTLEMENT_NOT_A_DEBTOR: "這位付款者目前在帳本內沒有欠款。",
};

export async function routeInteraction(
  interaction: DiscordInteraction,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  try {
    if (interaction.type === 2 && interaction.data?.name === "ledger") {
      return await handleLedgerCommand(interaction, env.DB, ctx);
    }
    if (interaction.type === 2 && interaction.data?.name === "expense") {
      return await startExpense(interaction, env.DB);
    }
    if (interaction.type === 2 && interaction.data?.name === "expenses") {
      return await startExpenses(interaction, env.DB);
    }
    if (interaction.type === 2 && interaction.data?.name === "balances") {
      return await startBalances(interaction, env.DB);
    }
    if (interaction.type === 2 && interaction.data?.name === "settle") {
      return await createDirectSettlement(interaction, env.DB, ctx);
    }
    if (interaction.type === 4) {
      return await handleLedgerAutocomplete(interaction, env.DB);
    }
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id?.startsWith("member_") === true
    ) {
      return await handleMemberComponent(interaction, env.DB, ctx);
    }
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id?.startsWith("expense_") === true
    ) {
      return await handleExpenseComponent(interaction, env.DB, ctx);
    }
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id?.startsWith("history_") === true
    ) {
      return await handleHistoryComponent(interaction, env.DB, ctx);
    }
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id?.startsWith("balance_") === true
    ) {
      return await handleBalanceComponent(interaction, env.DB, ctx);
    }
    if (
      interaction.type === 5 &&
      interaction.data?.custom_id?.startsWith("expense_") === true
    ) {
      return await handleExpenseModal(interaction, env.DB);
    }
    if (
      interaction.type === 5 &&
      interaction.data?.custom_id?.startsWith("balance_") === true
    ) {
      return await handleBalanceModal(interaction, env.DB, ctx);
    }
    if (
      interaction.type === 5 &&
      interaction.data?.custom_id?.startsWith("history_") === true
    ) {
      return await handleHistoryModal(interaction, env.DB, ctx);
    }
    return ephemeral("目前不支援這個操作。");
  } catch (error) {
    // Autocomplete only accepts a type 8 reply, so an error reply would be
    // rejected by Discord and surface as a broken picker. Fail closed with an
    // empty list instead, and log it: these used to be swallowed silently.
    const isAutocomplete = interaction.type === 4;
    if (error instanceof ApplicationError) {
      console.warn("Application error", {
        code: error.code,
        interactionType: interaction.type,
        command: interaction.data?.name,
        customId: interaction.data?.custom_id,
      });
      if (isAutocomplete) {
        return autocomplete([]);
      }
      const base = applicationMessages[error.code] ?? "操作失敗，請稍後再試。";
      const lines = [base];
      if (error.code === "MEMBER_NOT_IN_LEDGER" && error.userIds.length > 0) {
        lines.push(
          `未加入：${error.userIds.map((id) => `<@${id}>`).join("、")}`,
        );
      }
      if (error.detail !== undefined) {
        lines.push(error.detail);
      }
      return ephemeral(lines.join("\n"));
    }
    if (error instanceof DomainError) {
      console.warn("Domain error", {
        message: error.message,
        interactionType: interaction.type,
        command: interaction.data?.name,
      });
      if (isAutocomplete) {
        return autocomplete([]);
      }
      return ephemeral("帳務資料不正確，請檢查金額與分攤方式。");
    }
    console.error("Unhandled interaction error", error);
    if (isAutocomplete) {
      return autocomplete([]);
    }
    return ephemeral("系統暫時無法完成操作，請稍後再試。");
  }
}
