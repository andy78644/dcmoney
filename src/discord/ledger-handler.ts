import {
  LedgerService,
  memberLabel,
} from "../application/ledger-service";
import { SessionService } from "../application/session-service";
import { TransactionService } from "../application/transaction-service";
import { formatMinorAmount } from "../domain/money";
import { announce, memberAddedAnnouncement } from "./announce";
import { currencyChoices } from "./command-definitions";
import {
  findFocusedOption,
  findOptionValue,
  getSubcommand,
  optionalBoolean,
  optionalString,
  requiredString,
  requireActorUserId,
  requireGuildId,
  resolvedDisplayName,
  actorDisplayName,
} from "./options";
import { autocomplete, ephemeral, updateMessage } from "./responses";
import type { DiscordInteraction } from "./types";

// 這些欄位的候選項目是帳本成員，不是整個伺服器的人。
// `ledger member add` 的 user 欄位刻意不在此列 —— 加人時本來就要從全伺服器挑。
const MEMBER_OPTION_NAMES = new Set(["payer", "receiver", "member", "user"]);

// Discord 的 user select 一次最多 25 位。
const MAX_BULK_MEMBERS = 25;

export async function handleLedgerCommand(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
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
    const onlyArchived = optionalBoolean(command.options, "archived");
    const ledgers = await service.listForMember(guildId, actorUserId, {
      archived: onlyArchived ? "only" : "exclude",
    });
    if (ledgers.length === 0) {
      return ephemeral(
        onlyArchived
          ? "你沒有已封存的帳本。"
          : "你目前還沒有可使用的帳本。",
      );
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
    return ephemeral(
      `${onlyArchived ? "已封存的帳本" : "你的帳本"}：\n${lines.join("\n")}`,
    );
  }

  if (command.name === "archive" && command.group === undefined) {
    const archived = optionalBoolean(command.options, "enabled");
    const ledger = await service.setArchived({
      ledgerId: requiredString(command.options, "ledger"),
      guildId,
      actorUserId,
      archived,
    });
    return ephemeral(
      archived
        ? `已封存「${ledger.name}」。紀錄都保留著，用 \`/ledger list archived:true\` 可以找回並復原。`
        : `已復原「${ledger.name}」，它會重新出現在帳本清單與選單中。`,
    );
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

  if (command.group === "member" && command.name === "list") {
    const ledgerId = requiredString(command.options, "ledger");
    const ledger = await service.requireMember(ledgerId, guildId, actorUserId);
    const members = await service.listMembers(ledgerId);
    const lines = members.map((member, index) => {
      const isOwner = member.userId === ledger.ownerUserId;
      return `${index + 1}. <@${member.userId}>${
        member.displayName === null ? "" : `（${member.displayName}）`
      }${isOwner ? " · 建立者" : ""}`;
    });
    return ephemeral(
      [
        `「${ledger.name}」共 ${members.length} 位成員${
          ledger.isPublic ? "，記帳動態公開" : ""
        }：`,
        ...lines,
      ].join("\n"),
    );
  }

  if (command.group === "member" && ["add", "remove"].includes(command.name)) {
    const ledgerId = requiredString(command.options, "ledger");
    if (command.name === "add") {
      const single = optionalString(command.options, "user");
      if (single === undefined) {
        // 沒指定人就開多選；成員清單交給 Discord 的 user select。
        const ledger = await service.requireOwner(
          ledgerId,
          guildId,
          actorUserId,
        );
        const session = await new SessionService(db).create({
          guildId,
          userId: actorUserId,
          kind: "member",
          state: { ledgerId, ledgerName: ledger.name },
        });
        return ephemeral(
          `選擇要加入「${ledger.name}」的成員，一次最多 ${MAX_BULK_MEMBERS} 位。`,
          [
            {
              type: 1,
              components: [
                {
                  type: 5,
                  custom_id: `member_add:${session.id}`,
                  placeholder: "選擇成員",
                  min_values: 1,
                  max_values: MAX_BULK_MEMBERS,
                },
              ],
            },
          ],
        );
      }
      const ledger = await service.requireOwner(ledgerId, guildId, actorUserId);
      await service.addMember({
        interactionId: interaction.id,
        ledgerId,
        guildId,
        actorUserId,
        memberUserId: single,
        displayName: resolvedDisplayName(interaction, single),
      });
      announce(
        interaction,
        memberAddedAnnouncement({
          actorUserId,
          ledgerName: ledger.name,
          memberUserIds: [single],
        }),
        ctx,
        [single],
      );
      return ephemeral(`已將 <@${single}> 加入帳本，已在頻道通知對方。`);
    }
    const memberUserId = requiredString(command.options, "user");
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

export async function handleMemberComponent(
  interaction: DiscordInteraction,
  db: D1Database,
  ctx?: ExecutionContext,
): Promise<Response> {
  const sessionId = (interaction.data?.custom_id ?? "").split(":")[1];
  if (sessionId === undefined) {
    return ephemeral("這個成員選單已失效，請重新執行 /ledger member add。");
  }
  const session = await new SessionService(db).require<{
    ledgerId: string;
    ledgerName: string;
  }>({
    id: sessionId,
    guildId: requireGuildId(interaction),
    userId: requireActorUserId(interaction),
    kind: "member",
  });
  const selected = interaction.data?.values ?? [];
  if (selected.length === 0) {
    return updateMessage("沒有選到任何成員。");
  }
  const { added, alreadyMembers } = await new LedgerService(db).addMembers({
    interactionId: interaction.id,
    ledgerId: session.state.ledgerId,
    guildId: session.guildId,
    actorUserId: session.userId,
    members: selected.map((userId) => ({
      userId,
      displayName: resolvedDisplayName(interaction, userId),
    })),
  });
  await new SessionService(db).delete(sessionId);

  if (added.length > 0) {
    announce(
      interaction,
      memberAddedAnnouncement({
        actorUserId: session.userId,
        ledgerName: session.state.ledgerName,
        memberUserIds: added,
      }),
      ctx,
      added,
    );
  }

  const mention = (userId: string) => `<@${userId}>`;
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      `已將 ${added.map(mention).join("、")} 加入「${
        session.state.ledgerName
      }」，已在頻道通知對方。`,
    );
  }
  if (alreadyMembers.length > 0) {
    lines.push(`已在帳本內，略過：${alreadyMembers.map(mention).join("、")}`);
  }
  return updateMessage(lines.join("\n"));
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
    // Restoring an archived ledger means being able to pick one, so the archive
    // subcommand is the one place the picker must show them.
    const isArchiveCommand =
      interaction.data?.name === "ledger" &&
      (interaction.data?.options ?? []).some(
        (option) => option.name === "archive",
      );
    const ledgers = await service.listForMember(guildId, actorUserId, {
      archived: isArchiveCommand ? "include" : "exclude",
    });
    return autocomplete(
      ledgers
        .filter((ledger) => ledger.name.toLowerCase().includes(query))
        .map((ledger) => ({
          name: `${ledger.name}${ledger.archivedAt === null ? "" : "（已封存）"}`
            .slice(0, 100),
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
    // Suggest what this pair owes. The payer's overall debt would be the wrong
    // number to hand one receiver.
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
      return autocomplete([]);
    }
    const full = formatMinorAmount(suggested.amountMinor, ledger.currencyScale);
    return autocomplete([
      { name: `依建議結清：${ledger.currencyCode} ${full}`, value: full },
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
