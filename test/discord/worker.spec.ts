import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { handleRequest } from "../../src/index";
import type {
  DiscordEnv,
  DiscordInteraction,
} from "../../src/discord/types";

let privateKey: CryptoKey;
let publicKeyHex: string;

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signedRequest(
  interaction: DiscordInteraction,
): Promise<Request> {
  const timestamp = "1786982400";
  const body = JSON.stringify(interaction);
  const message = new TextEncoder().encode(timestamp + body);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
  return new Request("https://example.com/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": toHex(signature),
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

function discordEnv(): DiscordEnv {
  return { DB: env.DB, DISCORD_PUBLIC_KEY: publicKeyHex };
}

describe("Discord interactions endpoint", () => {
  beforeAll(async () => {
    const keys = (await crypto.subtle.generateKey(
      "Ed25519",
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    privateKey = keys.privateKey;
    publicKeyHex = toHex(await crypto.subtle.exportKey("raw", keys.publicKey));
  });

  it("rejects missing and invalid request signatures", async () => {
    const missing = await handleRequest(
      new Request("https://example.com/interactions", {
        method: "POST",
        body: JSON.stringify({ id: "70000", type: 1 }),
      }),
      discordEnv(),
    );
    expect(missing.status).toBe(401);

    const invalid = await handleRequest(
      new Request("https://example.com/interactions", {
        method: "POST",
        headers: {
          "X-Signature-Ed25519": "00".repeat(64),
          "X-Signature-Timestamp": "1786982400",
        },
        body: JSON.stringify({ id: "70000", type: 1 }),
      }),
      discordEnv(),
    );
    expect(invalid.status).toBe(401);
  });

  it("responds to a correctly signed Discord PING", async () => {
    const response = await handleRequest(
      await signedRequest({ id: "70001", type: 1 }),
      discordEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("creates and lists a ledger through signed slash commands", async () => {
    const create: DiscordInteraction = {
      id: "70002",
      type: 2,
      guild_id: "70010",
      member: { user: { id: "70020" } },
      data: {
        name: "ledger",
        options: [
          {
            name: "create",
            type: 1,
            options: [
              { name: "name", type: 3, value: "東京旅遊" },
              { name: "currency", type: 3, value: "JPY:0" },
            ],
          },
        ],
      },
    };
    const createResponse = await handleRequest(
      await signedRequest(create),
      discordEnv(),
    );
    const createPayload = (await createResponse.json()) as {
      type: number;
      data: { content: string; flags: number };
    };
    expect(createPayload).toMatchObject({
      type: 4,
      data: { flags: 64 },
    });
    expect(createPayload.data.content).toContain("東京旅遊");

    const list: DiscordInteraction = {
      id: "70003",
      type: 2,
      guild_id: "70010",
      member: { user: { id: "70020" } },
      data: {
        name: "ledger",
        options: [{ name: "list", type: 1 }],
      },
    };
    const listResponse = await handleRequest(
      await signedRequest(list),
      discordEnv(),
    );
    const listPayload = (await listResponse.json()) as {
      data: { content: string };
    };
    expect(listPayload.data.content).toContain("東京旅遊 · JPY");
  });
});
