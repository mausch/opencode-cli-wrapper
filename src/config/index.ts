import type { AuthContext } from "../lib/opencode/auth.js";
import type { CatalogEntry } from "../lib/opencode/models.js";

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
