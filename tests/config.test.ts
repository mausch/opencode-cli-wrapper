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
  { canonical: "opencode/claude-opus-5", provider: "opencode", id: "claude-opus-5" },
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
        { id: "claude-opus-5", object: "model", owned_by: "opencode" },
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
  it("maps OPENCODE_PROXY_URL to HTTP_PROXY and HTTPS_PROXY with a loopback bypass", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "http://proxy:8080" })).toEqual({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("trims the configured proxy URL", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "  http://proxy:8080  " }).HTTP_PROXY).toBe("http://proxy:8080");
  });

  it("ignores ambient proxy variables and only uses OPENCODE_PROXY_URL", () => {
    const env = { HTTP_PROXY: "http://http:8080", HTTPS_PROXY: "http://https:8080", NO_PROXY: "example.com" };
    expect(resolveProxyEnv(env)).toEqual({});
  });

  it("returns no proxy variables when OPENCODE_PROXY_URL is empty", () => {
    expect(resolveProxyEnv({})).toEqual({});
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "" })).toEqual({});
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "   " })).toEqual({});
  });

  it("masks credentials in describeProxyEnv", () => {
    expect(describeProxyEnv({ OPENCODE_PROXY_URL: "http://user:pass@proxy:8080" })).toBe(
      "HTTP_PROXY=http://***@proxy:8080 HTTPS_PROXY=http://***@proxy:8080 NO_PROXY=localhost,127.0.0.1,::1",
    );
  });

  it("describes nothing when no proxy is configured", () => {
    expect(describeProxyEnv({ HTTP_PROXY: "http://http:8080" })).toBe("");
  });
});

describe("ZEN model preference", () => {
  const dual: CatalogEntry[] = [
    { canonical: "opencode-go/space-bunny-free", provider: "opencode-go", id: "space-bunny-free" },
    { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free" },
    { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free" },
  ];

  it("resolves a short id shared by ZEN and GO to the ZEN provider", () => {
    expect(resolveModel("space-bunny-free", noAuth, dual)).toBe("opencode/space-bunny-free");
  });

  it("still honors an explicit GO canonical id", () => {
    expect(resolveModel("opencode-go/space-bunny-free", noAuth, dual)).toBe("opencode-go/space-bunny-free");
  });

  it("lists a single entry per id, preferring ZEN", () => {
    expect(listModels(noAuth, dual)).toEqual({
      object: "list",
      data: [
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode" },
      ],
    });
  });
});
