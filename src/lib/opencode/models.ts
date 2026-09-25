import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { resolveOpencodeBin } from "../../config/index.js";

export interface CatalogEntry {
  readonly canonical: string;
  readonly provider: string;
  readonly id: string;
}

interface CatalogCache {
  readonly entries: CatalogEntry[];
  readonly fetchedAt: number;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MODELS_TIMEOUT_MS = 30_000;

let catalogCache: CatalogCache | null = null;
let refreshPromise: Promise<CatalogEntry[]> | null = null;

export class CatalogError extends Error {
  override name = "CatalogError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, CatalogError.prototype);
  }
}

export function getModelsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_MODELS_TTL_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

export function getModelsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_MODELS_TIMEOUT_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MODELS_TIMEOUT_MS;
}

export function parseModelsOutput(stdout: string): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const line of stdout.split("\n")) {
    const canonical = line.trim();
    const separator = canonical.indexOf("/");
    if (separator <= 0 || separator !== canonical.lastIndexOf("/")) continue;
    const provider = canonical.slice(0, separator);
    const id = canonical.slice(separator + 1);
    if (id.length === 0) continue;
    entries.set(canonical, { canonical, provider, id });
  }
  return [...entries.values()].sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function readCatalog(bin: string, env: NodeJS.ProcessEnv): Promise<CatalogEntry[]> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(new CatalogError("Unable to read model catalog"));
    };
    const child: ChildProcess = spawn(bin, ["models"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.on("error", () => fail());
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      resolve(parseModelsOutput(stdout));
    });
    timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      fail();
    }, getModelsTimeoutMs(env));
  });
}

export async function getCatalog(env: NodeJS.ProcessEnv = process.env): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < getModelsTtlMs(env)) return catalogCache.entries;
  if (!refreshPromise) {
    refreshPromise = readCatalog(resolveOpencodeBin(env), env)
      .then((entries) => {
        catalogCache = { entries, fetchedAt: Date.now() };
        return entries;
      })
      .catch((cause: unknown) => {
        if (catalogCache) return catalogCache.entries;
        if (cause instanceof CatalogError) throw cause;
        throw new CatalogError("Unable to read model catalog");
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export function resetCatalogCache(): void {
  catalogCache = null;
  refreshPromise = null;
}
