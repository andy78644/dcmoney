import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from "discord-interactions";

import { routeInteraction } from "./discord/router";
import type {
  DiscordEnv,
  DiscordInteraction,
} from "./discord/types";

export async function handleRequest(
  request: Request,
  env: DiscordEnv,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ service: "dcmoney", status: "ok" });
  }

  if (request.method === "POST" && url.pathname === "/interactions") {
    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    if (signature === null || timestamp === null) {
      return new Response("Bad request signature", { status: 401 });
    }

    const rawBody = await request.text();
    const isValid = await verifyKey(
      rawBody,
      signature,
      timestamp,
      env.DISCORD_PUBLIC_KEY,
    );
    if (!isValid) {
      return new Response("Bad request signature", { status: 401 });
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody) as DiscordInteraction;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (interaction.type === InteractionType.PING) {
      return Response.json({ type: InteractionResponseType.PONG });
    }
    return routeInteraction(interaction, env, ctx);
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env, context): Promise<Response> {
    return handleRequest(request, env, context);
  },
} satisfies ExportedHandler<DiscordEnv>;
