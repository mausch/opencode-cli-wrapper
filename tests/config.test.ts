import { describe, it, expect } from "vitest";
import type { AuthContext } from "../src/lib/opencode/auth.js";
import type { CatalogEntry } from "../src/lib/opencode/models.js";
import {
  getTimeoutMs,
  listModels,
  ModelNotFoundError,
  describeProxyEnv,
  resolveModel,
  resolveOpencodeBin,
  resolveProxyEnv,
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

describe("resolveProxyEnv", () => {
  it("expands OPENCODE_PROXY_URL to HTTP_PROXY and HTTPS_PROXY only", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "http://proxy:8080", ALL_PROXY: "http://all:8080" })).toEqual({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("normalizes lowercase scheme-specific proxy variables", () => {
    expect(resolveProxyEnv({ http_proxy: "http://http:8080", https_proxy: "http://https:8080" })).toEqual({
      HTTP_PROXY: "http://http:8080",
      HTTPS_PROXY: "http://https:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("uses ALL_PROXY when no scheme-specific proxy is configured", () => {
    expect(resolveProxyEnv({ all_proxy: "http://all:8080" })).toEqual({
      ALL_PROXY: "http://all:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("defaults NO_PROXY to loopback when a proxy is configured", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "http://proxy:8080" }).NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });

  it("returns no proxy variables when none is configured", () => {
    expect(resolveProxyEnv({})).toEqual({});
    expect(resolveProxyEnv({ NO_PROXY: "example.com" })).toEqual({});
  });

  it("respects an explicitly empty NO_PROXY when a proxy is configured", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "http://proxy:8080", NO_PROXY: "" })).toEqual({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "",
    });
  });

  it("gives OPENCODE_NO_PROXY precedence over NO_PROXY", () => {
    const env = { OPENCODE_PROXY_URL: "http://proxy:8080", OPENCODE_NO_PROXY: "internal", NO_PROXY: "other" };
    expect(resolveProxyEnv(env).NO_PROXY).toBe("internal");
  });

  it("masks credentials in describeProxyEnv", () => {
    expect(describeProxyEnv({ OPENCODE_PROXY_URL: "http://user:pass@proxy:8080" })).toBe(
      "HTTP_PROXY=http://***@proxy:8080 HTTPS_PROXY=http://***@proxy:8080 NO_PROXY=localhost,127.0.0.1,::1",
    );
  });
});
