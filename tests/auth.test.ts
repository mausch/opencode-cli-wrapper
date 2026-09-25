import { describe, expect, it } from "vitest";
import { extractAuth } from "../src/lib/opencode/auth.js";

describe("extractAuth", () => {
  it("disables auth when the header is undefined", () => {
    expect(extractAuth(undefined)).toEqual({ enabled: false, token: null });
  });

  it("disables auth when the header is empty", () => {
    expect(extractAuth("")).toEqual({ enabled: false, token: null });
  });

  it("disables auth when the header contains only whitespace", () => {
    expect(extractAuth("   ")).toEqual({ enabled: false, token: null });
  });

  it("strips the Bearer prefix", () => {
    expect(extractAuth("Bearer abc")).toEqual({ enabled: true, token: "abc" });
  });

  it("strips a case-insensitive Bearer prefix and trims the token", () => {
    expect(extractAuth("bearer   x ")).toEqual({ enabled: true, token: "x" });
  });

  it("preserves non-Bearer authorization schemes", () => {
    expect(extractAuth("Token z")).toEqual({ enabled: true, token: "Token z" });
  });

  it("uses only the first header value", () => {
    expect(extractAuth(["Bearer a", "Bearer b"])).toEqual({ enabled: true, token: "a" });
  });

  it("enables auth but has no token for a Bearer prefix without credentials", () => {
    expect(extractAuth("Bearer")).toEqual({ enabled: true, token: null });
  });
});
