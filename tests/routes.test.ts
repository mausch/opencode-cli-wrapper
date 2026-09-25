import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

describe("Routes (P6/P7)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /v1/models returns an OpenAI list", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ object: "list" });
    expect(res.json().data.length).toBeGreaterThan(0);
  });

  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects a body without messages with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "mimo-v2.6-flash-free" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("rejects an unknown model with 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("opencode_error");
  });

  const itIntegration = process.env.INTEGRATION === "1" ? it : it.skip;

  itIntegration(
    "returns a chat.completion for a free model (non-stream)",
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "deepseek/deepseek-flash", messages: [{ role: "user", content: "Responda apenas: ok" }] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
      expect(body.usage.total_tokens).toBeGreaterThan(0);
    },
    120_000,
  );

  itIntegration(
    "streams SSE ending with [DONE]",
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "deepseek/deepseek-flash",
          messages: [{ role: "user", content: "Responda apenas: ok" }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
    },
    120_000,
  );
});
