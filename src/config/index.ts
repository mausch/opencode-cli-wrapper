import type { AuthContext } from "../lib/opencode/auth.js";
import type { CatalogEntry } from "../lib/opencode/models.js";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const;
const AMBIENT_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const ZEN_PROVIDER = "opencode";
const GO_PROVIDER = "opencode-go";

export function resolveProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const configured = env.OPENCODE_PROXY_URL;
  if (typeof configured !== "string" || configured.trim().length === 0) return {};

  const url = configured.trim();
  return { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: LOOPBACK_NO_PROXY };
}

export function buildChildEnv(
  configEnv: NodeJS.ProcessEnv = process.env,
  baseEnv: NodeJS.ProcessEnv = configEnv,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of AMBIENT_PROXY_KEYS) delete child[key];
  return { ...child, ...resolveProxyEnv(configEnv) };
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

function providerRank(provider: string): number {
  if (provider === ZEN_PROVIDER) return 0;
  if (provider === GO_PROVIDER) return 1;
  return 2;
}

function preferZen(current: CatalogEntry, candidate: CatalogEntry): CatalogEntry {
  return providerRank(candidate.provider) < providerRank(current.provider) ? candidate : current;
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
  const byId = new Map<string, CatalogEntry>();
  for (const entry of visibleModels(entries, auth)) {
    const current = byId.get(entry.id);
    byId.set(entry.id, current ? preferZen(current, entry) : entry);
  }

  return {
    object: "list",
    data: [...byId.values()].map((entry) => ({
      id: entry.id,
      object: "model" as const,
      owned_by: entry.provider,
    })),
  };
}

export function resolveModel(id: string, auth: AuthContext, entries: CatalogEntry[]): string {
  const visible = visibleModels(entries, auth);

  const exact = visible.find((entry) => entry.canonical === id);
  if (exact) return exact.canonical;

  const matches = visible.filter((entry) => entry.id === id);
  if (matches.length > 0) return matches.reduce(preferZen).canonical;

  throw new ModelNotFoundError(`Model '${id}' not found in the visible model catalog.`);
}
