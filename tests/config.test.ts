import { describe, it, expect } from "vitest";
import {
  getFreeModels,
  resolveOpencodeBin,
  getTimeoutMs,
  listModels,
  resolveModel,
  ModelNotFoundError,
} from "../src/config/index.js";

describe("config module (P2)", () => {
  it("resolveModel accepts both the short id and the canonical form", () => {
    expect(resolveModel("mimo-v2.6-flash-free")).toBe("opencode/mimo-v2.6-flash-free");
    expect(resolveModel("opencode/mimo-v2.6-flash-free")).toBe("opencode/mimo-v2.6-flash-free");
  });

  it("resolveModel rejects unknown models", () => {
    expect(() => resolveModel("gpt-4")).toThrow(ModelNotFoundError);
    expect(() => resolveModel("unknown/unknown-model")).toThrow(ModelNotFoundError);
  });

  it("resolveModel honors a FREE_MODELS override", () => {
    expect(resolveModel("d", { FREE_MODELS: "a/b, c/d" })).toBe("c/d");
    expect(() => resolveModel("mimo-v2.6-flash-free", { FREE_MODELS: "a/b, c/d" })).toThrow(ModelNotFoundError);
  });

  it("listModels returns an OpenAI-style list with derived id/owned_by", () => {
    const models = listModels();
    expect(models.object).toBe("list");
    expect(models.data.some((m) => m.id === "deepseek-flash" && m.owned_by === "deepseek")).toBe(true);
    expect(models.data.every((m) => m.object === "model")).toBe(true);
  });

  it("getFreeModels honors the env override and trims entries", () => {
    expect(getFreeModels({ FREE_MODELS: "a/b, c/d" })).toEqual(["a/b", "c/d"]);
    expect(getFreeModels({ FREE_MODELS: "  " })).toContain("deepseek/deepseek-flash");
  });

  it("getTimeoutMs applies the default and falls back on invalid values", () => {
    expect(getTimeoutMs({})).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "0" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "abc" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "9999" })).toBe(9999);
  });

  it("resolveOpencodeBin defaults to opencode and respects the override", () => {
    expect(resolveOpencodeBin({})).toBe("opencode");
    expect(resolveOpencodeBin({ OPENCODE_BIN: "mybin" })).toBe("mybin");
  });
});
