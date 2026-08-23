import {
  LedgerService,
  memberLabel,
} from "../application/ledger-service";
import { TransactionService } from "../application/transaction-service";
import { formatMinorAmount } from "../domain/money";
import { currencyChoices } from "./command-definitions";
import {
  findFocusedOption,
  findOptionValue,
  getSubcommand,
  optionalBoolean,
  requiredString,
  requireActorUserId,
  requireGuildId,
  resolvedDisplayName,
  actorDisplayName,
} from "./options";
import { autocomplete, ephemeral } from "./responses";
import type { DiscordInteraction } from "./types";

// 這些欄位的候選項目是帳本成員，不是整個伺服器的人。
// `ledger member add` 的 user 欄位刻意不在此列 —— 加人時本來就要從全伺服器挑。
const MEMBER_OPTION_NAMES = new Set(["payer", "receiver", "member", "user"]);

export async function handleLedgerCommand(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const command = getSubcommand(interaction.data?.options);
  const service = new LedgerService(db);

  if (command.name === "create" && command.group === undefined) {
    const name = requiredString(command.options, "name");
    const currencyValue = requiredString(command.options, "currency");
    const currency = currencyChoices.find(
      ({ value }) => value === currencyValue,
    );
    if (currency === undefined) {
      return ephemeral("不支援這個幣別。");
    }
    const [currencyCode, scaleText] = currency.value.split(":");
    if (currencyCode === undefined || scaleText === undefined) {
      return ephemeral("幣別設定無效。");
    }
    const ledger = await service.create({
      interactionId: interaction.id,
      guildId,
      actorUserId,
      name,
      currencyCode,
      currencyScale: Number(scaleText),
      displayName: actorDisplayName(interaction),
      isPublic: optionalBoolean(command.options, "public"),
    });
    return ephemeral(
      `已建立帳本「${ledger.name}」，幣別為 ${ledger.currencyCode}。${
        ledger.isPublic
          ? "記帳動態會公開到頻道。"
          : "記帳動態只有操作者看得到。"
      }`,
    );
  }

  if (command.name === "list" && command.group === undefined) {
    const ledgers = await service.listForMember(guildId, actorUserId);
    if (ledgers.length === 0) {
      return ephemeral("你目前還沒有可使用的帳本。");
    }
    const lines = ledgers.slice(0, 20).map(
      (ledger, index) =>
        `${index + 1}. ${ledger.name} · ${ledger.currencyCode}${
          ledger.ownerUserId === actorUserId ? " · 建立者" : ""
        }`,
    );
    if (ledgers.length > lines.length) {
      lines.push(`…另有 ${ledgers.length - lines.length} 本帳本`);
    }
    return ephemeral(`你的帳本：\n${lines.join("\n")}`);
  }

  if (command.name === "public" && command.group === undefined) {
    const ledger = await service.setPublic({
      ledgerId: requiredString(command.options, "ledger"),
      guildId,
      actorUserId,
      isPublic: optionalBoolean(command.options, "enabled"),
    });
    return ephemeral(
      ledger.isPublic
        ? `「${ledger.name}」已設為公開：記帳、還款、修改與刪除都會公告到頻道。`
        : `「${ledger.name}」已設為不公開：記帳動態只有操作者看得到。`,
    );
  }

  if (command.group === "member" && ["add", "remove"].includes(command.name)) {
    const ledgerId = requiredString(command.options, "ledger");
    const memberUserId = requiredString(command.options, "user");
    if (command.name === "add") {
      await service.addMember({
        interactionId: interaction.id,
        ledgerId,
        guildId,
        actorUserId,
        memberUserId,
        displayName: resolvedDisplayName(interaction, memberUserId),
      });
      return ephemeral(`已將 <@${memberUserId}> 加入帳本。`);
    }
    await service.removeMember({
      interactionId: interaction.id,
      ledgerId,
      guildId,
      actorUserId,
      memberUserId,
    });
    return ephemeral(`已將 <@${memberUserId}> 移出帳本。`);
  }

  return ephemeral("不支援這個帳本操作。");
}

export async function handleLedgerAutocomplete(
  interaction: DiscordInteraction,
  db: D1Database,
): Promise<Response> {
  const guildId = requireGuildId(interaction);
  const actorUserId = requireActorUserId(interaction);
  const focused = findFocusedOption(interaction.data?.options);
  console.log("autocomplete", {
    command: interaction.data?.name,
    focused: focused?.name ?? null,
    ledgerChosen:
      findOptionValue(interaction.data?.options, "ledger") !== undefined,
  });
  if (focused === undefined) {
    return autocomplete([]);
  }
  const query =
    typeof focused.value === "string" ? focused.value.toLowerCase() : "";
  const service = new LedgerService(db);

  if (focused.name === "ledger") {
    const ledgers = await service.listForMember(guildId, actorUserId);
    return autocomplete(
      ledgers
        .filter((ledger) => ledger.name.toLowerCase().includes(query))
        .map((ledger) => ({
          name: ledger.name.slice(0, 100),
          value: ledger.id,
        })),
    );
  }

  const isSettleAmount =
    interaction.data?.name === "settle" && focused.name === "amount";
  if (!isSettleAmount && !MEMBER_OPTION_NAMES.has(focused.name)) {
    return autocomplete([]);
  }

  // 候選項目都依附於已選定的帳本；還沒選帳本就沒有東西可以提供。
  const ledgerId = findOptionValue(interaction.data?.options, "ledger");
  if (ledgerId === undefined) {
    return autocomplete([]);
  }
  let ledger;
  try {
    ledger = await service.requireMember(ledgerId, guildId, actorUserId);
  } catch {
    return autocomplete([]);
  }

  if (isSettleAmount) {
    const payerUserId = findOptionValue(interaction.data?.options, "payer");
    const receiverUserId = findOptionValue(
      interaction.data?.options,
      "receiver",
    );
    if (payerUserId === undefined || receiverUserId === undefined) {
      return autocomplete([]);
    }
    const suggestions = await new TransactionService(db).getSuggestions({
      ledgerId,
      guildId,
      actorUserId,
    });
    const outstanding = suggestions.find(
      ({ debtorUserId, creditorUserId }) =>
        debtorUserId === payerUserId && creditorUserId === receiverUserId,
    );
    if (outstanding === undefined) {
      return autocomplete([]);
    }
    const full = formatMinorAmount(
      outstanding.amountMinor,
      ledger.currencyScale,
    );
    return autocomplete([
      { name: `全部結清：${ledger.currencyCode} ${full}`, value: full },
    ]);
  }

  const members = await service.listMembers(ledgerId);
  return autocomplete(
    members
      .map((member) => ({
        name: memberLabel(member),
        value: member.userId,
      }))
      .filter(({ name, value }) =>
        name.toLowerCase().includes(query) || value.includes(query),
      ),
  );
}
