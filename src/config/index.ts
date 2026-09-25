// PHASE P2 — configuration: binary resolution, free-model allowlist, model resolution.

const BUILTIN_FREE: readonly string[] = [
  "opencode/mimo-v2.6-flash-free",
  "opencode/space-bunny-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode-go/qwen3.8-flash",
  "deepseek/deepseek-flash",
];

export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ModelNotFoundError.prototype);
  }
}

export function getFreeModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.FREE_MODELS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const valid = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry.split("/").length === 2);
    if (valid.length > 0) return valid;
  }
  return [...BUILTIN_FREE];
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

function splitCanonical(canonical: string): { provider: string; id: string } {
  const idx = canonical.indexOf("/");
  return { provider: canonical.slice(0, idx), id: canonical.slice(idx + 1) };
}

export function listModels(env: NodeJS.ProcessEnv = process.env): {
  object: "list";
  data: Array<{ id: string; object: "model"; owned_by: string }>;
} {
  return {
    object: "list",
    data: getFreeModels(env).map((canonical) => {
      const { provider, id } = splitCanonical(canonical);
      return { id, object: "model" as const, owned_by: provider };
    }),
  };
}

export function resolveModel(id: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const canonical of getFreeModels(env)) {
    if (canonical === id) return canonical;
    if (splitCanonical(canonical).id === id) return canonical;
  }
  throw new ModelNotFoundError(`Model '${id}' not found. Only free models are allowed.`);
}
