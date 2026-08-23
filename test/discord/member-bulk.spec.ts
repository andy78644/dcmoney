import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { routeInteraction } from "../../src/discord/router";

let sequence = 0;

interface Reply {
  data?: {
    content?: string;
    components?: Array<{
      components?: Array<{ custom_id?: string; type?: number; max_values?: number }>;
    }>;
  };
}

async function reply(response: Response): Promise<Reply> {
  return (await response.json()) as Reply;
}

async function fixture() {
  sequence += 1;
  const guildId = `5510${sequence}`;
  const owner = `5520${sequence}`;
  const ledger = await new LedgerService(env.DB).create({
    interactionId: `bulk-${sequence}`,
    guildId,
    actorUserId: owner,
    name: `Bulk ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  return { guildId, owner, ledger };
}

function addCommand(guildId: string, userId: string, ledgerId: string) {
  return {
    id: `bulk-cmd-${++sequence}`,
    type: 2,
    guild_id: guildId,
    member: { user: { id: userId } },
    data: {
      name: "ledger",
      options: [
        {
          name: "member",
          type: 2,
          options: [
            {
              name: "add",
              type: 1,
              options: [{ name: "ledger", type: 3, value: ledgerId }],
            },
          ],
        },
      ],
    },
  } as never;
}

describe("bulk member add", () => {
  it("opens a multi-select when no user is given", async () => {
    const { guildId, owner, ledger } = await fixture();
    const opened = await reply(
      await routeInteraction(addCommand(guildId, owner, ledger.id), env),
    );
    const select = opened.data?.components?.[0]?.components?.[0];
    // 5 = user select, so the whole server is offered — adding people needs that.
    expect(select?.type).toBe(5);
    expect(select?.max_values).toBe(25);
    expect(select?.custom_id).toMatch(/^member_add:/);
  });

  it("adds everyone selected in one go, keeping display names", async () => {
    const { guildId, owner, ledger } = await fixture();
    const opened = await reply(
      await routeInteraction(addCommand(guildId, owner, ledger.id), env),
    );
    const customId = opened.data?.components?.[0]?.components?.[0]?.custom_id;
    const a = `5530${sequence}`;
    const b = `5540${sequence}`;

    const done = await reply(
      await routeInteraction(
        {
          id: `bulk-sel-${++sequence}`,
          type: 3,
          guild_id: guildId,
          member: { user: { id: owner } },
          data: {
            custom_id: customId,
            values: [a, b],
            resolved: {
              users: {
                [a]: { id: a, username: "alpha" },
                [b]: { id: b, username: "beta", global_name: "小貝" },
              },
              members: { [a]: { nick: "阿爾法" } },
            },
          },
        } as never,
        env,
      ),
    );

    expect(done.data?.content).toContain(`<@${a}>`);
    expect(done.data?.content).toContain(`<@${b}>`);

    const members = await new LedgerService(env.DB).listMembers(ledger.id);
    expect(members.map(({ userId }) => userId)).toEqual([owner, a, b]);
    expect(members.find((m) => m.userId === a)?.displayName).toBe("阿爾法");
    expect(members.find((m) => m.userId === b)?.displayName).toBe("小貝");
  });

  it("reports duplicates instead of failing the whole selection", async () => {
    const { guildId, owner, ledger } = await fixture();
    const existing = `5550${sequence}`;
    const fresh = `5560${sequence}`;
    const ledgers = new LedgerService(env.DB);
    await ledgers.addMember({
      interactionId: `bulk-pre-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: existing,
    });

    const result = await ledgers.addMembers({
      interactionId: `bulk-mixed-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      members: [
        { userId: existing },
        { userId: fresh },
        { userId: fresh },
      ],
    });

    expect(result.added).toEqual([fresh]);
    expect(result.alreadyMembers).toEqual([existing]);
  });

  it("refuses a non-owner", async () => {
    const { guildId, owner, ledger } = await fixture();
    const member = `5570${sequence}`;
    const ledgers = new LedgerService(env.DB);
    await ledgers.addMember({
      interactionId: `bulk-nm-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: member,
    });
    await expect(
      ledgers.addMembers({
        interactionId: `bulk-forbidden-${sequence}`,
        ledgerId: ledger.id,
        guildId,
        actorUserId: member,
        members: [{ userId: `5580${sequence}` }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("member list", () => {
  it("lists everyone with display names and marks the owner", async () => {
    const { guildId, owner, ledger } = await fixture();
    const ledgers = new LedgerService(env.DB);
    const friend = `5590${sequence}`;
    await ledgers.addMember({
      interactionId: `list-m-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: friend,
      displayName: "小明",
    });

    const listed = await reply(
      await routeInteraction(
        {
          id: `list-cmd-${++sequence}`,
          type: 2,
          guild_id: guildId,
          member: { user: { id: friend } },
          data: {
            name: "ledger",
            options: [
              {
                name: "member",
                type: 2,
                options: [
                  {
                    name: "list",
                    type: 1,
                    options: [{ name: "ledger", type: 3, value: ledger.id }],
                  },
                ],
              },
            ],
          },
        } as never,
        env,
      ),
    );

    const content = listed.data?.content ?? "";
    expect(content).toContain("共 2 位成員");
    expect(content).toContain(`<@${owner}>`);
    expect(content).toContain("· 建立者");
    expect(content).toContain(`<@${friend}>（小明）`);
  });

  it("refuses someone who is not in the ledger", async () => {
    const { guildId, ledger } = await fixture();
    const outsider = `5595${sequence}`;
    const refused = await reply(
      await routeInteraction(
        {
          id: `list-deny-${++sequence}`,
          type: 2,
          guild_id: guildId,
          member: { user: { id: outsider } },
          data: {
            name: "ledger",
            options: [
              {
                name: "member",
                type: 2,
                options: [
                  {
                    name: "list",
                    type: 1,
                    options: [{ name: "ledger", type: 3, value: ledger.id }],
                  },
                ],
              },
            ],
          },
        } as never,
        env,
      ),
    );
    expect(refused.data?.content).toContain("沒有權限");
  });
});
