import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("worker", () => {
  it("exposes a health endpoint", async () => {
    const request = new Request(
      "https://example.com/health",
    ) as Parameters<typeof worker.fetch>[0];
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "dcmoney",
      status: "ok",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const request = new Request(
      "https://example.com/unknown",
    ) as Parameters<typeof worker.fetch>[0];
    const context = createExecutionContext();

    const response = await worker.fetch(request, env, context);
    await waitOnExecutionContext(context);

    expect(response.status).toBe(404);
  });
});
