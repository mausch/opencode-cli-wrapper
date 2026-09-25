import { describe, it, expect } from "vitest";
import type { AuthContext } from "../src/lib/opencode/auth.js";
import type { CatalogEntry } from "../src/lib/opencode/models.js";
import {
  getTimeoutMs,
  listModels,
  ModelNotFoundError,
  resolveModel,
  resolveOpencodeBin,
  visibleModels,
} from "../src/config/index.js";

const entries: CatalogEntry[] = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free" },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free" },
  { canonical: "deepseek/deepseek-flash", provider: "deepseek", id: "deepseek-flash" },
];

const noAuth: AuthContext = { enabled: false, token: null };
const withAuth: AuthContext = { enabled: true, token: "key" };

describe("config module", () => {
  it("shows only free ids without auth", () => {
    expect(visibleModels(entries, noAuth)).toEqual(entries.slice(0, 2));
  });

  it("shows every catalog entry with auth", () => {
    expect(visibleModels(entries, withAuth)).toEqual(entries);
  });

  it("lists model ids and providers in catalog order", () => {
    expect(listModels(withAuth, entries)).toEqual({
      object: "list",
      data: [
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode" },
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
        { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
      ],
    });
  });

  it("resolves a visible short id to its canonical id", () => {
    expect(resolveModel("mimo-v2.6-flash-free", noAuth, entries)).toBe("opencode/mimo-v2.6-flash-free");
  });

  it("resolves a visible canonical id", () => {
    expect(resolveModel("opencode/mimo-v2.6-flash-free", noAuth, entries)).toBe("opencode/mimo-v2.6-flash-free");
  });

  it("rejects a model outside the visible catalog", () => {
    expect(() => resolveModel("gpt-4", withAuth, entries)).toThrow(ModelNotFoundError);
  });

  it("rejects every id when the catalog is empty", () => {
    expect(() => resolveModel("mimo-v2.6-flash-free", withAuth, [])).toThrow(ModelNotFoundError);
  });

  it("keeps getTimeoutMs default and fallback behavior", () => {
    expect(getTimeoutMs({})).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "0" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "abc" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "9999" })).toBe(9999);
  });

  it("keeps resolveOpencodeBin default and override behavior", () => {
    expect(resolveOpencodeBin({})).toBe("opencode");
    expect(resolveOpencodeBin({ OPENCODE_BIN: "mybin" })).toBe("mybin");
  });
});
