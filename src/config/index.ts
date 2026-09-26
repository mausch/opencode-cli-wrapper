import type { AuthContext } from "../lib/opencode/auth.js";
import type { CatalogEntry } from "../lib/opencode/models.js";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

function firstValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function resolveProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const single = firstValue(env, "OPENCODE_PROXY_URL");

  if (single) {
    out.HTTP_PROXY = single;
    out.HTTPS_PROXY = single;
  } else {
    const http = firstValue(env, "HTTP_PROXY", "http_proxy");
    const https = firstValue(env, "HTTPS_PROXY", "https_proxy");
    const all = firstValue(env, "ALL_PROXY", "all_proxy");
    if (http) out.HTTP_PROXY = http;
    if (https) out.HTTPS_PROXY = https;
    if (all) out.ALL_PROXY = all;
  }

  if (!out.HTTP_PROXY && !out.HTTPS_PROXY && !out.ALL_PROXY) return {};

  if ("OPENCODE_NO_PROXY" in env && typeof env.OPENCODE_NO_PROXY === "string") {
    out.NO_PROXY = env.OPENCODE_NO_PROXY;
  } else if ("NO_PROXY" in env && typeof env.NO_PROXY === "string") {
    out.NO_PROXY = env.NO_PROXY;
  } else if ("no_proxy" in env && typeof env.no_proxy === "string") {
    out.NO_PROXY = env.no_proxy;
  } else {
    out.NO_PROXY = LOOPBACK_NO_PROXY;
  }

  return out;
}

export function buildChildEnv(
  configEnv: NodeJS.ProcessEnv = process.env,
  baseEnv: NodeJS.ProcessEnv = configEnv,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...resolveProxyEnv(configEnv) };
}

export function describeProxyEnv(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveProxyEnv(env);
  const mask = (url: string): string => url.replace(/\/\/[^@/]+@/, "//***@");
  return PROXY_KEYS.map((key) => (resolved[key] ? `${key}=${mask(resolved[key])}` : null))
    .filter((value): value is string => value !== null)
    .join(" ");
}

export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ModelNotFoundError.prototype);
  }
}

export function resolveOpencodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPENCODE_BIN;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "opencode";
}

export function getTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_TIMEOUT_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 120_000;
}

export function visibleModels(entries: CatalogEntry[], auth: AuthContext): CatalogEntry[] {
  return auth.enabled ? entries : entries.filter((entry) => entry.id.endsWith("-free"));
}

export function listModels(
  auth: AuthContext,
  entries: CatalogEntry[],
): {
  object: "list";
  data: Array<{ id: string; object: "model"; owned_by: string }>;
} {
  return {
    object: "list",
    data: visibleModels(entries, auth).map((entry) => ({
      id: entry.id,
      object: "model" as const,
      owned_by: entry.provider,
    })),
  };
}

export function resolveModel(id: string, auth: AuthContext, entries: CatalogEntry[]): string {
  const model = visibleModels(entries, auth).find((entry) => entry.canonical === id || entry.id === id);
  if (model) return model.canonical;
  throw new ModelNotFoundError(`Model '${id}' not found in the visible model catalog.`);
}
