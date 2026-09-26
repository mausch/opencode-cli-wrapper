import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

const catalogFixture = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free" },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free" },
  { canonical: "opencode/deepseek-flash", provider: "opencode", id: "deepseek-flash" },
];

const { getCatalogMock, useRealCatalog } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  useRealCatalog: { value: false },
}));

vi.mock("../src/lib/opencode/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/models.js")>();
  return {
    ...actual,
    getCatalog: (env?: NodeJS.ProcessEnv) =>
      useRealCatalog.value ? actual.getCatalog(env) : getCatalogMock(env),
  };
});

describe("Routes (P6/P7)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    getCatalogMock.mockReset();
    getCatalogMock.mockResolvedValue(catalogFixture);
    app = buildServer();
  });

  afterEach(async () => {
    await app.close();
    useRealCatalog.value = false;
  });

  it("GET /v1/models returns only free ids without Authorization", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode" },
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
      ],
    });
  });

  it("GET /v1/models returns all catalog ids with Authorization", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((model: { id: string }) => model.id)).toEqual(
      catalogFixture.map((model) => model.id),
    );
  });

  it("GET /v1/models maps catalog failure to an OpenAI 500 error", async () => {
    const { CatalogError } = await import("../src/lib/opencode/models.js");
    getCatalogMock.mockRejectedValueOnce(new CatalogError("catalog unavailable"));

    const res = await app.inject({ method: "GET", url: "/v1/models" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
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

  it("rejects a model outside the visible catalog with 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "opencode/deepseek-flash", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
  });

  const itIntegration = process.env.INTEGRATION === "1" ? it : it.skip;

  itIntegration(
    "returns a chat.completion for a free model (non-stream)",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "opencode/mimo-v2.6-flash-free",
          messages: [{ role: "user", content: "Responda apenas: ok" }],
        },
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
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "opencode/mimo-v2.6-flash-free",
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
