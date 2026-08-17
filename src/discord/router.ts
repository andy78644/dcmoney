import { DomainError } from "../domain/errors";
import { ApplicationError } from "../application/errors";
import { handleLedgerAutocomplete, handleLedgerCommand } from "./ledger-handler";
import {
  handleExpenseComponent,
  handleExpenseModal,
  startExpense,
} from "./expense-handler";
import { ephemeral } from "./responses";
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
  NOT_FOUND: "找不到指定的帳本或紀錄。",
  OWNER_CANNOT_BE_REMOVED: "帳本建立者不能被移除。",
  SETTLEMENT_EXCEEDS_BALANCE: "還款方向不符目前建議，或金額超過欠款。",
};

export async function routeInteraction(
  interaction: DiscordInteraction,
  env: Env,
): Promise<Response> {
  try {
    if (interaction.type === 2 && interaction.data?.name === "ledger") {
      return await handleLedgerCommand(interaction, env.DB);
    }
    if (interaction.type === 2 && interaction.data?.name === "expense") {
      return await startExpense(interaction, env.DB);
    }
    if (interaction.type === 4) {
      return await handleLedgerAutocomplete(interaction, env.DB);
    }
    if (
      interaction.type === 3 &&
      interaction.data?.custom_id?.startsWith("expense_") === true
    ) {
      return await handleExpenseComponent(interaction, env.DB);
    }
    if (
      interaction.type === 5 &&
      interaction.data?.custom_id?.startsWith("expense_") === true
    ) {
      return await handleExpenseModal(interaction, env.DB);
    }
    return ephemeral("目前不支援這個操作。");
  } catch (error) {
    if (error instanceof ApplicationError) {
      return ephemeral(applicationMessages[error.code] ?? "操作失敗，請稍後再試。");
    }
    if (error instanceof DomainError) {
      return ephemeral("帳務資料不正確，請檢查金額與分攤方式。");
    }
    console.error("Unhandled interaction error", error);
    return ephemeral("系統暫時無法完成操作，請稍後再試。");
  }
}
