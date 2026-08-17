import { LedgerService } from "../application/ledger-service";
import { currencyChoices } from "./command-definitions";
import {
  findFocusedOption,
  getSubcommand,
  requiredString,
  requireActorUserId,
  requireGuildId,
} from "./options";
import { autocomplete, ephemeral } from "./responses";
import type { DiscordInteraction } from "./types";

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
    });
    return ephemeral(
      `已建立帳本「${ledger.name}」，幣別為 ${ledger.currencyCode}。`,
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
  if (focused?.name !== "ledger") {
    return autocomplete([]);
  }
  const query = typeof focused.value === "string" ? focused.value.toLowerCase() : "";
  const ledgers = await new LedgerService(db).listForMember(
    guildId,
    actorUserId,
  );
  return autocomplete(
    ledgers
      .filter((ledger) => ledger.name.toLowerCase().includes(query))
      .map((ledger) => ({ name: ledger.name.slice(0, 100), value: ledger.id })),
  );
}
